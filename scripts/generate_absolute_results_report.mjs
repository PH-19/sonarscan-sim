import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [plotDataArg, reportDirArg, chartsDirName = 'charts_no_errorbar', outputName = 'absolute_results_no_errorbar_report.md'] = process.argv.slice(2);
if (!plotDataArg || !reportDirArg) {
  throw new Error('Usage: node scripts/generate_absolute_results_report.mjs <plot-data.json> <report-dir> [charts-dir-name] [output-name]');
}

const plotDataPath = path.resolve(plotDataArg);
const reportDir = path.resolve(reportDirArg);
mkdirSync(reportDir, { recursive: true });

const payload = JSON.parse(readFileSync(plotDataPath, 'utf8'));
const strategies = payload.mainChartStrategies;
const counts = payload.swimmerCounts;
const metrics = payload.focusMetrics;
const rows = payload.summaryRows;
const movementModels = payload.movementModels;

const strategyLabels = {
  FULL_SCAN: 'Full Scan',
  ROUND_ROBIN_SECTOR: 'RR Sector',
  ROUND_ROBIN_ROI: 'RR ROI',
  NEAREST_ROI: 'Nearest ROI',
  PID_ROI: 'PID ROI',
  BELIEF_PSO_V3: 'Proposed',
};

const percentMetrics = new Set([
  'localTrackAccuracy',
  'trackContinuity',
  'sonarBusyRatio',
  'searchCoverageRatio',
]);

const labelForStrategy = strategy => strategyLabels[strategy] ?? strategy;

const valueFor = (movementModel, swimmerCount, strategy, metricKey) => {
  const row = rows.find(item =>
    item.movementModel === movementModel &&
    item.swimmerCount === swimmerCount &&
    item.strategy === strategy
  );
  const value = row?.metrics?.[metricKey]?.mean;
  return Number.isFinite(value) ? value : Number.NaN;
};

const formatValue = (metricKey, value) => {
  if (!Number.isFinite(value)) return 'n/a';
  if (percentMetrics.has(metricKey)) return (value * 100).toFixed(1);
  if (metricKey === 'decisionLatencyP95Ms') return value.toFixed(1);
  return value.toFixed(3);
};

const unitFor = metricKey => {
  if (percentMetrics.has(metricKey)) return '%';
  if (metricKey === 'avgAoISec') return 's';
  if (metricKey === 'avgScanRateHz') return 'Hz';
  if (metricKey === 'decisionLatencyP95Ms') return 'ms';
  return '';
};

const metricTitle = metric => {
  if (/\([^)]*\)/.test(metric.label)) return metric.label;
  const unit = unitFor(metric.key);
  return unit ? `${metric.label} (${unit})` : metric.label;
};

const markdownTable = (headers, records) => [
  `| ${headers.join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...records.map(record => `| ${headers.map(header => record[header]).join(' | ')} |`),
].join('\n');

const lines = [
  '# Sensor Failure Robustness Absolute Results',
  '',
  'This report shows the segment-failure benchmark results as absolute metric means. Figures are grouped bar charts without error bars.',
  '',
  '## Setup',
  '',
  markdownTable(['Field', 'Value'], [
    { Field: 'Failure mode', Value: '`segment_transient`' },
    { Field: 'Failure window', Value: '`45s-85s`' },
    { Field: 'Run matrix', Value: '`5 densities * 6 strategies * 10 seeds = 300 runs`' },
    { Field: 'Movement model', Value: movementModels.join(', ') },
    { Field: 'Swimmer counts', Value: counts.join(', ') },
    { Field: 'Strategies', Value: strategies.map(strategy => `\`${strategy}\``).join(', ') },
  ]),
  '',
  '## Figures',
  '',
  ...metrics.flatMap(metric => [
    `### ${metricTitle(metric)}`,
    '',
    `![${metric.key}](${chartsDirName}/${metric.key}.png)`,
    '',
  ]),
  '## Absolute Mean Tables',
  '',
];

for (const movementModel of movementModels) {
  lines.push(`### ${movementModel}`, '');
  for (const metric of metrics) {
    const headers = ['N', ...strategies.map(labelForStrategy)];
    const records = counts.map(count => {
      const record = { N: String(count) };
      for (const strategy of strategies) {
        record[labelForStrategy(strategy)] = formatValue(
          metric.key,
          valueFor(movementModel, count, strategy, metric.key)
        );
      }
      return record;
    });
    lines.push(`#### ${metricTitle(metric)}`, '');
    lines.push(markdownTable(headers, records));
    lines.push('');
  }
}

const outputPath = path.join(reportDir, outputName);
writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(JSON.stringify({ outputPath }, null, 2));
