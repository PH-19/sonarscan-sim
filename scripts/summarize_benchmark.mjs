import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: node scripts/summarize_benchmark.mjs <runs.jsonl|benchmark-output-dir> [summary.json]');
  process.exit(2);
}

const inputPath = path.resolve(process.cwd(), inputArg);
const runsPath = statSync(inputPath).isDirectory() ? path.join(inputPath, 'runs.jsonl') : inputPath;
const outputPath = path.resolve(
  process.cwd(),
  process.argv[3] ?? path.join(path.dirname(runsPath), 'summary.json')
);

const rows = readFileSync(runsPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

if (rows.some(row => row.outputLabel !== 'synthetic-uncalibrated')) {
  throw new Error('Stage 5A summary only accepts synthetic-uncalibrated benchmark rows');
}

const metrics = [
  'strictTrackAccuracy',
  'localTrackAccuracy',
  'avgAoISec',
  'avgScanRateHz',
  'decisionLatencyP95Ms',
];

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const std = values => {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};

const metricValue = (row, metric) => {
  const evalMetrics = row.aggregateMetrics ?? row.finalMetrics ?? {};
  if (Number.isFinite(evalMetrics[metric])) return evalMetrics[metric];
  const commandMetrics = row.commandMetrics ?? {};
  if (Number.isFinite(commandMetrics[metric])) return commandMetrics[metric];
  return Number.NaN;
};

const usesPopulationDimensions = rows.some(row => row.movementModel !== undefined || row.swimmerCount !== undefined);

const groups = new Map();
for (const row of rows) {
  const key = usesPopulationDimensions
    ? [row.movementModel ?? row.scenario, row.swimmerCount ?? row.finalTruthCount, row.strategy, row.sensorProfile].join('|')
    : [row.scenario, row.strategy, row.sensorProfile].join('|');
  const current = groups.get(key) ?? {
    outputLabel: row.outputLabel,
    scenario: row.scenario,
    movementModel: row.movementModel,
    swimmerCount: row.swimmerCount,
    restingSwimmerCount: row.restingSwimmerCount,
    strategy: row.strategy,
    sensorProfile: row.sensorProfile,
    seeds: [],
    rows: [],
  };
  current.seeds.push(row.seed);
  current.rows.push(row);
  groups.set(key, current);
}

const table = [...groups.values()].map(group => {
  const summary = {
    outputLabel: group.outputLabel,
    scenario: group.scenario,
    movementModel: group.movementModel,
    swimmerCount: group.swimmerCount,
    restingSwimmerCount: group.restingSwimmerCount,
    strategy: group.strategy,
    sensorProfile: group.sensorProfile,
    runCount: group.rows.length,
    seeds: [...new Set(group.seeds)].sort((a, b) => a - b),
    metrics: {},
    totals: {
      meanScanCommands: mean(group.rows.map(row => row.totalScanCommands)),
      meanDetections: mean(group.rows.map(row => row.totalDetections)),
      meanFalseAlarms: mean(group.rows.map(row => row.totalFalseAlarms)),
    },
  };

  for (const metric of metrics) {
    const values = group.rows.map(row => metricValue(row, metric)).filter(Number.isFinite);
    const s = std(values);
    summary.metrics[metric] = {
      mean: mean(values),
      std: s,
      ci95: values.length > 1 ? 1.96 * s / Math.sqrt(values.length) : 0,
    };
  }
  return summary;
});

const rankings = {};
const rankingKeys = usesPopulationDimensions
  ? [...new Set(table.map(row => `${row.movementModel}|${row.swimmerCount}`))]
  : [...new Set(table.map(row => row.scenario))];
for (const rankingKey of rankingKeys) {
  const subset = usesPopulationDimensions
    ? table.filter(row => `${row.movementModel}|${row.swimmerCount}` === rankingKey)
    : table.filter(row => row.scenario === rankingKey);
  rankings[rankingKey] = {
    byTrackingAccuracyDesc: [...subset].sort((a, b) => b.metrics.strictTrackAccuracy.mean - a.metrics.strictTrackAccuracy.mean).map(row => row.strategy),
    byLocalTrackingAccuracyDesc: [...subset].sort((a, b) => b.metrics.localTrackAccuracy.mean - a.metrics.localTrackAccuracy.mean).map(row => row.strategy),
    byAvgAoIAsc: [...subset].sort((a, b) => a.metrics.avgAoISec.mean - b.metrics.avgAoISec.mean).map(row => row.strategy),
    byAvgScanRateDesc: [...subset].sort((a, b) => b.metrics.avgScanRateHz.mean - a.metrics.avgScanRateHz.mean).map(row => row.strategy),
    byDecisionLatencyAsc: [...subset].sort((a, b) => a.metrics.decisionLatencyP95Ms.mean - b.metrics.decisionLatencyP95Ms.mean).map(row => row.strategy),
  };
}

const strategyNames = new Set(rows.map(row => row.strategy));
const proposedStrategy = strategyNames.has('BELIEF_PSO_V3') ? 'BELIEF_PSO_V3' : 'BELIEF_PSO_V2';
const pairedMetrics = ['strictTrackAccuracy', 'localTrackAccuracy', 'avgAoISec', 'avgScanRateHz', 'decisionLatencyP95Ms'];
const pairedComparisons = [];
const comparisonKeys = new Map();
for (const row of rows) {
  const key = usesPopulationDimensions
    ? [row.movementModel ?? row.scenario, row.swimmerCount ?? row.finalTruthCount, row.sensorProfile].join('|')
    : [row.scenario, row.sensorProfile].join('|');
  if (!comparisonKeys.has(key)) {
    comparisonKeys.set(key, {
      scenario: row.scenario,
      movementModel: row.movementModel,
      swimmerCount: row.swimmerCount ?? row.finalTruthCount,
      sensorProfile: row.sensorProfile,
    });
  }
}
for (const dims of comparisonKeys.values()) {
    const sameDims = row => {
      if (row.sensorProfile !== dims.sensorProfile) return false;
      if (!usesPopulationDimensions) return row.scenario === dims.scenario;
      return (row.movementModel ?? row.scenario) === (dims.movementModel ?? dims.scenario)
        && (row.swimmerCount ?? row.finalTruthCount) === dims.swimmerCount;
    };
    const candidateRows = rows.filter(row => sameDims(row) && row.strategy === proposedStrategy);
    if (candidateRows.length === 0) continue;
    const candidateBySeed = new Map(candidateRows.map(row => [row.seed, row]));
    const baselines = [...new Set(rows
      .filter(row => sameDims(row) && row.strategy !== proposedStrategy)
      .map(row => row.strategy))];
    for (const baselineStrategy of baselines) {
      const baselineBySeed = new Map(rows
        .filter(row => sameDims(row) && row.strategy === baselineStrategy)
        .map(row => [row.seed, row]));
      const seeds = [...candidateBySeed.keys()].filter(seed => baselineBySeed.has(seed)).sort((a, b) => a - b);
      const comparison = {
        scenario: dims.scenario,
        movementModel: dims.movementModel,
        swimmerCount: dims.swimmerCount,
        sensorProfile: dims.sensorProfile,
        candidateStrategy: proposedStrategy,
        baselineStrategy,
        pairedSeeds: seeds,
        metrics: {},
      };
      for (const metric of pairedMetrics) {
        const differences = seeds.map(seed => {
          const candidate = candidateBySeed.get(seed);
          const baseline = baselineBySeed.get(seed);
          return metricValue(candidate, metric) - metricValue(baseline, metric);
        }).filter(Number.isFinite);
        const differenceStd = std(differences);
        comparison.metrics[metric] = {
          candidateMinusBaselineMean: mean(differences),
          pairedStd: differenceStd,
          pairedCi95: differences.length > 1 ? 1.96 * differenceStd / Math.sqrt(differences.length) : 0,
          cohenDz: differenceStd > 0 ? mean(differences) / differenceStd : 0,
          n: differences.length,
        };
      }
      pairedComparisons.push(comparison);
    }
}

const summary = {
  outputLabel: 'synthetic-uncalibrated',
  source: runsPath,
  generatedAt: new Date().toISOString(),
  table,
  rankings,
  pairedComparisons,
};

writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(outputPath);
