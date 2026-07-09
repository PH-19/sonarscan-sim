import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: node scripts/generate_e2e_population_report.mjs <benchmark-output-dir|runs.jsonl> [report-dir]');
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
  process.argv[3] ?? path.join('experiments', 'e2e_population_sweep', 'report')
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

const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : null;

const coreMetrics = [
  { key: 'f1', label: 'F1', better: 'higher', family: 'detection' },
  { key: 'recall', label: 'Recall', better: 'higher', family: 'detection' },
  { key: 'precision', label: 'Precision', better: 'higher', family: 'detection' },
  { key: 'avgAoISec', label: 'Scan Interval (s)', better: 'lower', family: 'scan interval' },
  { key: 'p90AoISec', label: 'P90 AoI (s)', better: 'lower', family: 'scan interval' },
  { key: 'trackingRate', label: 'Tracking Rate', better: 'higher', family: 'tracking' },
  { key: 'strictTrackAccuracy', label: 'Strict Tracking Accuracy', better: 'higher', family: 'tracking' },
  { key: 'localTrackAccuracy', label: 'Tracking Accuracy', better: 'higher', family: 'tracking' },
  { key: 'trackContinuity', label: 'Identity Continuity', better: 'higher', family: 'tracking' },
  { key: 'trackingRMSEm', label: 'Tracking RMSE (m)', better: 'lower', family: 'tracking' },
  { key: 'gospa', label: 'GOSPA', better: 'lower', family: 'tracking' },
  { key: 'avgScanRateHz', label: 'Scanned Rate (Hz)', better: 'higher', family: 'scanning' },
  { key: 'sonarBusyRatio', label: 'Sonar Workload', better: 'lower', family: 'system' },
  { key: 'searchCoverageRatio', label: 'Search Coverage', better: 'higher', family: 'system' },
  { key: 'beamRateHz', label: 'Beam Rate (Hz)', better: 'context-dependent', family: 'system' },
  { key: 'decisionLatencyP95Ms', label: 'Planner Latency (P95 ms)', better: 'lower', family: 'system' },
];

const inputStrategies = new Set(rows.map(row => row.strategy));
const candidateStrategy = inputStrategies.has('BELIEF_PSO_V3') ? 'BELIEF_PSO_V3' : 'BELIEF_PSO_V2';
const ablationStrategy = inputStrategies.has('BELIEF_PSO_V3_NO_PSO') ? 'BELIEF_PSO_V3_NO_PSO' : 'BELIEF_PSO_NO_PSO';
const focusMetricKeys = [
  'localTrackAccuracy',
  'avgAoISec',
  'avgScanRateHz',
  'trackContinuity',
  'sonarBusyRatio',
  'searchCoverageRatio',
  'decisionLatencyP95Ms',
];

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const std = values => {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};

const metricValue = (row, key) => {
  const evalMetrics = row.aggregateMetrics ?? row.finalMetrics ?? {};
  if (Number.isFinite(evalMetrics[key])) return evalMetrics[key];
  const commandMetrics = row.commandMetrics ?? {};
  if (Number.isFinite(commandMetrics[key])) return commandMetrics[key];
  return Number.NaN;
};

const scenarioLabel = row => row.movementModel ?? row.scenario;
const countValue = row => row.swimmerCount ?? row.finalTruthCount;
const groupKey = row => [
  scenarioLabel(row),
  countValue(row),
  row.strategy,
  row.sensorProfile,
].join('|');

const groups = new Map();
for (const row of rows) {
  const key = groupKey(row);
  const current = groups.get(key) ?? {
    movementModel: scenarioLabel(row),
    swimmerCount: countValue(row),
    restingSwimmerCount: row.restingSwimmerCount ?? 0,
    strategy: row.strategy,
    sensorProfile: row.sensorProfile,
    seeds: [],
    rows: [],
  };
  current.seeds.push(row.seed);
  current.rows.push(row);
  groups.set(key, current);
}

const summaryRows = [...groups.values()]
  .map(group => {
    const metrics = {};
    for (const metric of coreMetrics) {
      const values = group.rows.map(row => metricValue(row, metric.key)).filter(Number.isFinite);
      const s = std(values);
      metrics[metric.key] = {
        mean: mean(values),
        std: s,
        ci95: values.length > 1 ? 1.96 * s / Math.sqrt(values.length) : 0,
        min: values.length ? Math.min(...values) : Number.NaN,
        max: values.length ? Math.max(...values) : Number.NaN,
      };
    }
    return {
      movementModel: group.movementModel,
      swimmerCount: group.swimmerCount,
      restingSwimmerCount: group.restingSwimmerCount,
      strategy: group.strategy,
      sensorProfile: group.sensorProfile,
      runCount: group.rows.length,
      seeds: [...new Set(group.seeds)].sort((a, b) => a - b),
      metrics,
    };
  })
  .sort((a, b) =>
    a.movementModel.localeCompare(b.movementModel)
    || a.swimmerCount - b.swimmerCount
    || a.strategy.localeCompare(b.strategy)
  );

const pairedEffects = [];
const pairDims = new Map();
for (const row of rows) {
  const key = [scenarioLabel(row), countValue(row), row.sensorProfile].join('|');
  if (!pairDims.has(key)) {
    pairDims.set(key, {
      movementModel: scenarioLabel(row),
      swimmerCount: countValue(row),
      sensorProfile: row.sensorProfile,
    });
  }
}
for (const dims of pairDims.values()) {
  const sameDims = row =>
    scenarioLabel(row) === dims.movementModel
    && countValue(row) === dims.swimmerCount
    && row.sensorProfile === dims.sensorProfile;
  const candidateRows = rows.filter(row => sameDims(row) && row.strategy === candidateStrategy);
  if (candidateRows.length === 0) continue;
  const candidateBySeed = new Map(candidateRows.map(row => [row.seed, row]));
  const baselines = [...new Set(rows
    .filter(row => sameDims(row) && row.strategy !== candidateStrategy)
    .map(row => row.strategy))];
  for (const baselineStrategy of baselines) {
    const baselineBySeed = new Map(rows
      .filter(row => sameDims(row) && row.strategy === baselineStrategy)
      .map(row => [row.seed, row]));
    const pairedSeeds = [...candidateBySeed.keys()]
      .filter(seed => baselineBySeed.has(seed))
      .sort((a, b) => a - b);
    for (const metric of coreMetrics) {
      const differences = pairedSeeds
        .map(seed => metricValue(candidateBySeed.get(seed), metric.key) - metricValue(baselineBySeed.get(seed), metric.key))
        .filter(Number.isFinite);
      const s = std(differences);
      pairedEffects.push({
        movementModel: dims.movementModel,
        swimmerCount: dims.swimmerCount,
        sensorProfile: dims.sensorProfile,
        candidateStrategy,
        baselineStrategy,
        metric: metric.key,
        candidateMinusBaselineMean: mean(differences),
        pairedStd: s,
        pairedCi95: differences.length > 1 ? 1.96 * s / Math.sqrt(differences.length) : 0,
        n: differences.length,
      });
    }
  }
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

const metricCsvRows = [];
const runMetricCsvRows = [];
for (const row of rows) {
  for (const metric of coreMetrics) {
    const value = metricValue(row, metric.key);
    if (!Number.isFinite(value)) continue;
    runMetricCsvRows.push({
      movementModel: scenarioLabel(row),
      swimmerCount: countValue(row),
      restingSwimmerCount: row.restingSwimmerCount ?? 0,
      strategy: row.strategy,
      sensorProfile: row.sensorProfile,
      seed: row.seed,
      metric: metric.key,
      value,
    });
  }
}
for (const row of summaryRows) {
  for (const metric of coreMetrics) {
    metricCsvRows.push({
      movementModel: row.movementModel,
      swimmerCount: row.swimmerCount,
      restingSwimmerCount: row.restingSwimmerCount,
      strategy: row.strategy,
      sensorProfile: row.sensorProfile,
      runCount: row.runCount,
      seeds: row.seeds.join(' '),
      metric: metric.key,
      mean: row.metrics[metric.key].mean,
      std: row.metrics[metric.key].std,
      ci95: row.metrics[metric.key].ci95,
      min: row.metrics[metric.key].min,
      max: row.metrics[metric.key].max,
      lowerError: row.metrics[metric.key].mean - row.metrics[metric.key].min,
      upperError: row.metrics[metric.key].max - row.metrics[metric.key].mean,
    });
  }
}

const metricsCsvPath = path.join(reportDir, 'metrics_by_density.csv');
const runMetricsCsvPath = path.join(reportDir, 'metrics_by_run.csv');
const pairedCsvPath = path.join(reportDir, 'paired_effects.csv');
writeCsv(runMetricsCsvPath, [
  'movementModel',
  'swimmerCount',
  'restingSwimmerCount',
  'strategy',
  'sensorProfile',
  'seed',
  'metric',
  'value',
], runMetricCsvRows);
writeCsv(metricsCsvPath, [
  'movementModel',
  'swimmerCount',
  'restingSwimmerCount',
  'strategy',
  'sensorProfile',
  'runCount',
  'seeds',
  'metric',
  'mean',
  'std',
  'ci95',
  'min',
  'max',
  'lowerError',
  'upperError',
], metricCsvRows);
writeCsv(pairedCsvPath, [
  'movementModel',
  'swimmerCount',
  'sensorProfile',
  'candidateStrategy',
  'baselineStrategy',
  'metric',
  'candidateMinusBaselineMean',
  'pairedStd',
  'pairedCi95',
  'n',
], pairedEffects);

const escapeXml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const formatNumber = value => {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
};

const preferredStrategyOrder = [
  'FULL_SCAN',
  'ROUND_ROBIN_SECTOR',
  'ROUND_ROBIN_ROI',
  'NEAREST_ROI',
  'PID_ROI',
  'BELIEF_PSO_NO_PSO',
  'BELIEF_PSO_V3_NO_PSO',
  'BELIEF_PSO_V2',
  'BELIEF_PSO_V3',
];
const strategyRank = strategy => {
  const index = preferredStrategyOrder.indexOf(strategy);
  return index >= 0 ? index : preferredStrategyOrder.length + strategy.charCodeAt(0);
};
const strategies = [...new Set(summaryRows.map(row => row.strategy))]
  .sort((a, b) => strategyRank(a) - strategyRank(b) || a.localeCompare(b));
const mainChartStrategies = strategies.filter(strategy => strategy !== ablationStrategy);
const ablationChartStrategies = [candidateStrategy, ablationStrategy].filter(strategy => strategies.includes(strategy));
const movementModels = [...new Set(summaryRows.map(row => row.movementModel))].sort();
const swimmerCounts = [...new Set(summaryRows.map(row => row.swimmerCount))].sort((a, b) => a - b);
const preferredStrategyStyles = new Map([
  ['FULL_SCAN', { color: '#1f77b4', dash: '', marker: 'circle' }],
  ['ROUND_ROBIN_SECTOR', { color: '#ff7f0e', dash: '8 4', marker: 'square' }],
  ['ROUND_ROBIN_ROI', { color: '#2ca02c', dash: '3 3', marker: 'triangle' }],
  ['NEAREST_ROI', { color: '#8c564b', dash: '2 3', marker: 'cross' }],
  ['PID_ROI', { color: '#0891b2', dash: '5 3', marker: 'diamond' }],
  ['BELIEF_PSO_NO_PSO', { color: '#7f7f7f', dash: '1 3', marker: 'square' }],
  ['BELIEF_PSO_V3_NO_PSO', { color: '#7f7f7f', dash: '1 3', marker: 'square' }],
  ['BELIEF_PSO_V2', { color: '#111827', dash: '', marker: 'star' }],
  ['BELIEF_PSO_V3', { color: '#111827', dash: '', marker: 'star' }],
]);
const fallbackStrategyStyles = [
  { color: '#e377c2', dash: '6 3', marker: 'circle' },
  { color: '#7f7f7f', dash: '1 3', marker: 'square' },
  { color: '#bcbd22', dash: '9 3', marker: 'triangle' },
  { color: '#393b79', dash: '3 2 8 2', marker: 'diamond' },
  { color: '#637939', dash: '5 2', marker: 'cross' },
  { color: '#8c6d31', dash: '2 2', marker: 'plus' },
  { color: '#843c39', dash: '8 2 2 2', marker: 'triangleDown' },
  { color: '#7b4173', dash: '12 3', marker: 'star' },
];
const styleForStrategy = strategy => {
  if (preferredStrategyStyles.has(strategy)) return preferredStrategyStyles.get(strategy);
  const fallbackIndex = Math.max(0, strategies.indexOf(strategy)) % fallbackStrategyStyles.length;
  return fallbackStrategyStyles[fallbackIndex];
};

const markerSvg = (x, y, style, size = 4.5) => {
  const color = style.color;
  const stroke = '#ffffff';
  switch (style.marker) {
    case 'square':
      return `<rect x="${x - size}" y="${y - size}" width="${size * 2}" height="${size * 2}" fill="${color}" stroke="${stroke}" stroke-width="1.1"/>`;
    case 'triangle':
      return `<polygon points="${x},${y - size - 1} ${x - size - 1},${y + size} ${x + size + 1},${y + size}" fill="${color}" stroke="${stroke}" stroke-width="1.1"/>`;
    case 'triangleDown':
      return `<polygon points="${x - size - 1},${y - size} ${x + size + 1},${y - size} ${x},${y + size + 1}" fill="${color}" stroke="${stroke}" stroke-width="1.1"/>`;
    case 'diamond':
      return `<polygon points="${x},${y - size - 1} ${x + size + 1},${y} ${x},${y + size + 1} ${x - size - 1},${y}" fill="${color}" stroke="${stroke}" stroke-width="1.1"/>`;
    case 'cross':
      return [
        `<line x1="${x - size}" y1="${y - size}" x2="${x + size}" y2="${y + size}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`,
        `<line x1="${x + size}" y1="${y - size}" x2="${x - size}" y2="${y + size}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`,
      ].join('');
    case 'plus':
      return [
        `<line x1="${x - size}" y1="${y}" x2="${x + size}" y2="${y}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`,
        `<line x1="${x}" y1="${y - size}" x2="${x}" y2="${y + size}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`,
      ].join('');
    case 'star':
      return [
        `<line x1="${x - size}" y1="${y}" x2="${x + size}" y2="${y}" stroke="${color}" stroke-width="2.3" stroke-linecap="round"/>`,
        `<line x1="${x}" y1="${y - size}" x2="${x}" y2="${y + size}" stroke="${color}" stroke-width="2.3" stroke-linecap="round"/>`,
        `<line x1="${x - size * 0.75}" y1="${y - size * 0.75}" x2="${x + size * 0.75}" y2="${y + size * 0.75}" stroke="${color}" stroke-width="2.1" stroke-linecap="round"/>`,
        `<line x1="${x + size * 0.75}" y1="${y - size * 0.75}" x2="${x - size * 0.75}" y2="${y + size * 0.75}" stroke="${color}" stroke-width="2.1" stroke-linecap="round"/>`,
      ].join('');
    case 'circle':
    default:
      return `<circle cx="${x}" cy="${y}" r="${size}" fill="${color}" stroke="${stroke}" stroke-width="1.1"/>`;
  }
};

const renderChart = (metric, options = {}) => {
  const chartStrategies = options.chartStrategies ?? strategies;
  const titlePrefix = options.titlePrefix ? `${options.titlePrefix}: ` : '';
  const subtitleSuffix = options.subtitleSuffix ? `; ${options.subtitleSuffix}` : '';
  const width = 1280;
  const height = 660;
  const margin = { top: 72, right: 48, bottom: 170, left: 78 };
  const panelGap = 64;
  const panelWidth = (width - margin.left - margin.right - panelGap * Math.max(0, movementModels.length - 1)) / Math.max(1, movementModels.length);
  const panelHeight = height - margin.top - margin.bottom;
  const values = summaryRows
    .filter(row => chartStrategies.includes(row.strategy))
    .flatMap(row => {
      const point = row.metrics[metric.key];
      return [point.mean - point.ci95, point.mean + point.ci95].filter(Number.isFinite);
    });
  const rawMax = Math.max(...values, 1e-9);
  const yMin = 0;
  const yMax = rawMax <= 1.05 ? 1 : rawMax * 1.12;
  const xMin = Math.min(...swimmerCounts);
  const xMax = Math.max(...swimmerCounts);
  const xSpan = Math.max(1, xMax - xMin);
  const sy = value => margin.top + panelHeight - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * panelHeight;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<style>text{font-family:Arial,sans-serif;fill:#111827}.title{font-size:19px;font-weight:700}.label{font-size:12px;fill:#4b5563}.tick{font-size:11px;fill:#6b7280}.grid{stroke:#e5e7eb;stroke-width:1}.axis{stroke:#374151;stroke-width:1}.legend{font-size:12px;fill:#111827}</style>',
    `<text class="title" x="${margin.left}" y="28">${escapeXml(titlePrefix + metric.label)} by swimmer count</text>`,
    `<text class="label" x="${margin.left}" y="46">Mean with 95% CI; ${escapeXml(metric.better)} is better${escapeXml(subtitleSuffix)}</text>`,
  ];

  const legendLeft = margin.left;
  const legendTop = height - 112;
  const legendColWidth = 300;
  const legendRowHeight = 18;
  svg.push(`<line x1="${margin.left}" y1="${legendTop - 20}" x2="${width - margin.right}" y2="${legendTop - 20}" stroke="#e5e7eb" stroke-width="1"/>`);
  svg.push(`<text class="label" x="${margin.left}" y="${legendTop - 33}">Strategy legend</text>`);
  chartStrategies.forEach((strategy, index) => {
    const style = styleForStrategy(strategy);
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x = legendLeft + col * legendColWidth;
    const y = legendTop + row * legendRowHeight;
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : '';
    svg.push(`<line x1="${x}" y1="${y}" x2="${x + 28}" y2="${y}" stroke="${style.color}" stroke-width="3" stroke-linecap="round"${dash}/>`);
    svg.push(markerSvg(x + 14, y, style, 4));
    svg.push(`<text class="legend" x="${x + 38}" y="${y + 4}">${escapeXml(strategy)}</text>`);
  });

  movementModels.forEach((movementModel, panelIndex) => {
    const left = margin.left + panelIndex * (panelWidth + panelGap);
    const sx = count => left + ((count - xMin) / xSpan) * panelWidth;
    svg.push(`<text class="label" x="${left}" y="${margin.top - 10}">${escapeXml(movementModel)}</text>`);
    for (let tick = 0; tick <= 4; tick += 1) {
      const y = margin.top + panelHeight * tick / 4;
      const value = yMax - (yMax - yMin) * tick / 4;
      svg.push(`<line class="grid" x1="${left}" y1="${y}" x2="${left + panelWidth}" y2="${y}"/>`);
      svg.push(`<text class="tick" x="${left - 8}" y="${y + 4}" text-anchor="end">${formatNumber(value)}</text>`);
    }
    for (const count of swimmerCounts) {
      const x = sx(count);
      svg.push(`<line class="grid" x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + panelHeight}"/>`);
      svg.push(`<text class="tick" x="${x}" y="${margin.top + panelHeight + 20}" text-anchor="middle">${count}</text>`);
    }
    svg.push(`<line class="axis" x1="${left}" y1="${margin.top + panelHeight}" x2="${left + panelWidth}" y2="${margin.top + panelHeight}"/>`);
    svg.push(`<line class="axis" x1="${left}" y1="${margin.top}" x2="${left}" y2="${margin.top + panelHeight}"/>`);

    for (const strategy of chartStrategies) {
      const points = summaryRows
        .filter(row => row.movementModel === movementModel && row.strategy === strategy)
        .sort((a, b) => a.swimmerCount - b.swimmerCount)
        .map(row => ({
          x: sx(row.swimmerCount),
          y: sy(row.metrics[metric.key].mean),
          mean: row.metrics[metric.key].mean,
          ci95: row.metrics[metric.key].ci95,
        }));
      const style = styleForStrategy(strategy);
      const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : '';
      const lineWidth = strategy === candidateStrategy ? 3.1 : 2.4;
      if (points.length > 1) {
        svg.push(`<polyline fill="none" stroke="${style.color}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"${dash} points="${points.map(point => `${point.x},${point.y}`).join(' ')}"/>`);
      }
      for (const point of points) {
        const yLo = sy(point.mean - point.ci95);
        const yHi = sy(point.mean + point.ci95);
        svg.push(`<line x1="${point.x}" y1="${yLo}" x2="${point.x}" y2="${yHi}" stroke="${style.color}" stroke-width="1.3" opacity="0.65"/>`);
        svg.push(markerSvg(point.x, point.y, style));
      }
    }
  });

  svg.push(`<text class="label" x="${width / 2}" y="${height - 18}" text-anchor="middle">swimmer count</text>`);
  svg.push('</svg>');
  return `${svg.join('\n')}\n`;
};

const focusMetrics = focusMetricKeys
  .map(key => coreMetrics.find(metric => metric.key === key))
  .filter(Boolean);
const plotDataPath = path.join(reportDir, 'plot_data.json');
writeFileSync(plotDataPath, `${JSON.stringify({
  focusMetrics,
  summaryRows,
  movementModels,
  swimmerCounts,
  mainChartStrategies,
  ablationChartStrategies,
  strategyStyles: Object.fromEntries(strategies.map(strategy => [strategy, styleForStrategy(strategy)])),
  candidateStrategy,
  ablationStrategy,
}, null, 2)}\n`);

const matplotlibConfigDir = path.join(reportDir, '.matplotlib');
mkdirSync(matplotlibConfigDir, { recursive: true });
const pythonCandidates = [
  process.env.E2E_CHART_PYTHON,
  '/Users/bellwu/work/miniconda3/bin/python3',
  'python3',
].filter(Boolean);
const chartPython = pythonCandidates.find(candidate => (
  path.isAbsolute(candidate) ? existsSync(candidate) : true
));
const plotResult = spawnSync(chartPython, [
  path.join('scripts', 'plot_e2e_population_charts.py'),
  plotDataPath,
  chartsDir,
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: {
    ...process.env,
    MPLCONFIGDIR: matplotlibConfigDir,
  },
});
if (plotResult.error) throw plotResult.error;
if (plotResult.status !== 0) {
  throw new Error(`matplotlib chart generation failed with ${chartPython}:\n${plotResult.stdout}\n${plotResult.stderr}`);
}
const chartWarningPath = path.join(reportDir, 'chart_generation_warning.txt');
if (existsSync(chartWarningPath)) unlinkSync(chartWarningPath);
const plotOutput = JSON.parse(plotResult.stdout);
const chartFiles = plotOutput.chartFiles;
const ablationChartFiles = plotOutput.ablationChartFiles;

const summaryPath = path.join(reportDir, 'summary.json');
writeFileSync(summaryPath, `${JSON.stringify({
  outputLabel: 'synthetic-uncalibrated',
  source: runsPath,
  runMetricSource: runMetricsCsvPath,
  generatedAt: new Date().toISOString(),
  focusMetricKeys,
  mainChartStrategies,
  ablationChartStrategies,
  table: summaryRows,
  pairedEffects,
}, null, 2)}\n`);

const metricDefinitions = {
  detection: [
    '`f1`: precision and recall 的调和平均，用于概括检测质量。',
    '`recall`: matched detections divided by detectable swimmer opportunities.',
    '`precision`: matched detections divided by all detections.',
  ],
  freshness: [
    '`avgAoISec`: average scan interval across active swimmers, computed as the inverse of each swimmer matched detection rate in the evaluation window.',
    '`p90AoISec`: 90th percentile scan interval across active swimmers.',
  ],
  tracking: [
    '`trackingRate`: fraction of active swimmer time covered by any track.',
    '`strictTrackAccuracy`: strict scan-level correct track IDs divided by visible-swimmer scan opportunities. Reported as Strict Tracking Accuracy.',
    '`localTrackAccuracy`: handoff-tolerant scan-level correct track IDs divided by visible-swimmer scan opportunities. Reported as Tracking Accuracy.',
    '`trackContinuity`: identity continuity score for recovered tracks; higher means fewer ID switches and track fragmentations.',
    '`trackingRMSEm`: root mean squared tracking localization error in meters.',
    '`gospa`: generalized optimal sub-pattern assignment distance; lower is better.',
  ],
  scanning: [
    '`avgScanRateHz`: average per-swimmer scanned/detected update rate in Hz, averaged across active swimmers.',
  ],
  system: [
    '`sonarBusyRatio`: fraction of sonar-time resources occupied by scan commands. Reported as Sonar Workload.',
    '`searchCoverageRatio`: fraction of emitted angular scan width spent on FULL_SWEEP/SEARCH_SECTOR rather than TRACK_ROI. Reported as Search Coverage.',
    '`beamRateHz`: emitted beam rate in Hz.',
    '`decisionLatencyP95Ms`: p95 strategy planner wall-clock latency. Reported as Planner Latency.',
  ],
};

const tableLine = cells => `| ${cells.join(' | ')} |`;
const config = manifest?.config ?? {};
const seedText = Array.isArray(config.seeds) ? `${config.seeds[0]}..${config.seeds.at(-1)} (${config.seeds.length})` : 'n/a';
const strategyText = Array.isArray(config.strategies) ? config.strategies.join(', ') : strategies.join(', ');
const movementText = Array.isArray(config.movementModels) ? config.movementModels.join(', ') : movementModels.join(', ');
const countText = Array.isArray(config.swimmerCounts) ? config.swimmerCounts.join(', ') : swimmerCounts.join(', ');
const sonarCountText = config.sonarCount ?? rows[0]?.sonarCount ?? 'unknown';
const movementSettingLines = [
  movementModels.includes('random_reflect')
    ? '- `random_reflect`：每个 swimmer 使用 seed 派生独立速度、初始位置和路线型初始航向，主体沿目标航向直行；运行中仅以低频事件触发小转弯、大转弯或掉头，边界附近会主动转回池内。'
    : null,
  movementModels.includes('lap_swim_with_rest')
    ? '- `lap_swim_with_rest`：活动 swimmer 沿长边泳道往返，速度同样按低/中/高三档混合采样；当 N>=6 时，默认约 15% swimmer 在两个短边休息。'
    : null,
].filter(Boolean);

const rowsForStrategy = (movementModel, strategy) => summaryRows
  .filter(row => row.movementModel === movementModel && row.strategy === strategy)
  .sort((a, b) => a.swimmerCount - b.swimmerCount);

const conclusionLines = [];
for (const movementModel of movementModels) {
  const candidateRows = rowsForStrategy(movementModel, candidateStrategy);
  if (candidateRows.length === 0) continue;
  const pressureRows = candidateRows.filter(row => row.swimmerCount > 0);
  const rowsForConclusion = pressureRows.length > 0 ? pressureRows : candidateRows;
  const first = rowsForConclusion[0];
  const last = rowsForConclusion[rowsForConclusion.length - 1];
  conclusionLines.push(
    `- ${movementModel}: ${candidateStrategy} 在 N=${first.swimmerCount} 到 N=${last.swimmerCount} 的 tracking accuracy 从 ${formatNumber(first.metrics.localTrackAccuracy.mean)} 变化到 ${formatNumber(last.metrics.localTrackAccuracy.mean)}，scan interval 从 ${formatNumber(first.metrics.avgAoISec.mean)}s 变化到 ${formatNumber(last.metrics.avgAoISec.mean)}s，scanned rate 从 ${formatNumber(first.metrics.avgScanRateHz.mean)}Hz 变化到 ${formatNumber(last.metrics.avgScanRateHz.mean)}Hz。`
  );
}
if (conclusionLines.length === 0) {
  conclusionLines.push(`- 当前输出中没有 ${candidateStrategy} 的可聚合结果，无法生成策略结论。`);
}

const runFailures = rows.filter(row => row.error || row.failed);

const getSummaryRow = (movementModel, swimmerCount, strategy) => summaryRows.find(row =>
  row.movementModel === movementModel
  && row.swimmerCount === swimmerCount
  && row.strategy === strategy
);
const resultOverviewRows = [];
for (const movementModel of movementModels) {
  for (const swimmerCount of swimmerCounts.filter(count => count > 0)) {
    const candidate = getSummaryRow(movementModel, swimmerCount, candidateStrategy);
    const baseline = getSummaryRow(movementModel, swimmerCount, 'FULL_SCAN');
    if (!candidate || !baseline) continue;
    resultOverviewRows.push(tableLine([
      movementModel,
      swimmerCount,
      formatNumber(baseline.metrics.localTrackAccuracy.mean),
      formatNumber(candidate.metrics.localTrackAccuracy.mean),
      formatNumber(candidate.metrics.localTrackAccuracy.mean - baseline.metrics.localTrackAccuracy.mean),
      `${formatNumber(baseline.metrics.avgAoISec.mean)} / ${formatNumber(candidate.metrics.avgAoISec.mean)}`,
      `${formatNumber(baseline.metrics.avgScanRateHz.mean)} / ${formatNumber(candidate.metrics.avgScanRateHz.mean)}`,
      `${formatNumber(baseline.metrics.decisionLatencyP95Ms.mean)} / ${formatNumber(candidate.metrics.decisionLatencyP95Ms.mean)}`,
    ]));
  }
}

const findingLines = [];
for (const movementModel of movementModels) {
  const nonEmptyCounts = swimmerCounts.filter(count => count > 0);
  const firstCount = nonEmptyCounts[0];
  const lastCount = nonEmptyCounts.at(-1);
  const firstCandidate = getSummaryRow(movementModel, firstCount, candidateStrategy);
  const lastCandidate = getSummaryRow(movementModel, lastCount, candidateStrategy);
  const lastBaseline = getSummaryRow(movementModel, lastCount, 'FULL_SCAN');
  if (!firstCandidate || !lastCandidate || !lastBaseline) continue;
  findingLines.push(
    `- ${movementModel}: ${candidateStrategy} 的 tracking accuracy 从 N=${firstCount} 的 ${formatNumber(firstCandidate.metrics.localTrackAccuracy.mean)} 变化到 N=${lastCount} 的 ${formatNumber(lastCandidate.metrics.localTrackAccuracy.mean)}；在 N=${lastCount} 时相对 FULL_SCAN 的差值为 ${formatNumber(lastCandidate.metrics.localTrackAccuracy.mean - lastBaseline.metrics.localTrackAccuracy.mean)}。`
  );
  findingLines.push(
    `- ${movementModel}: ${candidateStrategy} 在 N=${lastCount} 的 scan interval 为 ${formatNumber(lastCandidate.metrics.avgAoISec.mean)}s，FULL_SCAN 为 ${formatNumber(lastBaseline.metrics.avgAoISec.mean)}s；scanned rate 为 ${formatNumber(lastCandidate.metrics.avgScanRateHz.mean)}Hz，FULL_SCAN 为 ${formatNumber(lastBaseline.metrics.avgScanRateHz.mean)}Hz。`
  );
  findingLines.push(
    `- ${movementModel}: ${candidateStrategy} 在 N=${lastCount} 的 identity continuity 为 ${formatNumber(lastCandidate.metrics.trackContinuity.mean)}，sonar workload 为 ${formatNumber(lastCandidate.metrics.sonarBusyRatio.mean)}，search coverage 为 ${formatNumber(lastCandidate.metrics.searchCoverageRatio.mean)}，planner latency P95 为 ${formatNumber(lastCandidate.metrics.decisionLatencyP95Ms.mean)}ms。`
  );
}

const bestStrategyFor = (movementModel, swimmerCount, metricKey, direction, eligibleStrategies = strategies) => {
  const candidates = summaryRows.filter(row =>
    row.movementModel === movementModel
    && row.swimmerCount === swimmerCount
    && eligibleStrategies.includes(row.strategy)
    && Number.isFinite(row.metrics[metricKey]?.mean)
  );
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const delta = a.metrics[metricKey].mean - b.metrics[metricKey].mean;
    return direction === 'asc' ? delta : -delta;
  });
  const best = sorted[0];
  return `${best.strategy} (${formatNumber(best.metrics[metricKey].mean)})`;
};

const allBaselineOverviewRows = [];
for (const movementModel of movementModels) {
  for (const swimmerCount of swimmerCounts.filter(count => count > 0)) {
    allBaselineOverviewRows.push(tableLine([
      movementModel,
      swimmerCount,
      bestStrategyFor(movementModel, swimmerCount, 'localTrackAccuracy', 'desc', mainChartStrategies) ?? 'n/a',
      bestStrategyFor(movementModel, swimmerCount, 'avgAoISec', 'asc', mainChartStrategies) ?? 'n/a',
      bestStrategyFor(movementModel, swimmerCount, 'avgScanRateHz', 'desc', mainChartStrategies) ?? 'n/a',
      bestStrategyFor(movementModel, swimmerCount, 'trackContinuity', 'desc', mainChartStrategies) ?? 'n/a',
      bestStrategyFor(movementModel, swimmerCount, 'sonarBusyRatio', 'asc', mainChartStrategies) ?? 'n/a',
      bestStrategyFor(movementModel, swimmerCount, 'searchCoverageRatio', 'desc', mainChartStrategies) ?? 'n/a',
      bestStrategyFor(movementModel, swimmerCount, 'decisionLatencyP95Ms', 'asc', mainChartStrategies) ?? 'n/a',
    ]));
  }
}

const ablationOverviewRows = [];
if (ablationChartStrategies.length === 2) {
  for (const movementModel of movementModels) {
    for (const swimmerCount of swimmerCounts.filter(count => count > 0)) {
      const candidate = getSummaryRow(movementModel, swimmerCount, candidateStrategy);
      const ablation = getSummaryRow(movementModel, swimmerCount, ablationStrategy);
      if (!candidate || !ablation) continue;
      ablationOverviewRows.push(tableLine([
        movementModel,
        swimmerCount,
        formatNumber(candidate.metrics.strictTrackAccuracy.mean),
        formatNumber(ablation.metrics.strictTrackAccuracy.mean),
        formatNumber(candidate.metrics.strictTrackAccuracy.mean - ablation.metrics.strictTrackAccuracy.mean),
        `${formatNumber(candidate.metrics.avgAoISec.mean)} / ${formatNumber(ablation.metrics.avgAoISec.mean)}`,
        `${formatNumber(candidate.metrics.avgScanRateHz.mean)} / ${formatNumber(ablation.metrics.avgScanRateHz.mean)}`,
        `${formatNumber(candidate.metrics.decisionLatencyP95Ms.mean)} / ${formatNumber(ablation.metrics.decisionLatencyP95Ms.mean)}`,
      ]));
    }
  }
}

const md = [
  '# 实验 1：端到端性能随 swimmer 数量变化',
  '',
  '## 实验目的和成功标准',
  '',
  ablationChartStrategies.length === 2
    ? `本实验评估 SonarScan Sim 在固定 swimmer 数量逐步增加时的端到端性能，重点关注 tracking accuracy、scan interval、scanned rate、identity continuity、sonar workload、search coverage 和 planner latency。成功标准是每个 swimmer 数量点都有 paired seeds 覆盖，主图清楚展示 ${candidateStrategy} 与常规 baselines 的柱状图和 seed min/max error bar；${ablationStrategy} 不进入整体主图，只在 PSO 消融图表中单独对比。`
    : `本实验评估 SonarScan Sim 在固定 swimmer 数量逐步增加时的端到端性能，重点关注 tracking accuracy、scan interval、scanned rate、identity continuity、sonar workload、search coverage 和 planner latency。成功标准是每个 swimmer 数量点都有 paired seeds 覆盖，主图清楚展示 ${candidateStrategy} 与常规 baselines 的柱状图和 seed min/max error bar。`,
  '',
  '## 系统版本记录',
  '',
  tableLine(['字段', '记录']),
  tableLine(['---', '---']),
  tableLine(['生成时间', new Date().toISOString()]),
  tableLine(['Git commit', manifest?.simulatorState?.gitCommit ?? rows[0]?.simulatorState?.gitCommit ?? 'unknown']),
  tableLine(['Git dirty', String(manifest?.simulatorState?.gitDirty ?? rows[0]?.simulatorState?.gitDirty ?? 'unknown')]),
  tableLine(['Config path', config.configPath ?? 'not recorded']),
  tableLine(['Runs', runsPath]),
  tableLine(['Samples', existsSync(samplesPath) ? samplesPath : 'not found']),
  tableLine(['Manifest', existsSync(manifestPath) ? manifestPath : 'not found']),
  '',
  '### 策略实现 fingerprint',
  '',
  tableLine(['Strategy', 'Language', 'Implementation', 'Code version']),
  tableLine(['---', '---', '---', '---']),
  ...Object.entries(manifest?.strategyImplementations ?? {})
    .map(([strategy, impl]) => tableLine([
      strategy,
      impl.implementationLanguage ?? 'unknown',
      impl.implementation ?? 'unknown',
      impl.codeVersion ?? 'unknown',
    ])),
  '',
  '## 场景设置',
  '',
  '- 泳池尺寸：20m x 50m。',
  `- Sonar 布局：${sonarCountText} 个合成 imaging sonar。`,
  `- Sensor profile：\`${config.sensorProfile ?? rows[0]?.sensorProfile ?? 'unknown'}\`。`,
  `- Movement models：${movementText}。`,
  ...movementSettingLines,
  '',
  '## 实验矩阵',
  '',
  tableLine(['字段', '值']),
  tableLine(['---', '---']),
  tableLine(['Benchmark ID', config.benchmarkId ?? rows[0]?.benchmarkId ?? 'unknown']),
  tableLine(['Movement models', movementText]),
  tableLine(['Swimmer counts', countText]),
  tableLine(['Seeds', seedText]),
  tableLine(['Strategies', strategyText]),
  tableLine(['Main chart strategies', mainChartStrategies.join(', ')]),
  tableLine(['Ablation chart strategies', ablationChartStrategies.length === 2 ? ablationChartStrategies.join(', ') : 'not available']),
  tableLine(['Focus metrics', focusMetricKeys.join(', ')]),
  tableLine(['Duration', `${config.durationSec ?? rows[0]?.durationSec ?? 'n/a'} sec`]),
  tableLine(['Warmup', `${config.warmupSec ?? 'n/a'} sec`]),
  tableLine(['Metrics window', `${config.metricsWindowSec ?? 'n/a'} sec`]),
  tableLine(['Sample interval', `${config.sampleIntervalSec ?? 'n/a'} sec`]),
  tableLine(['Strategy update interval', `${config.strategyUpdateIntervalSec ?? 'n/a'} sec`]),
  '',
  '## 关键结果概览',
  '',
  ...findingLines,
  '',
  tableLine(['Movement', 'N', 'FULL Track Acc.', 'PSO Track Acc.', 'PSO-FULL Track Acc.', 'Scan Interval FULL/PSO (s)', 'Scanned Rate FULL/PSO (Hz)', 'Planner P95 FULL/PSO (ms)']),
  tableLine(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
  ...resultOverviewRows,
  '',
  '### 多 Baseline 最佳策略概览（不含 NO_PSO 消融项）',
  '',
  tableLine(['Movement', 'N', 'Best Tracking Acc.', 'Lowest Scan Interval', 'Highest Scanned Rate', 'Best Identity Continuity', 'Lowest Workload', 'Highest Search Coverage', 'Lowest Planner P95']),
  tableLine(['---', '---:', '---', '---', '---', '---', '---', '---', '---']),
  ...allBaselineOverviewRows,
  '',
  ...(ablationOverviewRows.length ? [
    '### PSO 消融概览',
    '',
    tableLine(['Movement', 'N', 'PSO Strict Acc.', 'NO_PSO Strict Acc.', 'PSO-NO_PSO Strict Acc.', 'Avg AoI PSO/NO_PSO (s)', 'Avg Scanned Rate PSO/NO_PSO (Hz)', 'Decision P95 PSO/NO_PSO (ms)']),
    tableLine(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
    ...ablationOverviewRows,
    '',
  ] : []),
  '## 指标定义',
  '',
  '### 检测',
  ...metricDefinitions.detection.map(item => `- ${item}`),
  '',
  '### 跟踪',
  ...metricDefinitions.tracking.map(item => `- ${item}`),
  '',
  '### 时效性',
  ...metricDefinitions.freshness.map(item => `- ${item}`),
  '',
  '### 扫描频率',
  ...metricDefinitions.scanning.map(item => `- ${item}`),
  '',
  '### 策略延迟',
  ...metricDefinitions.system.map(item => `- ${item}`),
  '',
  '## Error bar 说明',
  '',
  '- 图中柱高为跨 seed 均值；error bar 下端为 `mean - min(seed values)`，上端为 `max(seed values) - mean`，因此上下长度可以不同。',
  '',
  '## 主实验图表',
  '',
  ablationChartStrategies.length === 2
    ? `以下主图不包含 \`${ablationStrategy}\`，该策略只在后面的 PSO 消融图表中出现。`
    : '以下主图包含本次配置中的全部策略。',
  '',
  ...chartFiles.map(({ metric, fileName }) => `### ${metric.label}\n\n![${metric.key}](${fileName})`),
  '',
  ...(ablationChartFiles.length ? [
    '## PSO 消融图表',
    '',
    `以下图表只比较 \`${candidateStrategy}\` 与 \`${ablationStrategy}\`。`,
    '',
    ...ablationChartFiles.map(({ metric, fileName }) => `### ${metric.label}\n\n![ablation_${metric.key}](${fileName})`),
    '',
  ] : []),
  '## 结果记录',
  '',
  `- 原始 run summary：${runsPath}`,
  `- 原始 samples：${existsSync(samplesPath) ? samplesPath : 'not found'}`,
  `- Per-run metric CSV：${runMetricsCsvPath}`,
  `- 聚合 CSV：${metricsCsvPath}`,
  `- Paired effects CSV：${pairedCsvPath}`,
  `- Summary JSON：${summaryPath}`,
  `- 总 run 数：${rows.length}`,
  `- 失败或异常 run 数：${runFailures.length}`,
  '',
  '## 结论',
  '',
  ...conclusionLines,
  '',
  `- ${candidateStrategy} 相对 FULL_SCAN 的逐点 paired differences 见 \`${path.basename(pairedCsvPath)}\`。Tracking accuracy、identity continuity、scanned rate 和 search coverage 越高越好；scan interval、sonar workload 和 planner latency 越低越好。`,
  '',
];

const reportPath = path.join(reportDir, 'e2e_population_sweep_report.md');
writeFileSync(reportPath, `${md.join('\n')}\n`);

console.log(JSON.stringify({
  reportPath,
  runMetricsCsvPath,
  metricsCsvPath,
  pairedCsvPath,
  summaryPath,
  chartCount: chartFiles.length,
  ablationChartCount: ablationChartFiles.length,
}, null, 2));
