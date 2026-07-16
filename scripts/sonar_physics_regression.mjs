import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const cwd = process.cwd().replaceAll('\\\\', '/');
const modulePath = (relativePath) => JSON.stringify(`${cwd}/${relativePath}`);

const args = process.argv.slice(2);
let writeReport = true;
let reportDir = path.join(cwd, 'experiments/sonar_physics_regression/report');

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--check') {
    writeReport = false;
  } else if (arg === '--report-dir') {
    const value = args[index + 1];
    if (!value) throw new Error('--report-dir requires a directory path');
    reportDir = path.resolve(cwd, value);
    index += 1;
  } else if (arg === '--help' || arg === '-h') {
    console.log([
      'Usage: node scripts/sonar_physics_regression.mjs [--check] [--report-dir <dir>]',
      '',
      'Runs strategy-free SonarTimingModel physics regression checks.',
      '--check       Validate only; do not write report artifacts.',
      '--report-dir  Directory for summary.json, duration_sweep.csv, and Markdown report.',
    ].join('\n'));
    process.exit(0);
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

const physicsContract = {
  soundSpeed: 1500,
  slewSpeedDegPerSec: 45,
  defaultAngularStepDeg: 0.9,
  processingOverheadSec: 0.002,
  scanStepOverheadSec: 0.005,
  receiveGuardFactor: 1.1,
  samplePeriodSec: 0.000005,
};

const testEntry = `
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SonarTimingModel, defaultSonarTimingConfig } from ${modulePath('services/sim/sonar/SonarTimingModel.ts')};

const PHYSICS_CONTRACT = ${JSON.stringify(physicsContract, null, 2)};
const WRITE_REPORT = ${JSON.stringify(writeReport)};
const REPORT_DIR = ${JSON.stringify(reportDir.replaceAll('\\\\', '/'))};

const timing = new SonarTimingModel();
const rows = [];
const checks = [];

function round(value, digits = 9) {
  return Number(value.toFixed(digits));
}

function assertClose(actual, expected, label, tolerance = 1e-9) {
  const absError = Math.abs(actual - expected);
  const allowed = Math.max(tolerance, Math.abs(expected) * 1e-10);
  assert.ok(
    absError <= allowed,
    label + ' expected ' + expected + ', got ' + actual + ', abs error ' + absError
  );
}

function passCheck(name, details) {
  checks.push({ name, result: 'pass', details });
}

function angularStep(angularStepDeg) {
  return Math.max(0.1, angularStepDeg || PHYSICS_CONTRACT.defaultAngularStepDeg);
}

function windowBeamCount(window, angularStepDeg) {
  const width = Math.abs(window.endLocalAngle - window.scanStartLocalAngle);
  return Math.max(1, Math.floor(width / angularStep(angularStepDeg)) + 1);
}

function expectedBeamIntervalSec(range, angularStepDeg, samplesPerBeam, pingSlotCount) {
  const acousticRoundTrip = (2 * range) / PHYSICS_CONTRACT.soundSpeed;
  const sampling = Math.max(
    acousticRoundTrip,
    Math.max(1, samplesPerBeam) * PHYSICS_CONTRACT.samplePeriodSec
  );
  const motorStep = PHYSICS_CONTRACT.scanStepOverheadSec
    * Math.max(0.1, angularStepDeg)
    / Math.max(0.1, PHYSICS_CONTRACT.defaultAngularStepDeg);
  return sampling * PHYSICS_CONTRACT.receiveGuardFactor * Math.max(1, pingSlotCount)
    + PHYSICS_CONTRACT.processingOverheadSec
    + motorStep;
}

function slewBetweenLocalAngles(from, to) {
  const slewDeg = Math.abs(to - from);
  if (slewDeg < 0.5) return 0;
  return slewDeg / PHYSICS_CONTRACT.slewSpeedDegPerSec;
}

function scanWindows(command) {
  if (command.scanWindows && command.scanWindows.length > 0) return command.scanWindows;
  return [{
    scanStartLocalAngle: command.scanStartLocalAngle,
    endLocalAngle: command.endLocalAngle,
    scanMinLocalAngle: command.scanMinLocalAngle,
    scanMaxLocalAngle: command.scanMaxLocalAngle,
    range: command.range,
    assignedTargetIds: command.assignedTargetIds,
  }];
}

function expectedBeamCount(command) {
  return scanWindows(command).reduce(function(sum, window) {
    return sum + windowBeamCount(window, command.angularStepDeg);
  }, 0);
}

function expectedEffectiveSamplePeriodSec(range, samplesPerBeam) {
  return Math.max(
    PHYSICS_CONTRACT.samplePeriodSec,
    (2 * range) / (PHYSICS_CONTRACT.soundSpeed * Math.max(1, samplesPerBeam))
  );
}

function expectedDurationSec(command) {
  const windows = scanWindows(command);
  if (windows.length === 0) return 0;

  let duration = slewBetweenLocalAngles(command.startLocalAngle, windows[0].scanStartLocalAngle);
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    duration += windowBeamCount(window, command.angularStepDeg)
      * expectedBeamIntervalSec(window.range, command.angularStepDeg, command.samplesPerBeam, command.pingSlotCount);
    const next = windows[index + 1];
    if (next) duration += slewBetweenLocalAngles(window.endLocalAngle, next.scanStartLocalAngle);
  }
  return duration;
}

function initialSlewSec(command) {
  const windows = scanWindows(command);
  if (windows.length === 0) return 0;
  return slewBetweenLocalAngles(command.startLocalAngle, windows[0].scanStartLocalAngle);
}

function gapSlewSec(command) {
  const windows = scanWindows(command);
  let total = 0;
  for (let index = 0; index < windows.length - 1; index += 1) {
    total += slewBetweenLocalAngles(windows[index].endLocalAngle, windows[index + 1].scanStartLocalAngle);
  }
  return total;
}

function scanWidthDeg(command) {
  return scanWindows(command).reduce(function(sum, window) {
    return sum + Math.abs(window.endLocalAngle - window.scanStartLocalAngle);
  }, 0);
}

function baseCommand(patch = {}) {
  const scanStartLocalAngle = patch.scanStartLocalAngle ?? 0;
  const endLocalAngle = patch.endLocalAngle ?? 90;
  return {
    commandId: patch.commandId ?? 'cmd',
    sonarId: patch.sonarId ?? 'S1',
    startLocalAngle: patch.startLocalAngle ?? scanStartLocalAngle,
    scanStartLocalAngle,
    endLocalAngle,
    scanMinLocalAngle: patch.scanMinLocalAngle ?? Math.min(scanStartLocalAngle, endLocalAngle),
    scanMaxLocalAngle: patch.scanMaxLocalAngle ?? Math.max(scanStartLocalAngle, endLocalAngle),
    range: patch.range ?? 20,
    angularStepDeg: patch.angularStepDeg ?? PHYSICS_CONTRACT.defaultAngularStepDeg,
    samplesPerBeam: patch.samplesPerBeam ?? 256,
    pingSlotCount: patch.pingSlotCount ?? 1,
    startTime: patch.startTime ?? 0,
    assignedTargetIds: patch.assignedTargetIds ?? [],
    scanWindows: patch.scanWindows,
  };
}

function recordCase(category, caseId, command, notes) {
  const actualDuration = timing.durationSec(command);
  const expectedDuration = expectedDurationSec(command);
  assertClose(actualDuration, expectedDuration, caseId + ' durationSec');

  const actualBeamCount = timing.beamCount(command);
  const expectedBeams = expectedBeamCount(command);
  assert.equal(actualBeamCount, expectedBeams, caseId + ' beam count');

  const actualBeamInterval = timing.beamIntervalSec(command);
  const expectedBeamInterval = expectedBeamIntervalSec(
    command.range,
    command.angularStepDeg,
    command.samplesPerBeam,
    command.pingSlotCount
  );
  assertClose(actualBeamInterval, expectedBeamInterval, caseId + ' top-level beamIntervalSec');

  const actualEffectiveSamplePeriod = timing.effectiveSamplePeriodSec(command);
  const expectedEffectiveSamplePeriod = expectedEffectiveSamplePeriodSec(command.range, command.samplesPerBeam);
  assertClose(
    actualEffectiveSamplePeriod,
    expectedEffectiveSamplePeriod,
    caseId + ' effectiveSamplePeriodSec'
  );

  const row = {
    category,
    caseId,
    rangeM: command.range,
    scanWidthDeg: round(scanWidthDeg(command), 6),
    angularStepDeg: command.angularStepDeg,
    samplesPerBeam: command.samplesPerBeam,
    pingSlotCount: command.pingSlotCount,
    scanWindowCount: scanWindows(command).length,
    beamCount: actualBeamCount,
    beamIntervalSec: round(actualBeamInterval, 12),
    effectiveSamplePeriodSec: round(actualEffectiveSamplePeriod, 12),
    initialSlewSec: round(initialSlewSec(command), 9),
    gapSlewSec: round(gapSlewSec(command), 9),
    durationSec: round(actualDuration, 9),
    expectedDurationSec: round(expectedDuration, 9),
    absErrorSec: round(Math.abs(actualDuration - expectedDuration), 12),
    notes,
  };
  rows.push(row);
  return row;
}

function assertStrictlyIncreasing(caseRows, label) {
  for (let index = 1; index < caseRows.length; index += 1) {
    assert.ok(
      caseRows[index].durationSec > caseRows[index - 1].durationSec,
      label + ' should be strictly increasing between ' + caseRows[index - 1].caseId + ' and ' + caseRows[index].caseId
    );
  }
  passCheck(label, caseRows.map(function(row) {
    return row.caseId + '=' + row.durationSec + 's';
  }).join('; '));
}

function configSummary() {
  return Object.entries(PHYSICS_CONTRACT).map(function(entry) {
    return entry[0] + '=' + entry[1];
  }).join(', ');
}

for (const entry of Object.entries(PHYSICS_CONTRACT)) {
  const key = entry[0];
  const expected = entry[1];
  assert.equal(
    defaultSonarTimingConfig[key],
    expected,
    'default timing config ' + key + ' changed; update sonar_physics_regression only for intentional physical recalibration'
  );
}
passCheck('default SonarTimingModel constants match the current physics contract', configSummary());

const rangeRows = [1, 5, 20, 50].map(function(range) {
  return recordCase(
    'range_sweep',
    'range_' + range + 'm_180deg',
    baseCommand({
      commandId: 'range-' + range + 'm',
      range,
      endLocalAngle: 180,
      scanMaxLocalAngle: 180,
    }),
    'Fixed 180deg sector; range changes acoustic round-trip receive time.'
  );
});
assertStrictlyIncreasing(rangeRows, 'larger scan range increases 180deg command duration');

const angleRows = [30, 90, 180, 360].map(function(widthDeg) {
  return recordCase(
    'angle_width_sweep',
    'width_' + widthDeg + 'deg_20m',
    baseCommand({
      commandId: 'width-' + widthDeg + 'deg',
      range: 20,
      endLocalAngle: widthDeg,
      scanMaxLocalAngle: widthDeg,
    }),
    'Fixed 20m range; wider sector emits more beams.'
  );
});
assertStrictlyIncreasing(angleRows, 'larger angular sector increases command duration');

const stepRows = [1.8, 0.9, 0.45].map(function(stepDeg) {
  return recordCase(
    'angular_resolution_sweep',
    'step_' + stepDeg + 'deg_180deg',
    baseCommand({
      commandId: 'step-' + stepDeg + 'deg',
      range: 20,
      angularStepDeg: stepDeg,
      endLocalAngle: 180,
      scanMaxLocalAngle: 180,
    }),
    'Fixed 180deg sector; finer angular step emits more beams.'
  );
});
assert.ok(
  stepRows[0].durationSec < stepRows[1].durationSec && stepRows[1].durationSec < stepRows[2].durationSec,
  'finer angular resolution should increase duration'
);
passCheck('finer angular resolution increases command duration', stepRows.map(function(row) {
  return row.caseId + '=' + row.durationSec + 's';
}).join('; '));

const slot1 = recordCase(
  'tdma_slot_sweep',
  'slots_1_90deg_20m',
  baseCommand({ commandId: 'slots-1', range: 20, endLocalAngle: 90, pingSlotCount: 1 }),
  'No TDMA slot multiplication.'
);
const slot4 = recordCase(
  'tdma_slot_sweep',
  'slots_4_90deg_20m',
  baseCommand({ commandId: 'slots-4', range: 20, endLocalAngle: 90, pingSlotCount: 4 }),
  'Four TDMA slots multiply acoustic listen time only.'
);
assert.ok(
  slot4.durationSec > slot1.durationSec && slot4.durationSec / slot1.durationSec < 4,
  'TDMA should expand acoustic listen time without multiplying local motor/processing overhead'
);
passCheck('TDMA pingSlotCount multiplies acoustic listen time only', '1 slot=' + slot1.durationSec + 's; 4 slots=' + slot4.durationSec + 's');

const noSlew = recordCase(
  'slew_reposition',
  'sector_90deg_no_initial_slew',
  baseCommand({
    commandId: 'no-initial-slew',
    startLocalAngle: 90,
    scanStartLocalAngle: 90,
    endLocalAngle: 180,
    scanMinLocalAngle: 90,
    scanMaxLocalAngle: 180,
    range: 20,
  }),
  'Mechanical head already at sector start.'
);
const withSlew = recordCase(
  'slew_reposition',
  'sector_90deg_with_90deg_initial_slew',
  baseCommand({
    commandId: 'with-initial-slew',
    startLocalAngle: 0,
    scanStartLocalAngle: 90,
    endLocalAngle: 180,
    scanMinLocalAngle: 90,
    scanMaxLocalAngle: 180,
    range: 20,
  }),
  'Adds a 90deg non-emitting mechanical slew before scanning.'
);
assertClose(
  withSlew.durationSec - noSlew.durationSec,
  90 / PHYSICS_CONTRACT.slewSpeedDegPerSec,
  'initial slew adds only mechanical reposition time'
);
passCheck('initial mechanical slew is modeled separately from scan emission', 'extra=' + round(withSlew.durationSec - noSlew.durationSec, 9) + 's');

const jumpScanCommand = baseCommand({
  commandId: 'jump-scan-regression',
  startLocalAngle: 0,
  scanStartLocalAngle: 0,
  endLocalAngle: 180,
  scanMinLocalAngle: 0,
  scanMaxLocalAngle: 180,
  range: 20,
  scanWindows: [
    { scanStartLocalAngle: 0, endLocalAngle: 30, scanMinLocalAngle: 0, scanMaxLocalAngle: 30, range: 20, assignedTargetIds: [] },
    { scanStartLocalAngle: 90, endLocalAngle: 120, scanMinLocalAngle: 90, scanMaxLocalAngle: 120, range: 5, assignedTargetIds: ['T_MID'] },
    { scanStartLocalAngle: 150, endLocalAngle: 180, scanMinLocalAngle: 150, scanMaxLocalAngle: 180, range: 50, assignedTargetIds: [] },
  ],
});
const jumpRow = recordCase(
  'multi_window_jump_scan',
  'jump_windows_20m_5m_50m',
  jumpScanCommand,
  'Three emitting windows with per-window ranges and non-emitting mechanical gaps.'
);
const continuousWide = recordCase(
  'multi_window_jump_scan',
  'continuous_180deg_50m',
  baseCommand({
    commandId: 'continuous-180-50m',
    range: 50,
    endLocalAngle: 180,
    scanMaxLocalAngle: 180,
  }),
  'Continuous wide scan baseline at the longest range.'
);
assert.ok(
  jumpRow.durationSec < continuousWide.durationSec,
  'jump scan should skip empty angular gaps and finish faster than continuous 180deg/50m scan'
);
const jumpWindowCounts = scanWindows(jumpScanCommand).map(function(window) {
  return windowBeamCount(window, jumpScanCommand.angularStepDeg);
});
assert.equal(timing.beamRange(jumpScanCommand, 0), 20, 'first jump-scan window should use 20m range');
assert.equal(timing.beamRange(jumpScanCommand, jumpWindowCounts[0]), 5, 'second jump-scan window should use 5m range');
assert.equal(timing.beamRange(jumpScanCommand, jumpWindowCounts[0] + jumpWindowCounts[1]), 50, 'third jump-scan window should use 50m range');
passCheck('multi-window commands use per-window range and non-emitting gap slew', 'jump=' + jumpRow.durationSec + 's; continuous=' + continuousWide.durationSec + 's');

const spec1m = recordCase(
  'ping360_spec_window',
  'ping360_1m_360deg',
  baseCommand({
    commandId: 'ping360-1m-360deg',
    range: 1,
    endLocalAngle: 360,
    scanMaxLocalAngle: 360,
  }),
  'Public Ping360 timing envelope: about 3.4s for 1m / 360deg.'
);
assert.ok(spec1m.durationSec >= 3.2 && spec1m.durationSec <= 3.7, '1m / 360deg timing should stay in Ping360 calibration window');
passCheck('1m / 360deg timing stays in Ping360 calibration window', spec1m.durationSec + 's');

const spec50m = recordCase(
  'ping360_spec_window',
  'ping360_50m_360deg',
  baseCommand({
    commandId: 'ping360-50m-360deg',
    range: 50,
    endLocalAngle: 360,
    scanMaxLocalAngle: 360,
  }),
  'Public Ping360 timing envelope: about 32s for 50m / 360deg.'
);
assert.ok(spec50m.durationSec >= 31 && spec50m.durationSec <= 34, '50m / 360deg timing should stay in Ping360 calibration window');
passCheck('50m / 360deg timing stays in Ping360 calibration window', spec50m.durationSec + 's');

const sampleFloor = recordCase(
  'sample_period_floor',
  'effective_sample_floor_0p5m',
  baseCommand({
    commandId: 'sample-floor-0p5m',
    range: 0.5,
    endLocalAngle: 10,
    scanMaxLocalAngle: 10,
  }),
  'Very short range remains bounded by hardware sample period.'
);
assertClose(sampleFloor.effectiveSamplePeriodSec, PHYSICS_CONTRACT.samplePeriodSec, 'short-range effective sample period floor');
const acousticDominated = recordCase(
  'sample_period_floor',
  'effective_sample_acoustic_5m',
  baseCommand({
    commandId: 'sample-acoustic-5m',
    range: 5,
    endLocalAngle: 10,
    scanMaxLocalAngle: 10,
  }),
  'Longer range is dominated by acoustic round-trip per sample.'
);
assert.ok(
  acousticDominated.effectiveSamplePeriodSec > PHYSICS_CONTRACT.samplePeriodSec,
  'longer range should exceed the hardware sample-period floor'
);
passCheck('effective sample period switches from hardware floor to acoustic round-trip', '0.5m=' + sampleFloor.effectiveSamplePeriodSec + 's; 5m=' + acousticDominated.effectiveSamplePeriodSec + 's');

function csvEscape(value) {
  const text = String(value);
  if (/[",\\n]/.test(text)) return '"' + text.replaceAll('"', '""') + '"';
  return text;
}

function toCsv(dataRows) {
  const headers = [
    'category',
    'caseId',
    'rangeM',
    'scanWidthDeg',
    'angularStepDeg',
    'samplesPerBeam',
    'pingSlotCount',
    'scanWindowCount',
    'beamCount',
    'beamIntervalSec',
    'effectiveSamplePeriodSec',
    'initialSlewSec',
    'gapSlewSec',
    'durationSec',
    'expectedDurationSec',
    'absErrorSec',
    'notes',
  ];
  const lines = [headers.join(',')];
  for (const row of dataRows) {
    lines.push(headers.map(function(header) {
      return csvEscape(row[header]);
    }).join(','));
  }
  return lines.join('\\n') + '\\n';
}

function markdownReport() {
  const contractLabels = new Map([
    ['soundSpeed', '声速'],
    ['slewSpeedDegPerSec', '机械空转速度'],
    ['defaultAngularStepDeg', '默认角步进'],
    ['processingOverheadSec', '每 beam 处理开销'],
    ['scanStepOverheadSec', '每默认步进的电机/通信开销'],
    ['receiveGuardFactor', '接收保护系数'],
    ['samplePeriodSec', '硬件采样周期'],
  ]);
  const checkLabels = new Map([
    ['default SonarTimingModel constants match the current physics contract', '默认 SonarTimingModel 常量符合当前物理合约'],
    ['larger scan range increases 180deg command duration', '扫描量程增大时，180deg command 耗时递增'],
    ['larger angular sector increases command duration', '扫描角度范围增大时，command 耗时递增'],
    ['finer angular resolution increases command duration', '角分辨率更细时，command 耗时递增'],
    ['TDMA pingSlotCount multiplies acoustic listen time only', 'TDMA pingSlotCount 只按 slot 数放大声学收听时间'],
    ['initial mechanical slew is modeled separately from scan emission', '初始机械空转时间与发射扫描时间分开建模'],
    ['multi-window commands use per-window range and non-emitting gap slew', 'multi-window command 保留每个窗口的独立量程和非发射 gap slew'],
    ['1m / 360deg timing stays in Ping360 calibration window', '1m / 360deg 耗时位于 Ping360 标定窗口内'],
    ['50m / 360deg timing stays in Ping360 calibration window', '50m / 360deg 耗时位于 Ping360 标定窗口内'],
    ['effective sample period switches from hardware floor to acoustic round-trip', '有效采样周期会从硬件下限切换到声学往返主导'],
  ]);
  const contractLines = Object.entries(PHYSICS_CONTRACT).map(function(entry) {
    return '- ' + (contractLabels.get(entry[0]) ?? entry[0]) + ' (' + entry[0] + '): ' + entry[1];
  });
  const checkLines = checks.map(function(check) {
    const result = check.result === 'pass' ? '通过' : check.result;
    return '| ' + (checkLabels.get(check.name) ?? check.name) + ' | ' + result + ' | ' + check.details + ' |';
  });
  const selectedRows = rows.filter(function(row) {
    return row.category === 'range_sweep'
      || row.category === 'angle_width_sweep'
      || row.category === 'ping360_spec_window'
      || row.category === 'multi_window_jump_scan';
  });
  const caseLines = selectedRows.map(function(row) {
    return '| ' + row.caseId
      + ' | ' + row.rangeM
      + ' | ' + row.scanWidthDeg
      + ' | ' + row.beamCount
      + ' | ' + row.durationSec
      + ' | ' + row.expectedDurationSec
      + ' |';
  });
  return [
    '# Sonar 物理模型回归报告',
    '',
    '状态：通过',
    '',
    '这个实验不经过任何策略层，直接调用 SonarTimingModel，并用当前物理合约重新计算期望耗时。它的目的，是防止某些策略或 benchmark 改动意外破坏 sonar 物理模型，导致后续 evaluation 不再可比。',
    '',
    '## 公式合约',
    '',
    '- 每个发射窗口的 beam_count = floor(abs(endLocalAngle - scanStartLocalAngle) / angularStepDeg) + 1。',
    '- beam_interval = max(2 * range / soundSpeed, samplesPerBeam * samplePeriodSec) * receiveGuardFactor * tdmaSlotCount + processingOverheadSec + scanStepOverheadSec * angularStepDeg / defaultAngularStepDeg。',
    '- command 总耗时 = initial_slew + sum(window_beam_count * window_beam_interval) + gap_slew_between_scan_windows。',
    '',
    '## 物理常量',
    '',
    ...contractLines,
    '',
    '## 检查结果',
    '',
    '| 检查项 | 结果 | 关键数值 |',
    '|---|---:|---|',
    ...checkLines,
    '',
    '## 关键耗时样例',
    '',
    '| Case | 量程 (m) | 发射角宽 (deg) | Beams | 模型耗时 (s) | 公式重算耗时 (s) |',
    '|---|---:|---:|---:|---:|---:|',
    ...caseLines,
    '',
    '完整机器可读结果见 summary.json；表格化 case 见 duration_sweep.csv。',
    '',
  ].join('\\n');
}

if (WRITE_REPORT) {
  await mkdir(REPORT_DIR, { recursive: true });
  const summary = {
    status: 'pass',
    contract: PHYSICS_CONTRACT,
    caseCount: rows.length,
    checkCount: checks.length,
    checks,
    cases: rows,
  };
  await writeFile(path.join(REPORT_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\\n');
  await writeFile(path.join(REPORT_DIR, 'duration_sweep.csv'), toCsv(rows));
  await writeFile(path.join(REPORT_DIR, 'sonar_physics_regression_report.md'), markdownReport());
}

console.log(
  'sonar physics regression passed: ' + rows.length + ' cases, ' + checks.length + ' checks'
  + (WRITE_REPORT ? '; report=' + REPORT_DIR : '')
);
`;

const tempDir = await mkdtemp(path.join(tmpdir(), 'sonarscan-physics-regression-'));
const entryPath = path.join(tempDir, 'entry.mjs');
const outfile = path.join(tempDir, 'bundle.mjs');
await writeFile(entryPath, testEntry);
await build({
  entryPoints: [entryPath],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
await import(pathToFileURL(outfile).href);
