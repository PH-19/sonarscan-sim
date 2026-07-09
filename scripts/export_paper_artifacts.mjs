import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: node scripts/export_paper_artifacts.mjs <summary.json|benchmark-output-dir> [output-dir]');
  process.exit(2);
}

const inputPath = path.resolve(process.cwd(), inputArg);
const summaryPath = statSync(inputPath).isDirectory() ? path.join(inputPath, 'summary.json') : inputPath;
const outputDir = path.resolve(process.cwd(), process.argv[3] ?? path.join(path.dirname(summaryPath), 'paper-artifacts'));
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

if (summary.outputLabel !== 'synthetic-uncalibrated') {
  throw new Error(`Unsupported output label: ${summary.outputLabel}`);
}
if (!Array.isArray(summary.table) || !Array.isArray(summary.pairedComparisons)) {
  throw new Error('Invalid benchmark summary: table and pairedComparisons are required');
}

mkdirSync(outputDir, { recursive: true });

const metricNames = [
  'strictTrackAccuracy',
  'avgAoISec',
  'avgScanRateHz',
  'decisionLatencyP95Ms',
];
const csvCell = value => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = rows => `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
const finite = value => Number.isFinite(value) ? value : '';

const metricRows = [[
  'scenario', 'strategy', 'sensor_profile', 'run_count',
  ...metricNames.flatMap(name => [`${name}_mean`, `${name}_ci95`]),
]];
for (const row of summary.table) {
  metricRows.push([
    row.scenario, row.strategy, row.sensorProfile, row.runCount,
    ...metricNames.flatMap(name => [finite(row.metrics?.[name]?.mean), finite(row.metrics?.[name]?.ci95)]),
  ]);
}
writeFileSync(path.join(outputDir, 'paper_metrics.csv'), csv(metricRows));

const pairedRows = [[
  'scenario', 'candidate', 'baseline', 'metric', 'n',
  'candidate_minus_baseline', 'paired_ci95', 'cohen_dz',
]];
for (const comparison of summary.pairedComparisons) {
  for (const [metric, value] of Object.entries(comparison.metrics)) {
    pairedRows.push([
      comparison.scenario, comparison.candidateStrategy, comparison.baselineStrategy, metric,
      value.n, value.candidateMinusBaselineMean, value.pairedCi95, value.cohenDz,
    ]);
  }
}
writeFileSync(path.join(outputDir, 'paper_paired_effects.csv'), csv(pairedRows));

const display = value => Number(value).toFixed(2);
const tableLines = [
  '# Synthetic pre-calibration benchmark tables',
  '',
  '> Diagnostic synthetic results only; do not present as real-world Ping360 performance.',
  '',
  '| Scenario | Strategy | Tracking Accuracy | Average AoI (s) | Avg Scan Rate (Hz) | Decision Latency P95 (ms) |',
  '|---|---|---:|---:|---:|---:|',
];
for (const row of summary.table) {
  const m = row.metrics;
  tableLines.push(`| ${row.scenario} | ${row.strategy} | ${display(m.strictTrackAccuracy.mean)} | ${display(m.avgAoISec.mean)} | ${display(m.avgScanRateHz.mean)} | ${display(m.decisionLatencyP95Ms.mean)} |`);
}
const pairedCandidate = summary.pairedComparisons[0]?.candidateStrategy ?? 'proposed';
tableLines.push('', `## Paired ${pairedCandidate} effects`, '', '| Scenario | Baseline | ΔTracking Accuracy | ΔAverage AoI (s) | ΔAvg Scan Rate (Hz) | ΔDecision Latency P95 (ms) |', '|---|---|---:|---:|---:|---:|');
for (const row of summary.pairedComparisons) {
  const m = row.metrics;
  tableLines.push(`| ${row.scenario} | ${row.baselineStrategy} | ${display(m.strictTrackAccuracy.candidateMinusBaselineMean)} | ${display(m.avgAoISec.candidateMinusBaselineMean)} | ${display(m.avgScanRateHz.candidateMinusBaselineMean)} | ${display(m.decisionLatencyP95Ms.candidateMinusBaselineMean)} |`);
}
writeFileSync(path.join(outputDir, 'paper_tables.md'), `${tableLines.join('\n')}\n`);

const escapeXml = value => String(value).replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
const scenarios = [...new Set(summary.table.map(row => row.scenario))];
const strategies = [...new Set(summary.table.map(row => row.strategy))];
const colors = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#4b5563'];
const colorByStrategy = new Map(strategies.map((strategy, index) => [strategy, colors[index % colors.length]]));
const panelWidth = 360;
const panelHeight = 300;
const columns = Math.min(2, scenarios.length);
const rows = Math.ceil(scenarios.length / columns);
const width = columns * panelWidth;
const height = rows * panelHeight + 95;
const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`, '<rect width="100%" height="100%" fill="white"/>', '<style>text{font-family:Arial,sans-serif;fill:#111827}.axis{stroke:#6b7280;stroke-width:1}.grid{stroke:#e5e7eb;stroke-width:1}.label{font-size:11px}.title{font-size:14px;font-weight:600}.legend{font-size:11px}</style>'];

for (const [index, scenario] of scenarios.entries()) {
  const panel = summary.table.filter(row => row.scenario === scenario);
  const ox = (index % columns) * panelWidth;
  const oy = Math.floor(index / columns) * panelHeight;
  const left = ox + 54;
  const top = oy + 35;
  const plotWidth = panelWidth - 78;
  const plotHeight = panelHeight - 83;
  const xValues = panel.map(row => row.metrics.avgAoISec.mean);
  const yValues = panel.map(row => row.metrics.strictTrackAccuracy.mean);
  const xMax = Math.max(...xValues) * 1.08 || 1;
  const yMin = 0;
  const yMax = Math.max(1, Math.max(...yValues) * 1.08 || 1);
  const sx = value => left + (value / xMax) * plotWidth;
  const sy = value => top + plotHeight - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * plotHeight;
  svg.push(`<text class="title" x="${left}" y="${oy + 20}">${escapeXml(scenario)}</text>`);
  for (let tick = 0; tick <= 4; tick += 1) {
    const x = left + plotWidth * tick / 4;
    const y = top + plotHeight * tick / 4;
    svg.push(`<line class="grid" x1="${x}" y1="${top}" x2="${x}" y2="${top + plotHeight}"/>`, `<line class="grid" x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}"/>`);
    svg.push(`<text class="label" text-anchor="middle" x="${x}" y="${top + plotHeight + 16}">${(xMax * tick / 4).toFixed(1)}</text>`);
    svg.push(`<text class="label" text-anchor="end" x="${left - 7}" y="${y + 4}">${(yMax - (yMax - yMin) * tick / 4).toFixed(1)}</text>`);
  }
  svg.push(`<line class="axis" x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}"/>`, `<line class="axis" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}"/>`, `<text class="label" text-anchor="middle" x="${left + plotWidth / 2}" y="${oy + panelHeight - 8}">Average AoI (s) — lower is better</text>`, `<text class="label" text-anchor="middle" transform="translate(${ox + 14},${top + plotHeight / 2}) rotate(-90)">Tracking accuracy — higher is better</text>`);
  for (const point of panel) {
    const scanRate = Math.max(0, point.metrics.avgScanRateHz.mean);
    svg.push(`<circle cx="${sx(point.metrics.avgAoISec.mean)}" cy="${sy(point.metrics.strictTrackAccuracy.mean)}" r="${4 + 8 * Math.sqrt(scanRate)}" fill="${colorByStrategy.get(point.strategy)}" fill-opacity="0.72" stroke="white" stroke-width="1"><title>${escapeXml(point.strategy)}; trackingAccuracy=${display(point.metrics.strictTrackAccuracy.mean)}; AoI=${display(point.metrics.avgAoISec.mean)}; avgScanRateHz=${display(scanRate)}; decisionLatencyP95Ms=${display(point.metrics.decisionLatencyP95Ms.mean)}</title></circle>`);
  }
}

const legendY = rows * panelHeight + 23;
svg.push(`<text class="legend" x="20" y="${legendY}">Circle area encodes avgScanRateHz</text>`);
strategies.forEach((strategy, index) => {
  const x = 20 + (index % 4) * Math.floor((width - 40) / 4);
  const y = legendY + 24 + Math.floor(index / 4) * 22;
  svg.push(`<circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${colorByStrategy.get(strategy)}"/><text class="legend" x="${x + 15}" y="${y}">${escapeXml(strategy)}</text>`);
});
svg.push('</svg>');
writeFileSync(path.join(outputDir, 'tracking_accuracy_aoi_scanrate.svg'), `${svg.join('\n')}\n`);

console.log(outputDir);
