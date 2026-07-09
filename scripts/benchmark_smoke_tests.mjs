import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const cwd = process.cwd().replaceAll('\\\\', '/');
const modulePath = (relativePath) => JSON.stringify(`${cwd}/${relativePath}`);
const outputDir = JSON.stringify(await mkdtemp(path.join(tmpdir(), 'sonarscan-benchmark-smoke-out-')));
const shortWindowDir = JSON.stringify(await mkdtemp(path.join(tmpdir(), 'sonarscan-window-short-')));
const longWindowDir = JSON.stringify(await mkdtemp(path.join(tmpdir(), 'sonarscan-window-long-')));
const populationOutputDir = JSON.stringify(await mkdtemp(path.join(tmpdir(), 'sonarscan-population-smoke-out-')));
const populationReportDir = JSON.stringify(await mkdtemp(path.join(tmpdir(), 'sonarscan-population-report-')));
const repoRoot = JSON.stringify(cwd);

const testEntry = `
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HeadlessRunner } from ${modulePath('services/sim/headless/HeadlessRunner.ts')};
import { SimulationEngine } from ${modulePath('services/SimulationEngine.ts')};
import { makeBenchmarkScenario, makePopulationBenchmarkScenario } from ${modulePath('services/sim/benchmark/ScenarioFactory.ts')};
import { BASELINE_REGISTRY } from ${modulePath('services/sim/benchmark/BaselineRegistry.ts')};
import { resetEngineToBenchmarkScenario } from ${modulePath('services/sim/benchmark/ScenarioRuntime.ts')};
import { resolveUiBenchmarkSetup } from ${modulePath('services/sim/benchmark/UiBenchmarkSetup.ts')};
import { planUiStrategyDecision, usesPythonStrategyService } from ${modulePath('services/sim/strategy/UiStrategyPlanner.ts')};

const repoRoot = ${repoRoot};

const speedOf = swimmer => Math.hypot(swimmer.velocity.x, swimmer.velocity.y);
const randomScenario = makePopulationBenchmarkScenario('random_reflect', 8, 42, 0.15);
assert.deepEqual(
  randomScenario,
  makePopulationBenchmarkScenario('random_reflect', 8, 42, 0.15),
  'population scenarios must be deterministic for the same seed'
);
assert.equal(randomScenario.initialSwimmers.length, 8, 'random_reflect scenario should generate the requested swimmer count');
assert.ok(
  new Set(randomScenario.initialSwimmers.map(swimmer => speedOf(swimmer).toFixed(3))).size > 1,
  'random_reflect swimmers should not all use the same speed'
);
assert.ok(
  new Set(randomScenario.initialSwimmers.map(swimmer => Math.atan2(swimmer.velocity.y, swimmer.velocity.x).toFixed(2))).size > 4,
  'random_reflect swimmers should keep diverse initial headings'
);
const routeHeadings = [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4, -Math.PI / 4, (-3 * Math.PI) / 4];
const angularDistance = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
const routeAlignedCount = randomScenario.initialSwimmers.filter(swimmer => {
  const heading = Math.atan2(swimmer.velocity.y, swimmer.velocity.x);
  return Math.min(...routeHeadings.map(route => angularDistance(heading, route))) <= 25 * Math.PI / 180;
}).length;
assert.ok(
  routeAlignedCount >= Math.ceil(randomScenario.initialSwimmers.length * 0.75),
  'random_reflect initial headings should be route-oriented instead of uniformly arbitrary'
);
const randomManeuverEngine = new SimulationEngine({ strategy: 'FULL_SCAN', evalSeed: 123 });
randomManeuverEngine.reset();
randomManeuverEngine.addSwimmer({
  id: 'FREE_REFLECT_STABLE',
  position: { x: 10, y: 25 },
  velocity: { x: 0.2, y: 0.1 },
  enteredAt: 0,
  motion: { kind: 'free_reflect' },
});
const initialFreeHeading = Math.atan2(0.1, 0.2);
for (let step = 0; step < 300; step += 1) randomManeuverEngine.update(0.1, { autoSchedule: false });
const freeReflectSwimmer = randomManeuverEngine.swimmers[0];
const finalFreeHeading = Math.atan2(freeReflectSwimmer.velocity.y, freeReflectSwimmer.velocity.x);
const headingDeltaDeg = Math.abs(((finalFreeHeading - initialFreeHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
assert.ok(headingDeltaDeg < 15, 'free_reflect maneuver should add only mild live heading drift over 30s when no boundary is hit');

const lapScenario = makePopulationBenchmarkScenario('lap_swim_with_rest', 8, 42, 0.15);
assert.equal(lapScenario.initialSwimmers.length, 8, 'lap_swim_with_rest scenario should generate the requested swimmer count');
assert.equal(lapScenario.restingSwimmerCount, 1, 'N=8 lap swim scenario should include one resting swimmer at the default rest fraction');
const restingSwimmers = lapScenario.initialSwimmers.filter(swimmer => speedOf(swimmer) <= 0.05);
assert.equal(restingSwimmers.length, 1, 'resting lap swimmers should be stationary or near-stationary');
assert.ok(restingSwimmers.every(swimmer => swimmer.motion?.kind === 'short_end_rest'), 'resting lap swimmers should carry a short_end_rest motion profile');
assert.ok(
  restingSwimmers.every(swimmer => swimmer.position.y <= 1.5 || swimmer.position.y >= 48.5),
  'resting lap swimmers should stay near one of the two short ends'
);
const activeLapSwimmers = lapScenario.initialSwimmers.filter(swimmer => speedOf(swimmer) > 0.05);
assert.ok(activeLapSwimmers.every(swimmer => swimmer.motion?.kind === 'lane_swim'), 'active lap swimmers should carry a lane_swim motion profile');
assert.ok(
  activeLapSwimmers.every(swimmer => Math.abs(swimmer.velocity.y) > Math.abs(swimmer.velocity.x) * 5),
  'active lap swimmers should move primarily along the pool length'
);
const laneEngine = new SimulationEngine({ strategy: 'FULL_SCAN', evalSeed: 42 });
laneEngine.reset();
for (const swimmer of lapScenario.initialSwimmers) laneEngine.addSwimmer(swimmer);
for (let step = 0; step < 300; step += 1) laneEngine.update(0.1, { autoSchedule: false });
const afterLaneUpdate = laneEngine.swimmers;
const afterResting = afterLaneUpdate.filter(swimmer => swimmer.motion?.kind === 'short_end_rest');
assert.equal(afterResting.length, restingSwimmers.length, 'resting motion profiles should survive world updates');
assert.ok(afterResting.every(swimmer => speedOf(swimmer) <= 0.001), 'short-end resting swimmers should remain stationary after world updates');
assert.ok(
  afterResting.every(swimmer => swimmer.position.y <= 1.5 || swimmer.position.y >= 48.5),
  'short-end resting swimmers should remain near the short ends after world updates'
);
const afterActive = afterLaneUpdate.filter(swimmer => swimmer.motion?.kind === 'lane_swim');
assert.ok(
  afterActive.every(swimmer => Math.abs(swimmer.velocity.y) > Math.abs(swimmer.velocity.x) * 3),
  'lane swimmers should remain lengthwise-dominant after world updates'
);
assert.ok(
  afterActive.every(swimmer => Math.abs(swimmer.position.x - swimmer.motion.laneX) <= 0.75),
  'lane swimmers should stay close to their assigned lane center after world updates'
);

const uiSetup = resolveUiBenchmarkSetup({}, {
  scenario: 'two_swimmers_crossing',
  seed: '1',
  baseline: 'FULL_SCAN',
  candidate: 'ROUND_ROBIN_SECTOR',
  sensorProfile: 'synthetic_clean_v0',
  dtSec: '0.1',
  sampleIntervalSec: '1',
  strategyUpdateIntervalSec: '0.8',
  metricsWindowSec: '10',
  sonarCount: '4',
});
assert.equal(uiSetup.scenario.name, 'two_swimmers_crossing', 'UI repro setup should select the same named benchmark scenario');
assert.deepEqual(
  uiSetup.scenario,
  makeBenchmarkScenario('two_swimmers_crossing', 1),
  'UI repro scenario must be generated by the benchmark ScenarioFactory'
);
assert.equal(uiSetup.config.sensorProfile, 'synthetic_clean_v0', 'UI repro should honor benchmark sensorProfile');
assert.equal(uiSetup.config.dtSec, 0.1, 'UI repro should honor benchmark fixed dt');
assert.equal(uiSetup.config.tdmaEnabled, false, 'UI repro should disable TDMA by default');
assert.equal(usesPythonStrategyService('FULL_SCAN'), false, 'FULL_SCAN should use the in-browser CLI baseline registry');
assert.equal(usesPythonStrategyService('BELIEF_PSO_V2'), true, 'BELIEF_PSO_V2 should use the Python strategy implementation');
assert.equal(usesPythonStrategyService('BELIEF_PSO_V3'), true, 'BELIEF_PSO_V3 should use the Python strategy implementation');

const uiEngine = new SimulationEngine({
  strategy: uiSetup.candidateStrategy,
  evalSeed: uiSetup.seed,
  sonarCount: uiSetup.config.sonarCount,
});
resetEngineToBenchmarkScenario(uiEngine, uiSetup.scenario, uiSetup.sensorParams);
assert.deepEqual(
  uiEngine.swimmers.map(swimmer => ({ id: swimmer.id, position: swimmer.position, velocity: swimmer.velocity })),
  uiSetup.scenario.initialSwimmers.map(swimmer => ({ id: swimmer.id, position: swimmer.position, velocity: swimmer.velocity })),
  'UI repro reset should install the exact benchmark initial swimmer states'
);
const uiSnapshot = uiEngine.getStrategySnapshot();
assert.equal(uiSnapshot.physics.maxRange, 20, 'UI repro should expose the default 20m scan range to benchmark strategies');
assert.equal(uiSnapshot.physics.tdmaSlotCount, 1, 'UI repro should expose non-TDMA timing by default');
assert.deepEqual(
  await planUiStrategyDecision('ROUND_ROBIN_SECTOR', uiSnapshot),
  BASELINE_REGISTRY.ROUND_ROBIN_SECTOR(uiSnapshot, 'ROUND_ROBIN_SECTOR'),
  'UI baseline planning must call the same TypeScript BaselineRegistry implementation as CLI headless'
);

const result = await new HeadlessRunner().run({
  benchmarkId: 'stage5a_baseline_effect_smoke',
  outputLabel: 'synthetic-uncalibrated',
  scenario: 'two_swimmers_crossing',
  durationSec: 300,
  seed: 1,
  strategies: ['FULL_SCAN', 'ROUND_ROBIN_SECTOR', 'BELIEF_PSO_V3'],
  sensorProfile: 'synthetic_default_v0',
  dtSec: 0.1,
  sampleIntervalSec: 1,
  strategyUpdateIntervalSec: 0.8,
  metricsWindowSec: 10,
  outputDir: ${outputDir},
}, {
  gitCommit: 'smoke-test',
  gitDirty: true,
  gitStatusShort: 'smoke-test',
});

assert.equal(result.runCount, 3, 'benchmark smoke should run FULL_SCAN, ROUND_ROBIN_SECTOR, and Python BELIEF_PSO_V3');

const rows = readFileSync(result.samplePath, 'utf8')
  .trim()
  .split('\\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

assert.ok(rows.length > 0, 'benchmark smoke should write sample rows');
assert.ok(rows.every(row => row.outputLabel === 'synthetic-uncalibrated'), 'all rows must be synthetic-uncalibrated');
assert.ok(rows.every(row => row.tdmaEnabled === false), 'headless benchmarks should disable TDMA by default');

const commandsByStrategy = new Map();
for (const row of rows) {
  const commands = commandsByStrategy.get(row.strategy) ?? [];
  commands.push(...row.scanCommands);
  commandsByStrategy.set(row.strategy, commands);
}

const fullScanCommands = commandsByStrategy.get('FULL_SCAN') ?? [];
const searchCommands = commandsByStrategy.get('ROUND_ROBIN_SECTOR') ?? [];
const proposedCommands = commandsByStrategy.get('BELIEF_PSO_V3') ?? [];
assert.ok(fullScanCommands.length > 0, 'FULL_SCAN should emit scan commands');
assert.ok(fullScanCommands.every(command => command.pingSlotCount === 1), 'default headless FULL_SCAN commands should run without TDMA slot multiplication');
assert.ok(searchCommands.length > 0, 'ROUND_ROBIN_SECTOR should emit scan commands');
assert.ok(proposedCommands.length > 0, 'BELIEF_PSO_V3 should emit scan commands');

const fullScanIsFullWidth = fullScanCommands.some(function(command) {
  return Math.abs(command.endLocalAngle - command.scanStartLocalAngle) >= 179.5 && command.range >= 19.5 && command.pingSlotCount === 1;
});
assert.equal(fullScanIsFullWidth, true, 'FULL_SCAN should produce full sector / default 20m non-TDMA commands');

const totalDetections = rows.reduce(function(sum, row) { return sum + row.detectionCount; }, 0);
assert.ok(totalDetections > 0, 'benchmark smoke should produce detections');

const searchCommand = searchCommands.find(command =>
  Math.abs(command.endLocalAngle - command.scanStartLocalAngle) < 179.5 || command.range < 49.5
);
assert.ok(searchCommand, 'ROUND_ROBIN_SECTOR should always produce a narrowed search command');

const proposedRoiCommand = proposedCommands.find(command => command.action === 'TRACK_ROI');
assert.ok(proposedRoiCommand, 'BELIEF_PSO_V3 should produce at least one TRACK_ROI command after tracks exist');
assert.ok(proposedCommands.some(c => c.action === 'SEARCH_SECTOR' || c.action === 'TRACK_ROI'), 'BELIEF_PSO_V3 should use TRACK_ROI or SEARCH_SECTOR discovery actions');

const summaries = readFileSync(result.runSummaryPath, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
const proposedSummary = summaries.find(row => row.strategy === 'BELIEF_PSO_V3');
assert.ok(proposedSummary.strategyProviderInvocationCount > 0, 'headless BELIEF_PSO_V3 provider must be invoked');
assert.equal(Number.isFinite(proposedSummary.aggregateMetrics.strictTrackAccuracy), true, 'run summary should include scan-level ID tracking accuracy');
assert.equal(Number.isFinite(proposedSummary.aggregateMetrics.localTrackAccuracy), true, 'run summary should include local scan-level ID tracking accuracy');
assert.equal(Number.isFinite(proposedSummary.aggregateMetrics.strictIdentityTracks), true, 'run summary should include scan-level ID numerator');
assert.equal(Number.isFinite(proposedSummary.aggregateMetrics.localIdentityTracks), true, 'run summary should include local scan-level ID numerator');
assert.equal(Number.isFinite(proposedSummary.aggregateMetrics.identityTrackOpportunities), true, 'run summary should include scan-level ID denominator');
assert.equal(proposedSummary.strategyImplementation.implementationLanguage, 'python');
assert.equal(proposedSummary.strategyImplementation.implementation, 'strategies.proposed_v3:plan');
assert.equal(proposedSummary.strategyImplementation.parameters.iterations, 30);
assert.equal(
  proposedSummary.strategyImplementation.parameters.psoActivation,
  'allConfirmedTracksWithFeasibilityRepair',
  'BELIEF_PSO_V3 metadata should document constrained PSO activation'
);
assert.ok(proposedSummary.commandMetrics.strategyActivationTimeSec !== null);
assert.ok(proposedSummary.commandMetrics.trackRoiCommandRatio > 0);
assert.ok(proposedSummary.commandMetrics.beamRateHz > 0);

const proposedDecisionWithDiagnostics = rows
  .filter(row => row.strategy === 'BELIEF_PSO_V3')
  .flatMap(row => row.strategyDecisions ?? [])
  .find(decision => decision.diagnostics);
assert.ok(proposedDecisionWithDiagnostics, 'BELIEF_PSO_V3 sample decisions should include PSO diagnostics');
assert.equal(typeof proposedDecisionWithDiagnostics.diagnostics.psoEligible, 'boolean', 'PSO diagnostics should expose psoEligible');
assert.equal(typeof proposedDecisionWithDiagnostics.diagnostics.trackCount, 'number', 'PSO diagnostics should expose trackCount');

const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
assert.equal(manifest.outputLabel, 'synthetic-uncalibrated');
assert.equal(manifest.strategyImplementations.BELIEF_PSO_V3.implementationLanguage, 'python');
assert.match(manifest.strategyImplementations.BELIEF_PSO_V3.codeVersion, /^[a-f0-9]{12}$/);
assert.equal(manifest.strategyImplementations.BELIEF_PSO_V3.parameters.iterations, 30);
assert.equal(
  manifest.strategyImplementations.BELIEF_PSO_V3.parameters.psoActivation,
  'allConfirmedTracksWithFeasibilityRepair',
  'manifest should include constrained PSO activation metadata'
);

const runWindowCheck = async (metricsWindowSec, outputDir) => new HeadlessRunner().run({
  benchmarkId: 'aggregate_window_invariance',
  outputLabel: 'synthetic-uncalibrated',
  scenario: 'single_straight',
  durationSec: 60,
  seed: 7,
  strategy: 'FULL_SCAN',
  sensorProfile: 'synthetic_default_v0',
  dtSec: 0.1,
  sampleIntervalSec: 1,
  strategyUpdateIntervalSec: 0.8,
  metricsWindowSec,
  warmupSec: 10,
  outputDir,
}, { gitCommit: 'smoke-test', gitDirty: true, gitStatusShort: 'smoke-test' });
const shortWindow = await runWindowCheck(5, ${shortWindowDir});
const longWindow = await runWindowCheck(20, ${longWindowDir});
const readOnlySummary = result => JSON.parse(readFileSync(result.runSummaryPath, 'utf8').trim());
const shortAggregate = readOnlySummary(shortWindow).aggregateMetrics;
const longAggregate = readOnlySummary(longWindow).aggregateMetrics;
for (const metric of ['trackingRate', 'strictTrackAccuracy', 'localTrackAccuracy', 'strictIdentityTracks', 'localIdentityTracks', 'identityTrackOpportunities', 'gospa', 'gospaLocalization', 'gospaMissed', 'gospaFalse']) {
  assert.equal(shortAggregate[metric], longAggregate[metric], metric + ' aggregate must not depend on the UI/diagnostic rolling window');
}

const populationResult = await new HeadlessRunner().run({
  experimentId: 'e2e_population_sweep',
  benchmarkId: 'e2e_population_sweep_test',
  outputLabel: 'synthetic-uncalibrated',
  movementModels: ['random_reflect', 'lap_swim_with_rest'],
  swimmerCounts: [0, 4],
  restFraction: 0.15,
  durationSec: 30,
  seed: 1,
  strategies: ['FULL_SCAN', 'BELIEF_PSO_V3'],
  sensorProfile: 'synthetic_default_v0',
  dtSec: 0.1,
  sampleIntervalSec: 1,
  strategyUpdateIntervalSec: 0.8,
  metricsWindowSec: 10,
  warmupSec: 5,
  outputDir: ${populationOutputDir},
}, { gitCommit: 'population-smoke-test', gitDirty: true, gitStatusShort: 'population-smoke-test' });
assert.equal(populationResult.runCount, 8, 'population smoke should run 2 movement models x 2 counts x 2 strategies');
const populationSamples = readFileSync(populationResult.samplePath, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
const populationRuns = readFileSync(populationResult.runSummaryPath, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
assert.ok(populationSamples.every(row => row.experimentId === 'e2e_population_sweep'), 'population samples should include experimentId');
assert.ok(populationRuns.every(row => row.movementModel && Number.isInteger(row.swimmerCount)), 'population run summaries should include movementModel and swimmerCount');
const strategySnapshots = JSON.stringify(populationSamples.map(row => row.strategySnapshot));
assert.equal(strategySnapshots.includes('truthId'), false, 'strategy snapshots must not leak truthId');
assert.equal(strategySnapshots.includes('"truth"'), false, 'strategy snapshots must not include truth payloads');

execFileSync(process.execPath, [
  repoRoot + '/scripts/generate_e2e_population_report.mjs',
  populationResult.outputDir,
  ${populationReportDir},
], { cwd: repoRoot, stdio: 'pipe' });
const reportPath = ${populationReportDir} + '/e2e_population_sweep_report.md';
assert.ok(existsSync(reportPath), 'population report generator should write the Markdown report');
assert.ok(existsSync(${populationReportDir} + '/metrics_by_density.csv'), 'population report generator should write metrics_by_density.csv');
assert.ok(existsSync(${populationReportDir} + '/metrics_by_run.csv'), 'population report generator should write metrics_by_run.csv');
assert.ok(existsSync(${populationReportDir} + '/paired_effects.csv'), 'population report generator should write paired_effects.csv');
for (const chartName of ['localTrackAccuracy', 'avgAoISec', 'avgScanRateHz', 'trackContinuity', 'sonarBusyRatio', 'searchCoverageRatio', 'decisionLatencyP95Ms']) {
  assert.ok(existsSync(${populationReportDir} + '/charts/' + chartName + '.png'), 'population report generator should write ' + chartName + ' chart');
  assert.ok(existsSync(${populationReportDir} + '/charts/' + chartName + '.pdf'), 'population report generator should write ' + chartName + ' pdf chart');
}
const reportText = readFileSync(reportPath, 'utf8');
assert.ok(reportText.includes('## 场景设置'), 'report should explain scenario settings');
assert.ok(reportText.includes('search coverage'), 'report should use the seven-metric evaluation vocabulary');
assert.ok(reportText.includes('## 结论'), 'report should include a conclusion section');
`;

const tmp = await mkdtemp(path.join(tmpdir(), 'sonarscan-benchmark-smoke-'));
const entry = path.join(tmp, 'benchmark-smoke-entry.ts');
const outfile = path.join(tmp, 'benchmark-smoke-bundle.mjs');

await writeFile(entry, testEntry);
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    sourcemap: false,
    logLevel: 'silent',
    external: ['node:assert/strict', 'node:fs', 'node:child_process'],
  });
  await import(pathToFileURL(outfile).href);
  console.log('benchmark smoke tests passed');
} catch (error) {
  assert.fail(error?.stack ?? String(error));
}
