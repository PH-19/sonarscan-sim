import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: node scripts/generate_sensor_failure_report.mjs <benchmark-output-dir|runs.jsonl> [report-dir]');
  process.exit(2);
}

const inputPath = path.resolve(process.cwd(), inputArg);
const inputStats = statSync(inputPath);
const benchmarkOutputDir = inputStats.isDirectory() ? inputPath : path.dirname(inputPath);
const runsPath = inputStats.isDirectory() ? path.join(inputPath, 'runs.jsonl') : inputPath;
const samplesPath = path.join(benchmarkOutputDir, 'samples.jsonl');
const manifestPath = path.join(benchmarkOutputDir, 'manifest.json');
const reportDir = path.resolve(
  process.cwd(),
  process.argv[3] ?? path.join('experiments', 'sensor_failure_robustness', 'report')
);
const chartsDir = path.join(reportDir, 'charts');

mkdirSync(chartsDir, { recursive: true });

const rows = readFileSync(runsPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

if (rows.length === 0) {
  throw new Error(`No benchmark rows found in ${runsPath}`);
}
if (rows.some(row => row.outputLabel !== 'synthetic-uncalibrated')) {
  throw new Error('Sensor failure report only accepts synthetic-uncalibrated benchmark rows');
}

const samples = existsSync(samplesPath)
  ? readFileSync(samplesPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [];
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : null;

const metrics = [
  { key: 'strictTrackAccuracy', label: 'Tracking Accuracy', better: 'higher', format: value => formatNumber(value, 3) },
  { key: 'avgAoISec', label: 'Average AoI (s)', better: 'lower', format: value => formatNumber(value, 2) },
  { key: 'avgScanRateHz', label: 'Avg Swimmer Scanned Rate (Hz)', better: 'higher', format: value => formatNumber(value, 3) },
];

const preferredStrategyOrder = [
  'FULL_SCAN',
  'ROUND_ROBIN_SECTOR',
  'ROUND_ROBIN_ROI',
  'NEAREST_ROI',
  'BELIEF_PSO_V2',
  'BELIEF_PSO_V3',
];
const strategyColors = new Map([
  ['FULL_SCAN', '#2563eb'],
  ['ROUND_ROBIN_SECTOR', '#f97316'],
  ['ROUND_ROBIN_ROI', '#16a34a'],
  ['NEAREST_ROI', '#92400e'],
  ['BELIEF_PSO_V2', '#111827'],
  ['BELIEF_PSO_V3', '#111827'],
]);

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const std = values => {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};
const finite = value => Number.isFinite(value);
function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}
const csvCell = value => {
  if (value === undefined || value === null) return '';
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const writeCsv = (filePath, header, records) => {
  const lines = [
    header.join(','),
    ...records.map(record => header.map(key => csvCell(record[key])).join(',')),
  ];
  writeFileSync(filePath, `${lines.join('\n')}\n`);
};
const escapeXml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const scenarioLabel = scenario => ({
  sensor_failure_control: 'Control',
  sensor_failure_single_transient: 'Single sonar outage',
  sensor_failure_segment_transient: 'Two-sonar segment outage',
})[scenario] ?? scenario;
const preferredScenarioOrder = [
  'sensor_failure_control',
  'sensor_failure_single_transient',
  'sensor_failure_segment_transient',
];
const scenarioRank = scenario => {
  const index = preferredScenarioOrder.indexOf(scenario);
  return index >= 0 ? index : preferredScenarioOrder.length;
};
const strategyRank = strategy => {
  const index = preferredStrategyOrder.indexOf(strategy);
  return index >= 0 ? index : preferredStrategyOrder.length + strategy.localeCompare('');
};
const metricValue = (row, metric) => {
  const evalMetrics = row.aggregateMetrics ?? row.finalMetrics ?? {};
  if (finite(evalMetrics[metric])) return evalMetrics[metric];
  const commandMetrics = row.commandMetrics ?? {};
  if (finite(commandMetrics[metric])) return commandMetrics[metric];
  return Number.NaN;
};

const groupBy = (items, keyOf) => {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const current = groups.get(key) ?? [];
    current.push(item);
    groups.set(key, current);
  }
  return groups;
};

const aggregateGroups = groupBy(rows, row => `${row.scenario}|${row.strategy}`);
const aggregateRows = [...aggregateGroups.entries()].map(([key, groupRows]) => {
  const [scenario, strategy] = key.split('|');
  const result = {
    scenario,
    scenarioLabel: scenarioLabel(scenario),
    strategy,
    runCount: groupRows.length,
    seeds: [...new Set(groupRows.map(row => row.seed))].sort((a, b) => a - b),
    metrics: {},
  };
  for (const metric of metrics) {
    const values = groupRows.map(row => metricValue(row, metric.key)).filter(finite);
    const s = std(values);
    result.metrics[metric.key] = {
      mean: mean(values),
      std: s,
      ci95: values.length > 1 ? 1.96 * s / Math.sqrt(values.length) : 0,
    };
  }
  return result;
}).sort((a, b) =>
  scenarioRank(a.scenario) - scenarioRank(b.scenario)
  || a.scenario.localeCompare(b.scenario)
  || strategyRank(a.strategy) - strategyRank(b.strategy)
  || a.strategy.localeCompare(b.strategy)
);

const sampleStateByRun = new Map();
const phaseBuckets = new Map();
const failureScheduleByRun = new Map();
for (const sample of samples) {
  const runKey = `${sample.scenario}|${sample.strategy}|${sample.seed}`;
  const offlineIds = (sample.strategySnapshot?.sonars ?? [])
    .filter(sonar => sonar.available === false)
    .map(sonar => sonar.id)
    .sort();
  const state = sampleStateByRun.get(runKey) ?? {
    hasSeenOffline: false,
    firstOfflineTime: null,
    firstRecoveredTime: null,
    maxOfflineCount: 0,
    offlineIds: new Set(),
  };
  if (offlineIds.length > 0) {
    state.hasSeenOffline = true;
    state.firstOfflineTime ??= sample.simTime;
    state.maxOfflineCount = Math.max(state.maxOfflineCount, offlineIds.length);
    for (const id of offlineIds) state.offlineIds.add(id);
  } else if (state.hasSeenOffline && state.firstRecoveredTime === null) {
    state.firstRecoveredTime = sample.simTime;
  }
  sampleStateByRun.set(runKey, state);
  failureScheduleByRun.set(runKey, state);

  if (sample.warmup) continue;
  const phase = sample.scenario === 'sensor_failure_control'
    ? 'overall'
    : offlineIds.length > 0
      ? 'failure'
      : state.hasSeenOffline
        ? 'recovery'
        : 'preFailure';
  const phaseKey = `${sample.scenario}|${sample.strategy}|${phase}`;
  const bucket = phaseBuckets.get(phaseKey) ?? {
    scenario: sample.scenario,
    scenarioLabel: scenarioLabel(sample.scenario),
    strategy: sample.strategy,
    phase,
    samples: 0,
    values: Object.fromEntries(metrics.map(metric => [metric.key, []])),
  };
  bucket.samples += 1;
  for (const metric of metrics) {
    const value = sample.metrics?.[metric.key];
    if (finite(value)) bucket.values[metric.key].push(value);
  }
  phaseBuckets.set(phaseKey, bucket);
}

const phaseRows = [...phaseBuckets.values()].map(bucket => ({
  scenario: bucket.scenario,
  scenarioLabel: bucket.scenarioLabel,
  strategy: bucket.strategy,
  phase: bucket.phase,
  samples: bucket.samples,
  metrics: Object.fromEntries(metrics.map(metric => [
    metric.key,
    {
      mean: mean(bucket.values[metric.key]),
      std: std(bucket.values[metric.key]),
    },
  ])),
})).sort((a, b) =>
  scenarioRank(a.scenario) - scenarioRank(b.scenario)
  || a.scenario.localeCompare(b.scenario)
  || strategyRank(a.strategy) - strategyRank(b.strategy)
  || a.phase.localeCompare(b.phase)
);

const phaseLookup = new Map(phaseRows.map(row => [`${row.scenario}|${row.strategy}|${row.phase}`, row]));
const degradationRows = [];
for (const row of phaseRows) {
  if (row.phase !== 'failure') continue;
  const pre = phaseLookup.get(`${row.scenario}|${row.strategy}|preFailure`);
  if (!pre) continue;
  const record = {
    scenario: row.scenario,
    scenarioLabel: row.scenarioLabel,
    strategy: row.strategy,
    phase: 'failureMinusPreFailure',
    metrics: {},
  };
  for (const metric of metrics) {
    record.metrics[metric.key] = {
      delta: row.metrics[metric.key].mean - pre.metrics[metric.key].mean,
      failureMean: row.metrics[metric.key].mean,
      preFailureMean: pre.metrics[metric.key].mean,
    };
  }
  degradationRows.push(record);
}

const controlByStrategySeed = new Map(rows
  .filter(row => row.scenario === 'sensor_failure_control')
  .map(row => [`${row.strategy}|${row.seed}`, row]));
const controlAdjustedBySeed = rows
  .filter(row => row.scenario !== 'sensor_failure_control')
  .map(row => {
    const control = controlByStrategySeed.get(`${row.strategy}|${row.seed}`);
    if (!control) return null;
    return {
      scenario: row.scenario,
      scenarioLabel: scenarioLabel(row.scenario),
      strategy: row.strategy,
      seed: row.seed,
      metrics: Object.fromEntries(metrics.map(metric => {
        const scenarioValue = metricValue(row, metric.key);
        const controlValue = metricValue(control, metric.key);
        return [metric.key, {
          delta: scenarioValue - controlValue,
          scenarioValue,
          controlValue,
        }];
      })),
    };
  })
  .filter(Boolean);
const controlAdjustedGroups = groupBy(controlAdjustedBySeed, row => `${row.scenario}|${row.strategy}`);
const controlAdjustedRows = [...controlAdjustedGroups.values()].map(groupRows => {
  const first = groupRows[0];
  return {
    scenario: first.scenario,
    scenarioLabel: first.scenarioLabel,
    strategy: first.strategy,
    seeds: groupRows.map(row => row.seed).sort((a, b) => a - b),
    metrics: Object.fromEntries(metrics.map(metric => {
      const values = groupRows.map(row => row.metrics[metric.key].delta).filter(finite);
      const s = std(values);
      return [metric.key, {
        meanDelta: mean(values),
        std: s,
        ci95: values.length > 1 ? 1.96 * s / Math.sqrt(values.length) : 0,
      }];
    })),
  };
}).sort((a, b) =>
  scenarioRank(a.scenario) - scenarioRank(b.scenario)
  || a.scenario.localeCompare(b.scenario)
  || strategyRank(a.strategy) - strategyRank(b.strategy)
);

const failureScheduleRows = [...failureScheduleByRun.entries()].map(([key, state]) => {
  const [scenario, strategy, seed] = key.split('|');
  return {
    scenario,
    scenarioLabel: scenarioLabel(scenario),
    strategy,
    seed,
    firstOfflineTimeSec: state.firstOfflineTime ?? '',
    firstRecoveredTimeSec: state.firstRecoveredTime ?? '',
    maxOfflineCount: state.maxOfflineCount,
    offlineSonarIds: [...state.offlineIds].sort().join(' '),
  };
}).sort((a, b) =>
  scenarioRank(a.scenario) - scenarioRank(b.scenario)
  || a.scenario.localeCompare(b.scenario)
  || Number(a.seed) - Number(b.seed)
  || strategyRank(a.strategy) - strategyRank(b.strategy)
);
const formatOptionalSec = value => value === '' ? 'n/a' : formatNumber(Number(value), 1);

const aggregateCsvRows = [];
for (const row of aggregateRows) {
  for (const metric of metrics) {
    aggregateCsvRows.push({
      scenario: row.scenario,
      scenarioLabel: row.scenarioLabel,
      strategy: row.strategy,
      runCount: row.runCount,
      seeds: row.seeds.join(' '),
      metric: metric.key,
      metricLabel: metric.label,
      mean: row.metrics[metric.key].mean,
      std: row.metrics[metric.key].std,
      ci95: row.metrics[metric.key].ci95,
    });
  }
}
const phaseCsvRows = [];
for (const row of phaseRows) {
  for (const metric of metrics) {
    phaseCsvRows.push({
      scenario: row.scenario,
      scenarioLabel: row.scenarioLabel,
      strategy: row.strategy,
      phase: row.phase,
      samples: row.samples,
      metric: metric.key,
      metricLabel: metric.label,
      mean: row.metrics[metric.key].mean,
      std: row.metrics[metric.key].std,
    });
  }
}
const degradationCsvRows = [];
for (const row of degradationRows) {
  for (const metric of metrics) {
    degradationCsvRows.push({
      scenario: row.scenario,
      scenarioLabel: row.scenarioLabel,
      strategy: row.strategy,
      phase: row.phase,
      metric: metric.key,
      metricLabel: metric.label,
      delta: row.metrics[metric.key].delta,
      failureMean: row.metrics[metric.key].failureMean,
      preFailureMean: row.metrics[metric.key].preFailureMean,
    });
  }
}
const controlAdjustedCsvRows = [];
for (const row of controlAdjustedRows) {
  for (const metric of metrics) {
    controlAdjustedCsvRows.push({
      scenario: row.scenario,
      scenarioLabel: row.scenarioLabel,
      strategy: row.strategy,
      seeds: row.seeds.join(' '),
      metric: metric.key,
      metricLabel: metric.label,
      meanDeltaVsControl: row.metrics[metric.key].meanDelta,
      std: row.metrics[metric.key].std,
      ci95: row.metrics[metric.key].ci95,
    });
  }
}

const aggregateCsvPath = path.join(reportDir, 'metrics_by_scenario.csv');
const phaseCsvPath = path.join(reportDir, 'metrics_by_phase.csv');
const degradationCsvPath = path.join(reportDir, 'degradation_by_phase.csv');
const controlAdjustedCsvPath = path.join(reportDir, 'control_adjusted_metrics.csv');
const scheduleCsvPath = path.join(reportDir, 'failure_schedule_by_run.csv');
writeCsv(aggregateCsvPath, ['scenario', 'scenarioLabel', 'strategy', 'runCount', 'seeds', 'metric', 'metricLabel', 'mean', 'std', 'ci95'], aggregateCsvRows);
writeCsv(phaseCsvPath, ['scenario', 'scenarioLabel', 'strategy', 'phase', 'samples', 'metric', 'metricLabel', 'mean', 'std'], phaseCsvRows);
writeCsv(degradationCsvPath, ['scenario', 'scenarioLabel', 'strategy', 'phase', 'metric', 'metricLabel', 'delta', 'failureMean', 'preFailureMean'], degradationCsvRows);
writeCsv(controlAdjustedCsvPath, ['scenario', 'scenarioLabel', 'strategy', 'seeds', 'metric', 'metricLabel', 'meanDeltaVsControl', 'std', 'ci95'], controlAdjustedCsvRows);
writeCsv(scheduleCsvPath, ['scenario', 'scenarioLabel', 'strategy', 'seed', 'firstOfflineTimeSec', 'firstRecoveredTimeSec', 'maxOfflineCount', 'offlineSonarIds'], failureScheduleRows);

const scenarios = [...new Set(aggregateRows.map(row => row.scenario))]
  .sort((a, b) => scenarioRank(a) - scenarioRank(b) || a.localeCompare(b));
const strategies = [...new Set(aggregateRows.map(row => row.strategy))]
  .sort((a, b) => strategyRank(a) - strategyRank(b) || a.localeCompare(b));

const barChart = ({ fileName, title, metric, dataRows, valueOf, yLabel, zeroLine = false }) => {
  const width = 1180;
  const height = 420;
  const margin = { top: 44, right: 22, bottom: 102, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const groups = scenarios.filter(scenario => dataRows.some(row => row.scenario === scenario));
  const values = dataRows.map(valueOf).filter(finite);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const padding = Math.max(1e-6, (rawMax - rawMin) * 0.12);
  const yMin = zeroLine ? rawMin - padding : 0;
  const yMax = rawMax + padding || 1;
  const y = value => margin.top + plotHeight - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * plotHeight;
  const groupWidth = plotWidth / Math.max(1, groups.length);
  const barGap = 3;
  const barWidth = Math.max(5, (groupWidth - 36) / Math.max(1, strategies.length) - barGap);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="white"/>',
    '<style>text{font-family:Arial,sans-serif;fill:#111827}.title{font-size:18px;font-weight:700}.axis{stroke:#6b7280;stroke-width:1}.grid{stroke:#e5e7eb;stroke-width:1}.label{font-size:11px}.legend{font-size:11px}</style>',
    `<text class="title" x="${margin.left}" y="26">${escapeXml(title)}</text>`,
  ];
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = yMin + (yMax - yMin) * tick / 4;
    const yy = y(value);
    svg.push(
      `<line class="grid" x1="${margin.left}" y1="${yy}" x2="${margin.left + plotWidth}" y2="${yy}"/>`,
      `<text class="label" text-anchor="end" x="${margin.left - 8}" y="${yy + 4}">${formatNumber(value, Math.abs(value) >= 10 ? 1 : 2)}</text>`
    );
  }
  if (zeroLine) {
    svg.push(`<line x1="${margin.left}" y1="${y(0)}" x2="${margin.left + plotWidth}" y2="${y(0)}" stroke="#111827" stroke-width="1.2"/>`);
  }
  svg.push(
    `<line class="axis" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}"/>`,
    `<line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}"/>`,
    `<text class="label" text-anchor="middle" transform="translate(18,${margin.top + plotHeight / 2}) rotate(-90)">${escapeXml(yLabel)}</text>`
  );
  for (const [groupIndex, scenario] of groups.entries()) {
    const baseX = margin.left + groupIndex * groupWidth + 18;
    svg.push(`<text class="label" text-anchor="middle" x="${baseX + groupWidth / 2 - 18}" y="${height - 66}">${escapeXml(scenarioLabel(scenario))}</text>`);
    for (const [strategyIndex, strategy] of strategies.entries()) {
      const row = dataRows.find(item => item.scenario === scenario && item.strategy === strategy);
      if (!row) continue;
      const value = valueOf(row);
      if (!finite(value)) continue;
      const x = baseX + strategyIndex * (barWidth + barGap);
      const baselineY = y(0);
      const barY = Math.min(y(value), baselineY);
      const barH = Math.max(1, Math.abs(y(value) - baselineY));
      svg.push(
        `<rect x="${x}" y="${barY}" width="${barWidth}" height="${barH}" fill="${strategyColors.get(strategy) ?? '#6b7280'}">` +
        `<title>${escapeXml(`${scenarioLabel(scenario)} / ${strategy}: ${metric.format(value)}`)}</title></rect>`
      );
    }
  }
  const legendY = height - 42;
  strategies.forEach((strategy, index) => {
    const x = margin.left + (index % 4) * 260;
    const yLegend = legendY + Math.floor(index / 4) * 19;
    svg.push(`<rect x="${x}" y="${yLegend - 9}" width="10" height="10" fill="${strategyColors.get(strategy) ?? '#6b7280'}"/><text class="legend" x="${x + 16}" y="${yLegend}">${escapeXml(strategy)}</text>`);
  });
  svg.push('</svg>');
  const filePath = path.join(chartsDir, fileName);
  writeFileSync(filePath, `${svg.join('\n')}\n`);
  return path.relative(reportDir, filePath);
};

const chartPaths = {};
for (const metric of metrics) {
  chartPaths[`aggregate_${metric.key}`] = barChart({
    fileName: `aggregate_${metric.key}.svg`,
    title: `${metric.label} by Strategy and Scenario`,
    metric,
    dataRows: aggregateRows,
    valueOf: row => row.metrics[metric.key].mean,
    yLabel: metric.label,
  });
  chartPaths[`delta_${metric.key}`] = barChart({
    fileName: `failure_delta_${metric.key}.svg`,
    title: `Failure phase minus pre-failure: ${metric.label}`,
    metric,
    dataRows: degradationRows,
    valueOf: row => row.metrics[metric.key].delta,
    yLabel: `Delta ${metric.label}`,
    zeroLine: true,
  });
}

const bestByScenarioMetric = [];
for (const scenario of scenarios) {
  for (const metric of metrics) {
    const candidates = aggregateRows.filter(row => row.scenario === scenario && finite(row.metrics[metric.key].mean));
    const sorted = [...candidates].sort((a, b) => {
      const av = a.metrics[metric.key].mean;
      const bv = b.metrics[metric.key].mean;
      return metric.better === 'lower' ? av - bv : bv - av;
    });
    if (sorted[0]) {
      bestByScenarioMetric.push({
        scenario,
        metric: metric.key,
        metricLabel: metric.label,
        bestStrategy: sorted[0].strategy,
        bestValue: sorted[0].metrics[metric.key].mean,
      });
    }
  }
}

const summary = {
  outputLabel: 'synthetic-uncalibrated',
  generatedAt: new Date().toISOString(),
  source: {
    benchmarkOutputDir,
    runsPath,
    samplesPath,
    manifestPath: existsSync(manifestPath) ? manifestPath : null,
  },
  config: manifest?.config ?? null,
  metrics,
  aggregateRows,
  phaseRows,
  degradationRows,
  controlAdjustedRows,
  failureScheduleRows,
  bestByScenarioMetric,
  chartPaths,
};
const summaryPath = path.join(reportDir, 'summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

const metricTableHeader = '| Scenario | Strategy | Tracking Accuracy | Average AoI (s) | Avg Swimmer Scanned Rate (Hz) |';
const metricTableSep = '| --- | --- | ---: | ---: | ---: |';
const metricTableRows = aggregateRows.map(row => (
  `| ${row.scenarioLabel} | ${row.strategy} | ${formatNumber(row.metrics.strictTrackAccuracy.mean, 3)} | ${formatNumber(row.metrics.avgAoISec.mean, 2)} | ${formatNumber(row.metrics.avgScanRateHz.mean, 3)} |`
));

const deltaTableRows = degradationRows.map(row => (
  `| ${row.scenarioLabel} | ${row.strategy} | ${formatNumber(row.metrics.strictTrackAccuracy.delta, 3)} | ${formatNumber(row.metrics.avgAoISec.delta, 2)} | ${formatNumber(row.metrics.avgScanRateHz.delta, 3)} |`
));
const controlAdjustedTableRows = controlAdjustedRows.map(row => (
  `| ${row.scenarioLabel} | ${row.strategy} | ${formatNumber(row.metrics.strictTrackAccuracy.meanDelta, 3)} | ${formatNumber(row.metrics.avgAoISec.meanDelta, 2)} | ${formatNumber(row.metrics.avgScanRateHz.meanDelta, 3)} |`
));

const failureScheduleCompact = [...groupBy(failureScheduleRows, row => `${row.scenario}|${row.seed}`).values()]
  .map(group => group[0])
  .map(row => `| ${row.scenarioLabel} | ${row.seed} | ${row.offlineSonarIds || 'none'} | ${formatOptionalSec(row.firstOfflineTimeSec)} | ${formatOptionalSec(row.firstRecoveredTimeSec)} | ${row.maxOfflineCount} |`);

const reportLines = [
  '# Sensor Failure Robustness Quick Report',
  '',
  '## Scope',
  '',
  'This is a quick representative run, not the full statistical robustness sweep. It uses the same baseline set as the end-to-end baseline comparison and focuses on three primary metrics:',
  '',
  '- `strictTrackAccuracy` = Tracking Accuracy; higher is better.',
  '- `avgAoISec` = Average AoI; lower is better.',
  '- `avgScanRateHz` = Avg Swimmer Scanned Rate; higher is better.',
  '',
  'For each seed, the control and failure scenarios use the same swimmer workload; only the sonar availability events differ.',
  '',
  '## Run Metadata',
  '',
  '| Field | Value |',
  '| --- | --- |',
  `| Generated at | ${summary.generatedAt} |`,
  `| Git commit | ${manifest?.simulatorState?.gitCommit ?? 'unknown'} |`,
  `| Git dirty | ${manifest?.simulatorState?.gitDirty ?? 'unknown'} |`,
  `| Config | ${manifest?.config?.configPath ?? 'unknown'} |`,
  `| Runs | ${runsPath} |`,
  `| Samples | ${existsSync(samplesPath) ? samplesPath : 'missing'} |`,
  `| Run count | ${rows.length} |`,
  '',
  '## Failure Schedule',
  '',
  '| Scenario | Seed | Offline sonar IDs | First offline (s) | First recovered (s) | Max offline count |',
  '| --- | ---: | --- | ---: | ---: | ---: |',
  ...failureScheduleCompact,
  '',
  '## Aggregate Results',
  '',
  metricTableHeader,
  metricTableSep,
  ...metricTableRows,
  '',
  '## Control-Adjusted Results',
  '',
  'Each value is failure-scenario aggregate metric minus the same-seed control aggregate metric. For Tracking Accuracy and Avg Scanned Rate, negative is worse. For Average AoI, positive is worse.',
  '',
  '| Scenario | Strategy | Delta Tracking Accuracy vs Control | Delta Average AoI vs Control (s) | Delta Avg Scanned Rate vs Control (Hz) |',
  '| --- | --- | ---: | ---: | ---: |',
  ...controlAdjustedTableRows,
  '',
  '## Failure-Phase Delta',
  '',
  'Delta is computed as failure-phase mean minus pre-failure mean from `samples.jsonl`. For Tracking Accuracy and Avg Scanned Rate, negative is worse. For Average AoI, positive is worse.',
  '',
  '| Scenario | Strategy | Delta Tracking Accuracy | Delta Average AoI (s) | Delta Avg Scanned Rate (Hz) |',
  '| --- | --- | ---: | ---: | ---: |',
  ...deltaTableRows,
  '',
  '## Charts',
  '',
  '### Aggregate Metrics',
  '',
  `![Tracking Accuracy](${chartPaths.aggregate_strictTrackAccuracy})`,
  '',
  `![Average AoI](${chartPaths.aggregate_avgAoISec})`,
  '',
  `![Avg Swimmer Scanned Rate](${chartPaths.aggregate_avgScanRateHz})`,
  '',
  '### Failure-Phase Deltas',
  '',
  `![Tracking Accuracy Delta](${chartPaths.delta_strictTrackAccuracy})`,
  '',
  `![Average AoI Delta](${chartPaths.delta_avgAoISec})`,
  '',
  `![Avg Swimmer Scanned Rate Delta](${chartPaths.delta_avgScanRateHz})`,
  '',
  '## Output Files',
  '',
  `- Summary JSON: ${summaryPath}`,
  `- Aggregate CSV: ${aggregateCsvPath}`,
  `- Phase CSV: ${phaseCsvPath}`,
  `- Degradation CSV: ${degradationCsvPath}`,
  `- Control-adjusted CSV: ${controlAdjustedCsvPath}`,
  `- Failure schedule CSV: ${scheduleCsvPath}`,
  '',
];
const reportPath = path.join(reportDir, 'sensor_failure_robustness_quick_report.md');
writeFileSync(reportPath, `${reportLines.join('\n')}\n`);

console.log(reportPath);
