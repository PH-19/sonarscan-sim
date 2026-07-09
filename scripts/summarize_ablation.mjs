import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: node scripts/summarize_ablation.mjs <benchmark-output-dir|runs.jsonl> [output-dir]');
  process.exit(2);
}

const inputPath = path.resolve(process.cwd(), inputArg);
const inputStat = statSync(inputPath);
const inputDir = inputStat.isDirectory() ? inputPath : path.dirname(inputPath);
const runsPath = inputStat.isDirectory() ? path.join(inputPath, 'runs.jsonl') : inputPath;
const samplesPath = path.join(inputDir, 'samples.jsonl');
const manifestPath = path.join(inputDir, 'manifest.json');
const outputDir = path.resolve(process.cwd(), process.argv[3] ?? path.join(inputDir, 'ablation-summary'));

const v2AblationComponents = new Map([
  ['BELIEF_PSO_NO_COVERAGE', 'Coverage debt and coverage-aware reserve search'],
  ['BELIEF_PSO_NO_UNCERTAINTY', 'Uncertainty-aware urgency, ROI, and range'],
  ['BELIEF_PSO_FIXED_RANGE', 'Adaptive range'],
  ['BELIEF_PSO_NO_PSO', 'Conditional PSO assignment refinement'],
]);
const v3AblationComponents = new Map([
  ['BELIEF_PSO_V3_NO_COVERAGE', 'Coverage debt and coverage-aware reserve search'],
  ['BELIEF_PSO_V3_NO_UNCERTAINTY', 'Uncertainty-aware urgency, ROI, and range'],
  ['BELIEF_PSO_V3_FIXED_RANGE', 'Adaptive range'],
  ['BELIEF_PSO_V3_NO_PSO', 'Conditional PSO assignment refinement'],
  ['BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR', 'Constrained assignment repair and load/revisit penalties'],
  ['BELIEF_PSO_V3_NO_REDUNDANT_TRACKING', 'Redundant tracking on otherwise idle sonars'],
  ['BELIEF_PSO_V3_NO_RESERVE_SEARCH', 'Reserve search holdout for coverage debt'],
]);

const metrics = [
  'avgAoISec',
  'avgScanRateHz',
  'trackingRate',
  'localTrackAccuracy',
  'trackContinuity',
  'idSwitches',
  'trackFragmentations',
  'gospa',
  'gospaLocalization',
  'gospaMissed',
  'gospaFalse',
  'precision',
  'recall',
  'f1',
  'beamRateHz',
  'sonarBusyRatio',
  'trackRoiCommandRatio',
  'searchCommandRatio',
  'decisionLatencyP95Ms',
];

const readJsonl = async filePath => {
  const rows = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
};

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const std = values => {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};

const finite = value => Number.isFinite(value);
const display = value => finite(value) ? Number(value).toFixed(3) : '';
const displaySigned = value => {
  if (!finite(value)) return '';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(3)}`;
};
const displayPercent = value => finite(value) ? `${(Number(value) * 100).toFixed(1)}%` : '';

const metricValue = (row, metric) => {
  const evalMetrics = row.aggregateMetrics ?? row.finalMetrics ?? {};
  if (finite(evalMetrics[metric])) return evalMetrics[metric];
  const commandMetrics = row.commandMetrics ?? {};
  if (finite(commandMetrics[metric])) return commandMetrics[metric];
  return Number.NaN;
};

const dimensionOf = row => {
  const movementModel = row.movementModel;
  const swimmerCount = row.swimmerCount ?? (movementModel ? row.finalTruthCount : undefined);
  return {
    scenario: row.scenario,
    movementModel,
    swimmerCount,
    sensorProfile: row.sensorProfile,
    label: movementModel ? `${movementModel}_${swimmerCount}` : row.scenario,
  };
};

const dimensionKey = dims => [
  dims.movementModel ?? dims.scenario,
  dims.swimmerCount ?? '',
  dims.sensorProfile,
].join('|');

const pairedStats = differences => {
  const values = differences.filter(finite);
  const s = std(values);
  return {
    mean: mean(values),
    std: s,
    ci95: values.length > 1 ? 1.96 * s / Math.sqrt(values.length) : 0,
    cohenDz: s > 0 ? mean(values) / s : 0,
    n: values.length,
  };
};

const csvCell = value => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const writeCsv = (filePath, rows) => {
  writeFileSync(filePath, `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`);
};

const shortComponentName = row => ({
  BELIEF_PSO_NO_COVERAGE: 'Coverage',
  BELIEF_PSO_NO_UNCERTAINTY: 'Uncertainty',
  BELIEF_PSO_FIXED_RANGE: 'Range',
  BELIEF_PSO_NO_PSO: 'PSO',
  BELIEF_PSO_V3_NO_COVERAGE: 'Coverage',
  BELIEF_PSO_V3_NO_UNCERTAINTY: 'Uncertainty',
  BELIEF_PSO_V3_FIXED_RANGE: 'Range',
  BELIEF_PSO_V3_NO_PSO: 'PSO',
  BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR: 'ConstrainedRepair',
  BELIEF_PSO_V3_NO_REDUNDANT_TRACKING: 'RedundantTracking',
  BELIEF_PSO_V3_NO_RESERVE_SEARCH: 'ReserveSearch',
})[row.ablationStrategy] ?? row.ablationStrategy;

const runs = await readJsonl(runsPath);
const strategyNames = new Set(runs.map(row => row.strategy));
const proposedStrategy = strategyNames.has('BELIEF_PSO_V3') ? 'BELIEF_PSO_V3' : 'BELIEF_PSO_V2';
const ablationComponents = strategyNames.has('BELIEF_PSO_V3') ? v3AblationComponents : v2AblationComponents;
const componentRank = new Map([...ablationComponents.keys()].map((strategy, index) => [strategy, index]));
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : undefined;
const config = manifest?.config ?? {};
if (runs.some(row => row.outputLabel !== 'synthetic-uncalibrated')) {
  throw new Error('Ablation summary only accepts synthetic-uncalibrated benchmark rows');
}

const groups = new Map();
for (const row of runs) {
  const dims = dimensionOf(row);
  const key = `${dimensionKey(dims)}|${row.strategy}`;
  const group = groups.get(key) ?? { ...dims, strategy: row.strategy, rows: [] };
  group.rows.push(row);
  groups.set(key, group);
}

const componentAblations = [];
for (const group of groups.values()) {
  if (group.strategy !== proposedStrategy) continue;
  const proposedBySeed = new Map(group.rows.map(row => [row.seed, row]));
  for (const [ablationStrategy, removedComponent] of ablationComponents) {
    const baseline = groups.get(`${dimensionKey(group)}|${ablationStrategy}`);
    if (!baseline) continue;
    const baselineBySeed = new Map(baseline.rows.map(row => [row.seed, row]));
    const pairedSeeds = [...proposedBySeed.keys()]
      .filter(seed => baselineBySeed.has(seed))
      .sort((a, b) => a - b);
    const row = {
      scenario: group.scenario,
      movementModel: group.movementModel,
      swimmerCount: group.swimmerCount,
      dimension: group.label,
      sensorProfile: group.sensorProfile,
      proposedStrategy,
      ablationStrategy,
      removedComponent,
      pairedSeeds,
      metrics: {},
    };
    for (const metric of metrics) {
      row.metrics[metric] = pairedStats(pairedSeeds.map(seed => (
        metricValue(proposedBySeed.get(seed), metric) - metricValue(baselineBySeed.get(seed), metric)
      )));
    }
    componentAblations.push(row);
  }
}

const psoExposureByKey = new Map();
try {
  const rl = readline.createInterface({
    input: createReadStream(samplesPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const sample = JSON.parse(line);
    if (sample.warmup) continue;
    const dims = dimensionOf(sample);
    const key = `${dimensionKey(dims)}|${sample.strategy}`;
    const current = psoExposureByKey.get(key) ?? {
      ...dims,
      strategy: sample.strategy,
      decisionCount: 0,
      psoEnabledCount: 0,
      psoEligibleCount: 0,
      psoAcceptedCount: 0,
      psoChangedCount: 0,
      acceptedCostImprovements: [],
      rejectionReasons: new Map(),
    };
    for (const decision of sample.strategyDecisions ?? []) {
      const diagnostics = decision.diagnostics;
      if (!diagnostics) continue;
      current.decisionCount += 1;
      if (diagnostics.psoEnabled) current.psoEnabledCount += 1;
      if (diagnostics.psoEligible) current.psoEligibleCount += 1;
      if (diagnostics.psoAccepted) current.psoAcceptedCount += 1;
      if (diagnostics.psoChangedAssignment) current.psoChangedCount += 1;
      if (finite(diagnostics.acceptedCostImprovement)) {
        current.acceptedCostImprovements.push(diagnostics.acceptedCostImprovement);
      }
      const reason = diagnostics.rejectionReason ?? 'accepted';
      current.rejectionReasons.set(reason, (current.rejectionReasons.get(reason) ?? 0) + 1);
    }
    psoExposureByKey.set(key, current);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const noPsoDeltaByDimension = new Map();
for (const row of componentAblations) {
  if (row.ablationStrategy !== [...ablationComponents.keys()].find(strategy => strategy.endsWith('NO_PSO'))) continue;
  noPsoDeltaByDimension.set(dimensionKey(row), {
    avgAoISec: row.metrics.avgAoISec,
    avgScanRateHz: row.metrics.avgScanRateHz,
    localTrackAccuracy: row.metrics.localTrackAccuracy,
    trackingRate: row.metrics.trackingRate,
    gospa: row.metrics.gospa,
    decisionLatencyP95Ms: row.metrics.decisionLatencyP95Ms,
  });
}

const psoExposure = [...psoExposureByKey.values()].filter(row => row.decisionCount > 0).map(row => {
  const eligibleDenominator = Math.max(1, row.decisionCount);
  const acceptedDenominator = Math.max(1, row.psoEligibleCount);
  const rejectionReasons = Object.fromEntries([...row.rejectionReasons.entries()].sort());
  const noPsoDelta = noPsoDeltaByDimension.get(dimensionKey(row));
  const eligibleRate = row.psoEligibleCount / eligibleDenominator;
  return {
    scenario: row.scenario,
    movementModel: row.movementModel,
    swimmerCount: row.swimmerCount,
    dimension: row.label,
    sensorProfile: row.sensorProfile,
    strategy: row.strategy,
    decisionCount: row.decisionCount,
    psoEnabledCount: row.psoEnabledCount,
    psoEligibleCount: row.psoEligibleCount,
    psoAcceptedCount: row.psoAcceptedCount,
    psoChangedCount: row.psoChangedCount,
    psoEnabledRate: row.psoEnabledCount / eligibleDenominator,
    psoEligibleRate: eligibleRate,
    psoAcceptedRate: row.psoAcceptedCount / acceptedDenominator,
    psoChangedRate: row.psoChangedCount / acceptedDenominator,
    meanAcceptedCostImprovement: mean(row.acceptedCostImprovements),
    rejectionReasons,
    psoContributionStatus: eligibleRate < 0.05 ? 'inconclusive_low_trigger' : 'measurable',
    noPsoDelta,
  };
}).sort((a, b) => `${a.dimension}|${a.strategy}`.localeCompare(`${b.dimension}|${b.strategy}`));

mkdirSync(outputDir, { recursive: true });
const chartDir = path.join(outputDir, 'charts');
mkdirSync(chartDir, { recursive: true });

const sortedComponentAblations = [...componentAblations]
  .sort((a, b) => (
    a.dimension.localeCompare(b.dimension)
    || ((componentRank.get(a.ablationStrategy) ?? 999) - (componentRank.get(b.ablationStrategy) ?? 999))
    || shortComponentName(a).localeCompare(shortComponentName(b))
  ));

const summaryJsonPath = path.join(outputDir, 'ablation_summary.json');
writeFileSync(summaryJsonPath, `${JSON.stringify({
  outputLabel: 'synthetic-uncalibrated',
  source: { runsPath, samplesPath },
  generatedAt: new Date().toISOString(),
  componentAblations,
  psoExposure,
}, null, 2)}\n`);

const matplotlibConfigDir = path.join(outputDir, '.matplotlib');
mkdirSync(matplotlibConfigDir, { recursive: true });
const plotResult = spawnSync('python3', [
  path.join('scripts', 'plot_ablation_charts.py'),
  summaryJsonPath,
  chartDir,
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
  throw new Error(`matplotlib ablation chart generation failed:\n${plotResult.stdout}\n${plotResult.stderr}`);
}

writeCsv(path.join(outputDir, 'component_ablation.csv'), [
  ['dimension', 'scenario', 'movement_model', 'swimmer_count', 'removed_component', 'ablation_strategy', 'metric', 'n', 'proposed_minus_ablation', 'paired_ci95', 'cohen_dz'],
  ...componentAblations.flatMap(row => metrics.map(metric => [
    row.dimension,
    row.scenario,
    row.movementModel ?? '',
    row.swimmerCount ?? '',
    row.removedComponent,
    row.ablationStrategy,
    metric,
    row.metrics[metric].n,
    row.metrics[metric].mean,
    row.metrics[metric].ci95,
    row.metrics[metric].cohenDz,
  ])),
]);

writeCsv(path.join(outputDir, 'pso_exposure.csv'), [
  ['dimension', 'scenario', 'movement_model', 'swimmer_count', 'strategy', 'decision_count', 'pso_enabled_count', 'pso_eligible_count', 'pso_accepted_count', 'pso_changed_count', 'pso_enabled_rate', 'pso_eligible_rate', 'pso_accepted_rate', 'pso_changed_rate', 'mean_accepted_cost_improvement', 'status', 'rejection_reasons_json', 'no_pso_delta_local_tracking_accuracy', 'no_pso_delta_interval_sec', 'no_pso_delta_scanned_rate_hz'],
  ...psoExposure.map(row => [
    row.dimension,
    row.scenario,
    row.movementModel ?? '',
    row.swimmerCount ?? '',
    row.strategy,
    row.decisionCount,
    row.psoEnabledCount,
    row.psoEligibleCount,
    row.psoAcceptedCount,
    row.psoChangedCount,
    row.psoEnabledRate,
    row.psoEligibleRate,
    row.psoAcceptedRate,
    row.psoChangedRate,
    row.meanAcceptedCostImprovement,
    row.psoContributionStatus,
    JSON.stringify(row.rejectionReasons),
    row.noPsoDelta?.localTrackAccuracy?.mean ?? '',
    row.noPsoDelta?.avgAoISec?.mean ?? '',
    row.noPsoDelta?.avgScanRateHz?.mean ?? '',
  ]),
]);

const uniqueDimensions = [...new Set(componentAblations.map(row => row.dimension))].sort();
const uniqueSeeds = [...new Set(runs.map(row => row.seed))].sort((a, b) => a - b);
const configuredDurationSec = config.durationSec ?? '';
const configuredWarmupSec = config.warmupSec ?? '';
const configuredSonarCount = config.sonarCount ?? [...new Set(runs.map(row => row.sonarCount).filter(finite))][0] ?? '';
const configuredTdma = config.tdmaEnabled ?? '';
const isPreliminaryQuickRun = (finite(configuredDurationSec) && configuredDurationSec < 300) || uniqueSeeds.length < 20;
const strongestAoiImprovements = [...componentAblations]
  .filter(row => finite(row.metrics.avgAoISec.mean) && row.metrics.avgAoISec.mean < 0)
  .sort((a, b) => a.metrics.avgAoISec.mean - b.metrics.avgAoISec.mean)
  .slice(0, 3);
const strongestAoiRegressions = [...componentAblations]
  .filter(row => finite(row.metrics.avgAoISec.mean) && row.metrics.avgAoISec.mean > 0)
  .sort((a, b) => b.metrics.avgAoISec.mean - a.metrics.avgAoISec.mean)
  .slice(0, 3);
const strongestTrackingImprovements = [...componentAblations]
  .filter(row => finite(row.metrics.localTrackAccuracy.mean) && row.metrics.localTrackAccuracy.mean > 0)
  .sort((a, b) => b.metrics.localTrackAccuracy.mean - a.metrics.localTrackAccuracy.mean)
  .slice(0, 3);
const strongestScanRateImprovements = [...componentAblations]
  .filter(row => finite(row.metrics.avgScanRateHz.mean) && row.metrics.avgScanRateHz.mean > 0)
  .sort((a, b) => b.metrics.avgScanRateHz.mean - a.metrics.avgScanRateHz.mean)
  .slice(0, 3);
const proposedPsoExposure = psoExposure.filter(row => row.strategy === proposedStrategy);
const measurablePsoExposure = proposedPsoExposure.filter(row => row.psoContributionStatus === 'measurable');
const maxPsoEligible = proposedPsoExposure.reduce(
  (best, row) => row.psoEligibleRate > (best?.psoEligibleRate ?? -Infinity) ? row : best,
  undefined,
);

const findingLine = row => {
  const trackingCi = row.metrics.localTrackAccuracy.ci95;
  const intervalCi = row.metrics.avgAoISec.ci95;
  const scanRateCi = row.metrics.avgScanRateHz.ci95;
  return `- ${row.dimension}, ${shortComponentName(row)} removed: dTracking ${displaySigned(row.metrics.localTrackAccuracy.mean)} +/- ${display(trackingCi)}, dInterval ${displaySigned(row.metrics.avgAoISec.mean)} +/- ${display(intervalCi)}s, dScannedRate ${displaySigned(row.metrics.avgScanRateHz.mean)} +/- ${display(scanRateCi)}Hz.`;
};

const reportPath = path.join(outputDir, 'ablation_report.md');
const md = [
  '# Proposed V3 Ablation Summary',
  '',
  '> Synthetic uncalibrated simulator output only. Do not present as real-world Ping360 performance.',
  '',
  '## Technical summary',
  '',
  `This report compares \`${proposedStrategy}\` against its isolating ablations across ${uniqueDimensions.length} benchmark dimensions and ${uniqueSeeds.length} paired seeds where available. Metric signs use \`${proposedStrategy} - ablation\`; positive local tracking accuracy and avg scanned rate deltas are better, while negative interval deltas are better.`,
  isPreliminaryQuickRun
    ? ''
    : '',
  isPreliminaryQuickRun
    ? `> **Preliminary quick-run report.** This output uses durationSec=${configuredDurationSec}, warmupSec=${configuredWarmupSec}, seeds=${uniqueSeeds.join(', ')}, sonarCount=${configuredSonarCount}, tdmaEnabled=${configuredTdma}. Treat signs and component ranking as early evidence; reserve paper-level claims for the full 20-seed, 300-second matrix.`
    : '',
  '',
  `- **Component contribution is read from paired deltas, not raw strategy means.** The component table and charts hold simulator setup, seed, sensor profile, and density fixed, then compare the full proposed method against each ablated variant.`,
  '- **The ablations are proposed-method mechanism tests.** `NO_PSO` removes assignment refinement, `NO_CONSTRAINED_REPAIR` removes load/revisit hardening while preserving basic visibility repair, `NO_REDUNDANT_TRACKING` stops empty sonars from duplicating confirmed tracks, and `NO_RESERVE_SEARCH` stops holding an idle sonar back for coverage search.',
  `- **Conditional PSO must be interpreted through exposure.** ${measurablePsoExposure.length} proposed-method dimensions had PSO eligible rates of at least 5%; dimensions below that threshold are marked inconclusive for PSO contribution even if the \`NO_PSO\` paired delta is nonzero.`,
  maxPsoEligible
    ? `- **Highest observed PSO exposure:** ${maxPsoEligible.dimension} reached ${displayPercent(maxPsoEligible.psoEligibleRate)} eligibility and ${displayPercent(maxPsoEligible.psoAcceptedRate)} acceptance among eligible decisions.`
    : '- **PSO exposure was not observable** because no sample decision diagnostics were available.',
  '',
  '## Key findings with visual evidence',
  '',
  'All figures are generated with matplotlib as grouped bar charts with error bars. Bars use paired deltas (`full - ablation`) over matched seeds.',
  '',
  '![Component contribution to local tracking accuracy](charts/component_local_tracking_accuracy_delta.png)',
  '',
  strongestTrackingImprovements.length
    ? `Strongest local-tracking component effects in this run:\n${strongestTrackingImprovements.map(findingLine).join('\n')}`
    : 'No finite local tracking accuracy component deltas were available.',
  '',
  '![Component contribution to scan interval](charts/component_interval_delta.png)',
  '',
  strongestAoiImprovements.length
    ? `Strongest interval-favoring component effects in this run:\n${strongestAoiImprovements.map(findingLine).join('\n')}`
    : 'No finite interval component deltas were available.',
  '',
  '![Component contribution to scanned rate](charts/component_scanned_rate_delta.png)',
  '',
  strongestScanRateImprovements.length
    ? `Strongest scanned-rate component effects in this run:\n${strongestScanRateImprovements.map(findingLine).join('\n')}`
    : 'No finite scanned-rate component deltas were available.',
  '',
  strongestAoiRegressions.length
    ? `Largest interval regressions for the full method versus an ablation:\n${strongestAoiRegressions.map(findingLine).join('\n')}`
    : 'No finite AoI regressions were available.',
  '',
  'The PSO exposure chart determines whether the `NO_PSO` paired delta is interpretable as evidence about the conditional PSO refinement. Low exposure means the trigger rarely fired, so the comparison mostly reflects identical fast-scheduler behavior.',
  '',
  '![Conditional PSO exposure](charts/pso_exposure.png)',
  '',
  '## Component ablation table',
  '',
  '| Dimension | Removed component | n | dTrackingAcc | dInterval | dScannedRate | dTrackingRate | dBeamRate |',
  '|---|---|---:|---:|---:|---:|---:|---:|',
  ...sortedComponentAblations.map(row => `| ${row.dimension} | ${row.removedComponent} | ${row.metrics.avgAoISec.n} | ${displaySigned(row.metrics.localTrackAccuracy.mean)} +/- ${display(row.metrics.localTrackAccuracy.ci95)} | ${displaySigned(row.metrics.avgAoISec.mean)} +/- ${display(row.metrics.avgAoISec.ci95)} | ${displaySigned(row.metrics.avgScanRateHz.mean)} +/- ${display(row.metrics.avgScanRateHz.ci95)} | ${displaySigned(row.metrics.trackingRate.mean)} | ${displaySigned(row.metrics.beamRateHz.mean)} |`),
  '',
  '## PSO exposure table',
  '',
  '| Dimension | Strategy | Decisions | Eligible rate | Accepted rate | Changed rate | Mean accepted cost improvement | Status | dTracking vs NO_PSO | dInterval vs NO_PSO | dScannedRate vs NO_PSO |',
  '|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|',
  ...psoExposure
    .filter(row => row.strategy === proposedStrategy)
    .map(row => `| ${row.dimension} | ${row.strategy} | ${row.decisionCount} | ${displayPercent(row.psoEligibleRate)} | ${displayPercent(row.psoAcceptedRate)} | ${displayPercent(row.psoChangedRate)} | ${display(row.meanAcceptedCostImprovement)} | ${row.psoContributionStatus} | ${displaySigned(row.noPsoDelta?.localTrackAccuracy?.mean)} | ${displaySigned(row.noPsoDelta?.avgAoISec?.mean)} | ${displaySigned(row.noPsoDelta?.avgScanRateHz?.mean)} |`),
  '',
  '## Scope, data, and metric definitions',
  '',
  `The report reads \`${path.basename(runsPath)}\` for run-level aggregate metrics and \`${path.basename(samplesPath)}\` for post-warmup planner diagnostics. Dimensions are named benchmark scenarios or population-sweep movement/count pairs. Paired effects use matched seeds only.`,
  `Run configuration: durationSec=${configuredDurationSec}, warmupSec=${configuredWarmupSec}, sonarCount=${configuredSonarCount}, tdmaEnabled=${configuredTdma}, seeds=${uniqueSeeds.join(', ')}.`,
  '',
  '- `localTrackAccuracy`: handoff-tolerant scan-level correct track IDs divided by visible-swimmer scan opportunities; higher is better.',
  '- `avgAoISec`: post-warmup average per-swimmer scan interval; lower is better.',
  '- `avgScanRateHz`: post-warmup per-swimmer scanned/detected update rate; higher is better.',
  '- `trackingRate`: confirmed tracking availability; higher is better.',
  '- `beamRateHz`, `sonarBusyRatio`, command ratios, and `decisionLatencyP95Ms`: scanning workload and online planning cost.',
  '- PSO exposure rates are computed from post-warmup `StrategyDecision.diagnostics` records in `samples.jsonl`.',
  '',
  '## Methodology and robustness checks',
  '',
  `Each component row reports the paired mean of \`${proposedStrategy} - ablation\` over shared seeds, with a normal-approximation 95% confidence interval half-width and Cohen dz in the CSV/JSON artifacts. The proposed method is the current belief-aware constrained PSO implementation: confirmed Kalman tracks are assigned through seeded PSO with feasibility repair, then converted into covariance-aware ROI plus search/duplicate-tracking commands.`,
  '',
  'Robustness checks included in the report outputs:',
  '',
  '- `component_ablation.csv` preserves every metric delta, CI, and effect size used by the report.',
  '- `pso_exposure.csv` records eligible, accepted, and changed-assignment rates plus rejection-reason counts.',
  '- `ablation_summary.json` preserves the structured report input for audit and downstream plotting.',
  '',
  '## Limitations and recommended next steps',
  '',
  '- Results are synthetic and uncalibrated; they support simulator-method diagnosis, not real-world performance claims.',
  isPreliminaryQuickRun
    ? '- This is a reduced quick run; confidence intervals are wider and short-horizon behavior can differ from the full 300-second benchmark.'
    : null,
  '- PSO contribution is inconclusive wherever eligible rate is below 5%, because the full method and `NO_PSO` mostly execute the same fast scheduler.',
  '- For paper use, run the full 20-seed config before interpreting the charts; short smoke outputs are only format checks.',
  '- After running the full matrix, inspect high-density random-reflect rows where local tracking improves but interval regresses, because those cases indicate the central tracking/freshness tradeoff.',
  '',
  '## Further questions',
  '',
  '- Should the PSO trigger be widened beyond lane-like high-density states, or is the current trigger intentionally conservative for latency and stability?',
  '- In rows where a component improves interval but lowers local tracking accuracy, is the failure driven by missed tracks, false tracks, or identity fragmentation?',
  '- Does enabling TDMA in the same matrix change component ranking, especially adaptive range and PSO assignment refinement?',
];
writeFileSync(reportPath, `${md.join('\n')}\n`);

console.log(outputDir);
