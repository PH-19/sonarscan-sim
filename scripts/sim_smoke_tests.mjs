import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const cwd = process.cwd().replaceAll('\\\\', '/');
const modulePath = (relativePath) => JSON.stringify(`${cwd}/${relativePath}`);

const testEntry = `
import assert from 'node:assert/strict';
import { SonarTimingModel } from ${modulePath('services/sim/sonar/SonarTimingModel.ts')};
import { SonarCommandScheduler } from ${modulePath('services/sim/sonar/SonarCommandScheduler.ts')};
import { Detector } from ${modulePath('services/sim/perception/Detector.ts')};
import { Evaluator } from ${modulePath('services/sim/evaluation/Evaluator.ts')};
import { SimulationEngine } from ${modulePath('services/SimulationEngine.ts')};
import { MeasurementModel } from ${modulePath('services/sim/sonar/MeasurementModel.ts')};
import { fuseMultiSonarDetections } from ${modulePath('services/sim/perception/MultiSonarFusion.ts')};
import { Tracker } from ${modulePath('services/sim/perception/Tracker.ts')};
import { hungarianAssignment } from ${modulePath('utils/assignment.ts')};
import { BenchmarkTruthOracleProvider } from ${modulePath('services/sim/strategy/BenchmarkTruthOracleProvider.ts')};
import { makeSonarsByCount } from ${modulePath('services/sim/core/Scenario.ts')};

const baseCommand = (patch = {}) => ({
  commandId: patch.commandId ?? 'cmd',
  sonarId: patch.sonarId ?? 'S1',
  startLocalAngle: patch.startLocalAngle ?? 0,
  scanStartLocalAngle: patch.scanStartLocalAngle ?? 0,
  endLocalAngle: patch.endLocalAngle ?? 90,
  scanMinLocalAngle: patch.scanMinLocalAngle ?? 0,
  scanMaxLocalAngle: patch.scanMaxLocalAngle ?? (patch.endLocalAngle ?? 90),
  range: patch.range ?? 50,
  angularStepDeg: patch.angularStepDeg ?? 1,
  samplesPerBeam: patch.samplesPerBeam ?? 256,
  pingSlotCount: patch.pingSlotCount ?? 1,
  startTime: patch.startTime ?? 0,
  scanWindows: patch.scanWindows,
});

const timing = new SonarTimingModel();
const defaultSonars = makeSonarsByCount();
assert.equal(defaultSonars.length, 4, 'default scenario should keep four sonars');
const layoutSummary = count => makeSonarsByCount(count).map(sonar => [
  sonar.id,
  Number(sonar.position.x.toFixed(2)),
  Number(sonar.position.y.toFixed(2)),
  sonar.mountAngle,
]);
assert.deepEqual(layoutSummary(1), [
  ['S1', 0, 25, 0],
]);
assert.deepEqual(layoutSummary(2), [
  ['S1', 0, 25, 0],
  ['S2', 20, 25, 180],
]);
assert.deepEqual(layoutSummary(3), [
  ['S1', 0, 25, 0],
  ['S2', 10, 0, 90],
  ['S3', 10, 50, 270],
]);
assert.deepEqual(layoutSummary(4), [
  ['S1', 0, 25, 0],
  ['S2', 20, 25, 180],
  ['S3', 10, 0, 90],
  ['S4', 10, 50, 270],
], 'default four-sonar layout should use one inward-facing sonar on each pool edge');
assert.deepEqual(layoutSummary(5), [
  ['S1', 0, 16.67, 0],
  ['S2', 0, 33.33, 0],
  ['S3', 20, 25, 180],
  ['S4', 10, 0, 90],
  ['S5', 10, 50, 270],
]);
assert.deepEqual(layoutSummary(6), [
  ['S1', 0, 16.67, 0],
  ['S2', 20, 16.67, 180],
  ['S3', 0, 33.33, 0],
  ['S4', 20, 33.33, 180],
  ['S5', 10, 0, 90],
  ['S6', 10, 50, 270],
]);
for (let count = 1; count <= 6; count += 1) {
  assert.equal(makeSonarsByCount(count).length, count, 'configured sonar count should generate matching layout size');
}
assert.throws(() => makeSonarsByCount(7), /sonarCount must be between 1 and 6/);
assert.deepEqual(
  hungarianAssignment([[1, 2], [1.1, 100]]),
  [1, 0],
  'global assignment must avoid the locally cheapest pair when it causes a worse total matching cost'
);
assert.ok(
  timing.durationSec(baseCommand({ range: 5 })) <
    timing.durationSec(baseCommand({ range: 15 })) &&
    timing.durationSec(baseCommand({ range: 15 })) <
    timing.durationSec(baseCommand({ range: 50 })),
  'scan duration should increase with range'
);
assert.ok(
  timing.durationSec(baseCommand({ endLocalAngle: 45 })) <
    timing.durationSec(baseCommand({ endLocalAngle: 90 })) &&
    timing.durationSec(baseCommand({ endLocalAngle: 90 })) <
    timing.durationSec(baseCommand({ endLocalAngle: 180 })),
  'scan duration should increase with sector width'
);
const oneMeter360 = timing.durationSec(baseCommand({ range: 1, angularStepDeg: 0.9, endLocalAngle: 360 }));
const fiftyMeter360 = timing.durationSec(baseCommand({ range: 50, angularStepDeg: 0.9, endLocalAngle: 360 }));
assert.ok(oneMeter360 >= 3.2 && oneMeter360 <= 3.7, '1m/360 timing should match Ping360 Ethernet specification');
assert.ok(fiftyMeter360 >= 31 && fiftyMeter360 <= 34, '50m/360 timing should match Ping360 specification');
const continuousWideCommand = baseCommand({ commandId: 'continuous-wide', endLocalAngle: 180, scanMaxLocalAngle: 180, range: 20 });
const jumpScanCommand = baseCommand({
  commandId: 'jump-scan',
  endLocalAngle: 180,
  scanMaxLocalAngle: 180,
  range: 20,
  scanWindows: [
    { scanStartLocalAngle: 0, endLocalAngle: 12, scanMinLocalAngle: 0, scanMaxLocalAngle: 12, range: 20, assignedTargetIds: [] },
    { scanStartLocalAngle: 84, endLocalAngle: 96, scanMinLocalAngle: 84, scanMaxLocalAngle: 96, range: 8, assignedTargetIds: ['T_MID'] },
    { scanStartLocalAngle: 168, endLocalAngle: 180, scanMinLocalAngle: 168, scanMaxLocalAngle: 180, range: 20, assignedTargetIds: [] },
  ],
});
assert.ok(
  timing.durationSec(jumpScanCommand) < timing.durationSec(continuousWideCommand),
  'jump-scan command should skip empty angular gaps and finish faster than a continuous wide scan'
);
assert.equal(timing.beamCount(jumpScanCommand), 39, 'jump-scan beam count should include only emitting windows');
assert.equal(timing.beamRange(jumpScanCommand, 13), 8, 'jump-scan beams should carry per-window range');
const afterFirstWindow = jumpScanCommand.startTime
  + timing.slewTimeSec(jumpScanCommand)
  + 13 * timing.beamIntervalSec({
    range: 20,
    angularStepDeg: jumpScanCommand.angularStepDeg,
    samplesPerBeam: jumpScanCommand.samplesPerBeam,
    pingSlotCount: jumpScanCommand.pingSlotCount,
  })
  + 0.1;
assert.equal(timing.mechanicalState(jumpScanCommand, afterFirstWindow).scanning, false, 'jump-scan gap traversal should be mechanical slew, not emission');

const scheduler = new SonarCommandScheduler(timing);
const first = baseCommand({ commandId: 'busy-a', startTime: 0 });
assert.equal(scheduler.submit(first), true, 'first command should be accepted');
assert.equal(
  scheduler.submit(baseCommand({ commandId: 'busy-b', startTime: 0 })),
  false,
  'busy sonar should reject overlapping command'
);
scheduler.advance(timing.endTime(first) + 0.001);
assert.equal(
  scheduler.submit(baseCommand({ commandId: 'busy-c', startTime: timing.endTime(first) + 0.001 })),
  true,
  'sonar should accept a new command after completion'
);

const wrapFrame = {
  sonarId: 'S4',
  commandId: 'wrap',
  sonarPosition: { x: 0, y: 50 },
  startTime: 0,
  endTime: 1,
  beams: [],
  angleBins: 91,
  rangeBins: 20,
  startAngle: -45,
  endAngle: 45,
  minAngle: -45,
  maxAngle: 45,
  range: 20,
  intensities: new Float32Array(91 * 20),
};
const wrapTruth = [{
  id: 'W_WRAP',
  truthId: 'W_WRAP',
  position: { x: 10, y: 50 },
  velocity: { x: 0, y: 0 },
  enteredAt: 0,
}];
const wrapDetection = [{
  id: 'wrap:d0',
  time: 1,
  sonarId: 'S4',
  position: { x: 10, y: 50 },
  range: 10,
  bearing: 0,
  confidence: 0.9,
  intensity: 10,
}];
const wrapEvaluator = new Evaluator();
wrapEvaluator.registerTruth(wrapTruth[0]);
const wrapResult = wrapEvaluator.recordFrame(wrapFrame, wrapDetection, wrapTruth, []);
const wrapMetrics = wrapEvaluator.metrics(1, wrapTruth, 1, 10);
assert.equal(wrapResult.annotatedDetections[0].source, 'target', 'wrap-around detection should match visible truth');
assert.equal(wrapMetrics.recall, 1, 'wrap-around sector should count swimmer as visible');

const makeSyntheticFrame = () => {
  const angleBins = 91;
  const rangeBins = 20;
  const intensities = new Float32Array(angleBins * rangeBins);
  for (let a = 44; a <= 46; a++) {
    for (let r = 10; r <= 12; r++) {
      intensities[a * rangeBins + r] = 5;
    }
  }
  return {
    sonarId: 'S1',
    commandId: 'synthetic',
    sonarPosition: { x: 0, y: 0 },
    startTime: 0,
    endTime: 1,
    beams: [],
    angleBins,
    rangeBins,
    startAngle: 0,
    endAngle: 90,
    minAngle: 0,
    maxAngle: 90,
    range: 10,
    intensities,
  };
};
const syntheticSonar = {
  id: 'S1',
  position: { x: 0, y: 0 },
  angle: 45,
  mountAngle: 45,
  mountYaw: -45,
  minLocalAngle: 0,
  maxLocalAngle: 180,
  currentLocalAngle: 90,
  scanDirection: 1,
  currentAngle: 45,
  mode: 'SCANNING',
  targetAngle: 90,
  scanRange: 10,
  pingAccumulator: 0,
  lastScanTime: 0,
  cycleDuration: 0,
  detectedPoints: [],
  matchedPoints: [],
};
const sampledBeamTimes = [];
const temporalModel = new MeasurementModel(timing, 3, { noiseScale: 0, speckleProb: 0 });
const temporalCommand = baseCommand({
  commandId: 'temporal',
  endLocalAngle: 2,
  scanMaxLocalAngle: 2,
  range: 5,
  samplesPerBeam: 20,
});
const temporalFrame = temporalModel.buildFrame(syntheticSonar, temporalCommand, time => {
  sampledBeamTimes.push(time);
  return [{
    id: 'moving',
    truthId: 'moving',
    position: { x: 2 + time, y: 2 },
    velocity: { x: 1, y: 0 },
    enteredAt: 0,
  }];
});
assert.equal(temporalFrame.beams.length, 3, 'one truth sample is generated per physical beam');
assert.equal(sampledBeamTimes.length, 3, 'forward model must query trajectory history for every beam');
assert.ok(sampledBeamTimes[0] < sampledBeamTimes[1] && sampledBeamTimes[1] < sampledBeamTimes[2], 'beam truth samples must use increasing acquisition timestamps');

const fusedDetections = fuseMultiSonarDetections([
  { id: 's1', time: 1, sonarId: 'S1', position: { x: 5, y: 5 }, range: 7, bearing: 45, confidence: 0.8, intensity: 8 },
  { id: 's2', time: 1.02, sonarId: 'S2', position: { x: 5.2, y: 5.1 }, range: 16, bearing: 160, confidence: 0.7, intensity: 7 },
  { id: 'other', time: 1.01, sonarId: 'S3', position: { x: 9, y: 9 }, range: 20, bearing: 220, confidence: 0.9, intensity: 9 },
], 1.02);
assert.equal(fusedDetections.length, 2, 'near-simultaneous multi-sonar duplicates should form one tracker measurement');
assert.ok(fusedDetections.some(d => d.sonarId === 'S1+S2'), 'fusion output should preserve contributing sonar provenance');

const visibilityTracker = new Tracker();
const trackedDetection = { id: 'tracked', time: 1, sonarId: 'S1', position: { x: 5, y: 5 }, range: 7.07, bearing: 45, confidence: 0.9, intensity: 8 };
visibilityTracker.update(1, [trackedDetection]);
const observationFrame = angle => ({
  ...makeSyntheticFrame(),
  endTime: 2,
  range: 20,
  beams: [{ beamIndex: 0, time: 2, angle, localAngle: angle, intensities: [] }],
});
visibilityTracker.update(2, [], [observationFrame(90)]);
const confidenceOutsideSector = visibilityTracker.getBeliefs(2)[0].confidence;
visibilityTracker.update(3, [], [observationFrame(45)]);
const confidenceInsideSector = visibilityTracker.getBeliefs(3)[0].confidence;
assert.equal(confidenceOutsideSector, 0.5, 'a scan sector that cannot see a track must not reduce existence probability');
assert.ok(confidenceInsideSector < confidenceOutsideSector, 'an observable track without a detection must count as a miss');
const lowThresholdDetector = new Detector(1, {
  threshold: 0.2,
  dbscanEpsBins: 2,
  dbscanMinPts: 3,
  noiseScale: 0.1,
  kernelCap: 3,
});
const highThresholdDetector = new Detector(1, {
  threshold: 10,
  dbscanEpsBins: 2,
  dbscanMinPts: 3,
  noiseScale: 0.1,
  kernelCap: 3,
});
const strictMinPtsDetector = new Detector(1, {
  threshold: 0.2,
  dbscanEpsBins: 2,
  dbscanMinPts: 50,
  noiseScale: 0.1,
  kernelCap: 3,
});
const wideKernelDetector = new Detector(1, {
  threshold: 0.2,
  dbscanEpsBins: 2,
  dbscanMinPts: 3,
  noiseScale: 0.1,
  kernelCap: 13,
});
const lowCount = lowThresholdDetector.detect(makeSyntheticFrame(), syntheticSonar).length;
assert.ok(lowCount > 0, 'low threshold detector should find synthetic cluster');
assert.ok(
  highThresholdDetector.detect(makeSyntheticFrame(), syntheticSonar).length <= lowCount,
  'higher threshold should not increase detections'
);
assert.ok(
  strictMinPtsDetector.detect(makeSyntheticFrame(), syntheticSonar).length <= lowCount,
  'higher DBSCAN minPts should not increase detections'
);
assert.ok(
  wideKernelDetector.detect(makeSyntheticFrame(), syntheticSonar).length <= lowCount,
  'larger denoise kernelCap should affect detection count monotonically'
);

const falseEvaluator = new Evaluator();
const falseDetection = [{
  id: 'empty:d0',
  time: 1,
  sonarId: 'S1',
  position: { x: 4, y: 4 },
  range: 5.7,
  bearing: 45,
  confidence: 0.6,
  intensity: 4,
}];
const falseTrack = [{
  trackId: 'T_FALSE',
  position: { x: 4, y: 4 },
  velocity: { x: 0, y: 0 },
  covariance: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  age: 1,
  timeSinceUpdate: 0,
  confidence: 0.5,
  status: 'confirmed',
}];
const falseResult = falseEvaluator.recordFrame(makeSyntheticFrame(), falseDetection, [], falseTrack);
falseEvaluator.recordTrackState(1, [], falseTrack);
const falseMetrics = falseEvaluator.metrics(1, [], 1, 10);
assert.equal(falseResult.annotatedDetections[0].source, 'false_alarm', 'unmatched detection should be marked false_alarm');
assert.ok(falseMetrics.falseAlarmsPerSec > 0, 'false alarm metric should include unmatched detection');
assert.equal(falseMetrics.falseTracks, 1, 'unmatched live track should count as false track');

const intervalEvaluator = new Evaluator();
const intervalTruth = [{
  id: 'W_INTERVAL',
  truthId: 'W_INTERVAL',
  position: { x: 2, y: 2 },
  velocity: { x: 0, y: 0 },
  enteredAt: 0,
}];
const intervalFrame = (time) => ({
  ...makeSyntheticFrame(),
  commandId: 'interval-' + time,
  endTime: time,
  range: 10,
});
const intervalDetection = (time) => [{
  id: 'interval:' + time,
  time,
  sonarId: 'S1',
  position: { x: 2, y: 2 },
  range: Math.sqrt(8),
  bearing: 45,
  confidence: 0.9,
  intensity: 10,
}];
intervalEvaluator.recordFrame(intervalFrame(2), intervalDetection(2), intervalTruth, []);
intervalEvaluator.recordFrame(intervalFrame(7), intervalDetection(7), intervalTruth, []);
const intervalMetrics = intervalEvaluator.metrics(10, intervalTruth, 1, 10);
assert.ok(Math.abs(intervalMetrics.avgScanRateHz - 0.2) < 1e-9, 'two matched scans in a 10s window should be 0.2 Hz');
assert.ok(Math.abs(intervalMetrics.avgAoISec - 5) < 1e-9, 'Average AoI should be the inverse scan interval of avgScanRateHz for one swimmer');

const identityTruth = [
  { id: 'W_ID_A', truthId: 'W_ID_A', position: { x: 2, y: 2 }, velocity: { x: 0, y: 0 }, enteredAt: 0 },
  { id: 'W_ID_B', truthId: 'W_ID_B', position: { x: 12, y: 2 }, velocity: { x: 0, y: 0 }, enteredAt: 0 },
];
const identityTrack = (trackId, x, y) => ({
  trackId,
  position: { x, y },
  velocity: { x: 0, y: 0 },
  covariance: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  age: 1,
  timeSinceUpdate: 0,
  confidence: 0.9,
  status: 'confirmed',
});
const identityFrame = (time) => ({
  ...makeSyntheticFrame(),
  commandId: 'identity-' + time,
  endTime: time,
  range: 20,
});
const stableIdentityEvaluator = new Evaluator();
stableIdentityEvaluator.recordFrame(identityFrame(1), [], identityTruth, [
  identityTrack('T_A', 2, 2),
  identityTrack('T_B', 12, 2),
]);
stableIdentityEvaluator.recordFrame(identityFrame(2), [], identityTruth, [
  identityTrack('T_A', 2, 2),
  identityTrack('T_B', 12, 2),
]);
const stableIdentityMetrics = stableIdentityEvaluator.metrics(2, identityTruth, 1, 10);
assert.equal(stableIdentityMetrics.identityTrackOpportunities, 4, 'each visible truth scan should count as one identity opportunity');
assert.equal(stableIdentityMetrics.strictIdentityTracks, 4, 'stable one-to-one truth/track scan samples should be correct');
assert.equal(stableIdentityMetrics.strictTrackAccuracy, 1, 'stable one-to-one truth/track scan samples should be 100% accurate');
assert.equal(stableIdentityMetrics.localIdentityTracks, 4, 'stable one-to-one truth/track scan samples should be locally correct');
assert.equal(stableIdentityMetrics.localTrackAccuracy, 1, 'stable one-to-one truth/track scan samples should be 100% locally accurate');

const swappedIdentityEvaluator = new Evaluator();
swappedIdentityEvaluator.recordFrame(identityFrame(1), [], identityTruth, [
  identityTrack('T_A', 2, 2),
  identityTrack('T_B', 12, 2),
]);
swappedIdentityEvaluator.recordTrackState(1, identityTruth, [
  identityTrack('T_A', 2, 2),
  identityTrack('T_B', 12, 2),
]);
swappedIdentityEvaluator.recordFrame(identityFrame(2), [], identityTruth, [
  identityTrack('T_A', 12, 2),
  identityTrack('T_B', 2, 2),
]);
swappedIdentityEvaluator.recordTrackState(2, identityTruth, [
  identityTrack('T_A', 12, 2),
  identityTrack('T_B', 2, 2),
]);
const swappedIdentityMetrics = swappedIdentityEvaluator.metrics(2, identityTruth, 1, 10);
assert.equal(swappedIdentityMetrics.identityTrackOpportunities, 4, 'identity accuracy should be counted per visible truth scan');
assert.equal(swappedIdentityMetrics.strictIdentityTracks, 2, 'the initial correct scans should remain correct after a later ID swap');
assert.equal(swappedIdentityMetrics.strictTrackAccuracy, 0.5, 'one correct scan and one wrong-ID scan per swimmer should produce 50% strict identity accuracy');
assert.equal(swappedIdentityMetrics.localIdentityTracks, 2, 'a one-frame swap should be locally wrong for both swimmers');
assert.equal(swappedIdentityMetrics.localTrackAccuracy, 0.5, 'a one-frame swap should match strict identity accuracy before any stable handoff');
assert.equal(swappedIdentityMetrics.idSwitches, 2, 'both swimmers should register an ID switch after a track swap');

const transientIdentityEvaluator = new Evaluator();
const transientTruth = [identityTruth[0]];
transientIdentityEvaluator.recordFrame(identityFrame(1), [], transientTruth, [
  identityTrack('T_A', 2, 2),
]);
transientIdentityEvaluator.recordFrame(identityFrame(2), [], transientTruth, [
  identityTrack('T_X', 2, 2),
]);
transientIdentityEvaluator.recordFrame(identityFrame(3), [], transientTruth, [
  identityTrack('T_A', 2, 2),
]);
const transientIdentityMetrics = transientIdentityEvaluator.metrics(3, transientTruth, 1, 10);
assert.equal(transientIdentityMetrics.strictIdentityTracks, 2, 'strict identity should count only the transient wrong ID as incorrect');
assert.equal(transientIdentityMetrics.localIdentityTracks, 2, 'local identity should also count only the transient wrong ID as incorrect');
assert.equal(transientIdentityMetrics.localTrackAccuracy, 2 / 3, 'a-a-x-a should only penalize the x sample locally');

const persistentHandoffEvaluator = new Evaluator();
persistentHandoffEvaluator.recordFrame(identityFrame(1), [], transientTruth, [
  identityTrack('T_A', 2, 2),
]);
persistentHandoffEvaluator.recordFrame(identityFrame(2), [], transientTruth, [
  identityTrack('T_X', 2, 2),
]);
persistentHandoffEvaluator.recordFrame(identityFrame(3), [], transientTruth, [
  identityTrack('T_X', 2, 2),
]);
const persistentHandoffMetrics = persistentHandoffEvaluator.metrics(3, transientTruth, 1, 10);
assert.equal(persistentHandoffMetrics.strictTrackAccuracy, 1 / 3, 'strict identity should keep penalizing a permanent handoff away from the canonical track');
assert.equal(persistentHandoffMetrics.localTrackAccuracy, 2 / 3, 'local identity should promote a repeated new track after the first handoff penalty');

const missedIdentityEvaluator = new Evaluator();
missedIdentityEvaluator.recordFrame(identityFrame(1), [], identityTruth, []);
const missedIdentityMetrics = missedIdentityEvaluator.metrics(1, identityTruth, 1, 10);
assert.equal(missedIdentityMetrics.identityTrackOpportunities, 2, 'untracked truths are still strict identity opportunities');
assert.equal(missedIdentityMetrics.strictTrackAccuracy, 0, 'untracked truths must not inflate strict identity accuracy');
assert.equal(missedIdentityMetrics.localTrackAccuracy, 0, 'untracked truths must not inflate local identity accuracy');

const engine = new SimulationEngine({ strategy: 'NAIVE', evalSeed: 7 });
engine.addSwimmer({
  id: 'W_SECRET',
  position: { x: 10, y: 10 },
  velocity: { x: 0, y: 0 },
  enteredAt: 0,
});
const snapshotJson = JSON.stringify(engine.getStrategySnapshot());
assert.equal(engine.getStrategySnapshot().physics.maxRange, 20, 'default full-scan strategy range should be 20m');
assert.equal(engine.getStrategySnapshot().physics.tdmaSlotCount, 1, 'TDMA should be disabled by default in strategy snapshots');
assert.equal(snapshotJson.includes('truthId'), false, 'strategy snapshot must not contain truthId');
const oracle = new BenchmarkTruthOracleProvider(() => [{
  truthId: 'ORACLE_ONLY_TRUTH',
  position: { x: 10, y: 25 },
  velocity: { x: 0.5, y: 0 },
}]);
const oracleDecision = await oracle.plan(engine.getStrategySnapshot());
assert.equal(oracleDecision.strategy, 'TRUTH_LOOKAHEAD_ORACLE');
assert.ok(oracleDecision.plans.some(plan => plan.assignedTargetIds.includes('ORACLE_ONLY_TRUTH')), 'benchmark-only oracle should consume its isolated truth supplier');
assert.ok(oracleDecision.plans.every(plan => plan.minLocalAngle >= 0 && plan.maxLocalAngle <= 180 && plan.range <= 50), 'oracle plans must obey physical command bounds');
assert.equal(snapshotJson.includes('W_SECRET'), false, 'strategy snapshot must not expose swimmer truth id');

const defaultTimingEngine = new SimulationEngine({ strategy: 'FULL_SCAN', evalSeed: 12 });
defaultTimingEngine.applyStrategyDecision({
  strategy: 'FULL_SCAN',
  generatedAt: 0,
  plans: defaultTimingEngine.sonars.map(sonar => ({
    sonarId: sonar.id,
    minLocalAngle: sonar.minLocalAngle,
    maxLocalAngle: sonar.maxLocalAngle,
    range: 20,
    assignedTargetIds: [],
    action: 'FULL_SWEEP',
  })),
});
const defaultEvents = defaultTimingEngine.update(8, { autoSchedule: false });
assert.equal(defaultEvents.length, 4, 'default non-TDMA four-sonar 20m full sweeps should complete in about one single-sonar sweep');
assert.ok(defaultEvents.every(event => event.command.pingSlotCount === 1), 'default UI/CLI commands should not multiply beam time by sonar count');

const tdmaTimingEngine = new SimulationEngine({ strategy: 'FULL_SCAN', evalSeed: 12, tdmaEnabled: true });
assert.equal(tdmaTimingEngine.getStrategySnapshot().physics.tdmaSlotCount, 4, 'explicit TDMA should preserve multi-slot strategy physics');
tdmaTimingEngine.applyStrategyDecision({
  strategy: 'FULL_SCAN',
  generatedAt: 0,
  plans: tdmaTimingEngine.sonars.map(sonar => ({
    sonarId: sonar.id,
    minLocalAngle: sonar.minLocalAngle,
    maxLocalAngle: sonar.maxLocalAngle,
    range: 20,
    assignedTargetIds: [],
    action: 'FULL_SWEEP',
  })),
});
assert.equal(tdmaTimingEngine.update(8, { autoSchedule: false }).length, 0, 'explicit TDMA should keep the conservative slower multi-slot timing available');

const schedulingEngine = new SimulationEngine({ strategy: 'PSO_V1', evalSeed: 9, tdmaEnabled: false });
const fullPlans = schedulingEngine.sonars.map(sonar => ({
  sonarId: sonar.id,
  minLocalAngle: sonar.minLocalAngle,
  maxLocalAngle: sonar.maxLocalAngle,
  range: 50,
  assignedTargetIds: [],
  action: 'FULL_SWEEP',
}));
schedulingEngine.applyStrategyDecision({ strategy: 'PSO_V1', generatedAt: 0, plans: fullPlans });
const firstEvents = schedulingEngine.update(18, { autoSchedule: false });
assert.equal(firstEvents.length, 4, 'first full-scan commands should complete');
assert.ok(schedulingEngine.sonars.every(sonar => sonar.mode === 'IDLE'), 'autoSchedule false must leave completed sonars idle for a fresh decision');
assert.ok(schedulingEngine.sonars.every(sonar => Math.abs(sonar.currentLocalAngle - 180) < 1e-6 && sonar.scanDirection === -1), 'first full sweep leg must end at local 180 and reverse direction');

schedulingEngine.applyStrategyDecision({ strategy: 'PSO_V1', generatedAt: schedulingEngine.time, plans: fullPlans });
const reverseEvents = schedulingEngine.update(18, { autoSchedule: false });
assert.equal(reverseEvents.length, 4, 'reverse full-scan commands should complete');
assert.ok(schedulingEngine.sonars.every(sonar => Math.abs(sonar.currentLocalAngle) < 1e-6 && sonar.scanDirection === 1), 'second full sweep leg must return to local 0 and reverse direction');

const roiPlans = schedulingEngine.sonars.map(sonar => ({
  sonarId: sonar.id,
  minLocalAngle: 80,
  maxLocalAngle: 100,
  range: 12,
  assignedTargetIds: ['T_NEW'],
  action: 'TRACK_ROI',
}));
schedulingEngine.applyStrategyDecision({ strategy: 'PSO_V1', generatedAt: schedulingEngine.time, plans: roiPlans });
const nextEvents = schedulingEngine.update(5, { autoSchedule: false });
assert.equal(nextEvents.length, 4, 'fresh ROI commands should be the next completed commands');
assert.ok(nextEvents.every(event => event.command.action === 'TRACK_ROI' && event.command.range === 12), 'no stale full scan may be inserted before the fresh ROI decision');

const failureEngine = new SimulationEngine({ strategy: 'PSO_V1', evalSeed: 11, tdmaEnabled: false });
const failurePlans = failureEngine.sonars.map(sonar => ({
  sonarId: sonar.id,
  minLocalAngle: sonar.minLocalAngle,
  maxLocalAngle: sonar.maxLocalAngle,
  range: 50,
  assignedTargetIds: [],
  action: 'FULL_SWEEP',
}));
failureEngine.applyStrategyDecision({ strategy: 'PSO_V1', generatedAt: 0, plans: failurePlans });
assert.equal(failureEngine.setSonarAvailable('S2', false), true);
assert.equal(failureEngine.getStrategySnapshot().sonars.find(sonar => sonar.id === 'S2').available, false);
const failureEvents = failureEngine.update(20, { autoSchedule: false });
assert.equal(failureEvents.length, 3, 'disabled sonar command must be cancelled while other sonars continue');
assert.equal(failureEvents.some(event => event.sonarId === 'S2'), false);
`;

const tmp = await mkdtemp(path.join(tmpdir(), 'sonarscan-sim-smoke-'));
const entry = path.join(tmp, 'sim-smoke-entry.ts');
const outfile = path.join(tmp, 'sim-smoke-bundle.mjs');

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
    external: ['node:assert/strict'],
  });
  await import(pathToFileURL(outfile).href);
  console.log('sim smoke tests passed');
} catch (error) {
  assert.fail(error?.stack ?? String(error));
}
