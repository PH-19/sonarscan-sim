import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const focusMetrics = [
  { key: 'localTrackAccuracy', label: 'Tracking Accuracy', better: 'higher' },
  { key: 'avgAoISec', label: 'Scan Interval', better: 'lower' },
  { key: 'avgScanRateHz', label: 'Scanned Rate', better: 'higher' },
  { key: 'trackContinuity', label: 'Identity Continuity', better: 'higher' },
  { key: 'sonarBusyRatio', label: 'Sonar Workload', better: 'lower' },
  { key: 'searchCoverageRatio', label: 'Search Coverage', better: 'higher' },
  { key: 'decisionLatencyP95Ms', label: 'Planner Latency', better: 'lower' },
];

const strategyOrder = [
  'FULL_SCAN',
  'ROUND_ROBIN_SECTOR',
  'ROUND_ROBIN_ROI',
  'NEAREST_ROI',
  'PID_ROI',
  'BELIEF_PSO_V3',
];

const usage = () => {
  throw new Error(
    'Usage: node scripts/generate_failure_vs_control_deltas.mjs <control-output-dir> <failure-output-dir> <report-dir>'
  );
};

const [controlDirArg, failureDirArg, reportDirArg] = process.argv.slice(2);
if (!controlDirArg || !failureDirArg || !reportDirArg) usage();

const controlDir = path.resolve(controlDirArg);
const failureDir = path.resolve(failureDirArg);
const reportDir = path.resolve(reportDirArg);
const chartsDir = path.join(reportDir, 'failure_vs_control_charts');
mkdirSync(chartsDir, { recursive: true });

const readJsonl = filePath => readFileSync(filePath, 'utf8')
  .trim()
  .split(/\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line));

const csvValue = value => {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const writeCsv = (filePath, columns, rows) => {
  const lines = [
    columns.join(','),
    ...rows.map(row => columns.map(column => csvValue(row[column])).join(',')),
  ];
  writeFileSync(filePath, `${lines.join('\n')}\n`);
};

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
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

const rowKey = row => [
  row.movementModel ?? row.scenario,
  row.swimmerCount ?? row.finalTruthCount,
  row.strategy,
  row.seed,
  row.sensorProfile,
].join('|');

const groupKey = row => [
  row.movementModel,
  row.swimmerCount,
  row.strategy,
  row.sensorProfile,
].join('|');

const controlRows = readJsonl(path.join(controlDir, 'runs.jsonl'));
const failureRows = readJsonl(path.join(failureDir, 'runs.jsonl'));
const controlByKey = new Map(controlRows.map(row => [rowKey(row), row]));

const deltaRows = [];
for (const failureRow of failureRows) {
  const controlRow = controlByKey.get(rowKey(failureRow));
  if (!controlRow) continue;
  for (const metric of focusMetrics) {
    const controlValue = metricValue(controlRow, metric.key);
    const failureValue = metricValue(failureRow, metric.key);
    if (!Number.isFinite(controlValue) || !Number.isFinite(failureValue)) continue;
    deltaRows.push({
      movementModel: failureRow.movementModel ?? failureRow.scenario,
      swimmerCount: failureRow.swimmerCount ?? failureRow.finalTruthCount,
      restingSwimmerCount: failureRow.restingSwimmerCount ?? 0,
      strategy: failureRow.strategy,
      sensorProfile: failureRow.sensorProfile,
      seed: failureRow.seed,
      sonarFailureMode: failureRow.sonarFailureMode ?? '',
      failedSonarIds: (failureRow.failedSonarIds ?? []).join('+'),
      sonarFailureStartSec: failureRow.sonarFailureStartSec ?? '',
      sonarFailureEndSec: failureRow.sonarFailureEndSec ?? '',
      metric: metric.key,
      controlValue,
      failureValue,
      failureMinusControl: failureValue - controlValue,
    });
  }
}

const groups = new Map();
for (const row of deltaRows) {
  const key = groupKey(row);
  const current = groups.get(key) ?? {
    movementModel: row.movementModel,
    swimmerCount: row.swimmerCount,
    restingSwimmerCount: row.restingSwimmerCount,
    strategy: row.strategy,
    sensorProfile: row.sensorProfile,
    rows: [],
  };
  current.rows.push(row);
  groups.set(key, current);
}

const summaryRows = [...groups.values()]
  .map(group => {
    const metrics = {};
    for (const metric of focusMetrics) {
      const values = group.rows
        .filter(row => row.metric === metric.key)
        .map(row => row.failureMinusControl)
        .filter(Number.isFinite);
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
      runCount: group.rows.filter(row => row.metric === focusMetrics[0].key).length,
      metrics,
    };
  })
  .sort((a, b) =>
    a.movementModel.localeCompare(b.movementModel)
    || a.swimmerCount - b.swimmerCount
    || strategyOrder.indexOf(a.strategy) - strategyOrder.indexOf(b.strategy)
    || a.strategy.localeCompare(b.strategy)
  );

const summaryCsvRows = [];
for (const row of summaryRows) {
  for (const metric of focusMetrics) {
    const stats = row.metrics[metric.key];
    summaryCsvRows.push({
      movementModel: row.movementModel,
      swimmerCount: row.swimmerCount,
      restingSwimmerCount: row.restingSwimmerCount,
      strategy: row.strategy,
      sensorProfile: row.sensorProfile,
      runCount: row.runCount,
      metric: metric.key,
      mean: stats.mean,
      std: stats.std,
      ci95: stats.ci95,
      min: stats.min,
      max: stats.max,
      lowerError: stats.mean - stats.min,
      upperError: stats.max - stats.mean,
    });
  }
}

const deltaCsvPath = path.join(reportDir, 'failure_vs_control_deltas.csv');
const summaryCsvPath = path.join(reportDir, 'failure_vs_control_delta_summary.csv');
const plotDataPath = path.join(reportDir, 'failure_vs_control_plot_data.json');
const reportPath = path.join(reportDir, 'failure_vs_control_delta_report.md');

writeCsv(deltaCsvPath, [
  'movementModel',
  'swimmerCount',
  'restingSwimmerCount',
  'strategy',
  'sensorProfile',
  'seed',
  'sonarFailureMode',
  'failedSonarIds',
  'sonarFailureStartSec',
  'sonarFailureEndSec',
  'metric',
  'controlValue',
  'failureValue',
  'failureMinusControl',
], deltaRows);
writeCsv(summaryCsvPath, [
  'movementModel',
  'swimmerCount',
  'restingSwimmerCount',
  'strategy',
  'sensorProfile',
  'runCount',
  'metric',
  'mean',
  'std',
  'ci95',
  'min',
  'max',
  'lowerError',
  'upperError',
], summaryCsvRows);

const movementModels = [...new Set(summaryRows.map(row => row.movementModel))].sort();
const swimmerCounts = [...new Set(summaryRows.map(row => row.swimmerCount))].sort((a, b) => a - b);
const strategies = strategyOrder.filter(strategy => summaryRows.some(row => row.strategy === strategy));
const plotPayload = {
  deltaMode: true,
  controlDir,
  failureDir,
  focusMetrics,
  summaryRows,
  movementModels,
  swimmerCounts,
  mainChartStrategies: strategies,
  ablationChartStrategies: [],
  candidateStrategy: 'BELIEF_PSO_V3',
  ablationStrategy: null,
};
writeFileSync(plotDataPath, `${JSON.stringify(plotPayload, null, 2)}\n`);

const chartPythonCandidates = [
  process.env.E2E_CHART_PYTHON,
  '/Users/bellwu/work/miniconda3/bin/python3',
  'python3',
].filter(Boolean);
let plotResult = null;
for (const python of chartPythonCandidates) {
  const result = spawnSync(python, [
    'scripts/plot_e2e_population_charts.py',
    plotDataPath,
    chartsDir,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status === 0) {
    plotResult = { python, result };
    break;
  }
  plotResult = { python, result };
}
if (!plotResult || plotResult.result.status !== 0) {
  throw new Error(`failed to render delta charts with ${plotResult?.python}:\n${plotResult?.result.stdout}\n${plotResult?.result.stderr}`);
}

const findSummary = (swimmerCount, strategy, metricKey) => summaryRows.find(row =>
  row.swimmerCount === swimmerCount && row.strategy === strategy
)?.metrics[metricKey]?.mean;
const lastCount = swimmerCounts[swimmerCounts.length - 1];
const proposedTrackingDelta = findSummary(lastCount, 'BELIEF_PSO_V3', 'localTrackAccuracy');
const proposedIntervalDelta = findSummary(lastCount, 'BELIEF_PSO_V3', 'avgAoISec');
const proposedLatencyDelta = findSummary(lastCount, 'BELIEF_PSO_V3', 'decisionLatencyP95Ms');

writeFileSync(reportPath, [
  '# Sensor Failure vs Control Paired Delta',
  '',
  `Control runs: ${path.join(controlDir, 'runs.jsonl')}`,
  `Failure runs: ${path.join(failureDir, 'runs.jsonl')}`,
  '',
  'Each row pairs the same movement model, swimmer count, strategy, seed, and sensor profile. Values are `segment failure - no failure`.',
  '',
  `Matched delta rows: ${deltaRows.length}`,
  `Summary groups: ${summaryRows.length}`,
  '',
  `At N=${lastCount}, BELIEF_PSO_V3 deltas: tracking accuracy ${Number.isFinite(proposedTrackingDelta) ? proposedTrackingDelta.toFixed(4) : 'n/a'}, scan interval ${Number.isFinite(proposedIntervalDelta) ? proposedIntervalDelta.toFixed(4) : 'n/a'}s, planner latency P95 ${Number.isFinite(proposedLatencyDelta) ? proposedLatencyDelta.toFixed(2) : 'n/a'}ms.`,
  '',
  '## Charts',
  '',
  ...focusMetrics.flatMap(metric => [
    `### Delta ${metric.label}`,
    '',
    `![${metric.key}](failure_vs_control_charts/${metric.key}.png)`,
    '',
  ]),
].join('\n'));

console.log(JSON.stringify({
  deltaCsvPath,
  summaryCsvPath,
  plotDataPath,
  reportPath,
  chartsDir,
  chartPython: plotResult.python,
  deltaRows: deltaRows.length,
  summaryRows: summaryRows.length,
}, null, 2));
