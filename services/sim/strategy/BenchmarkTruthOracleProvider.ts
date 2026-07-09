import { StrategyDecision, StrategySnapshot, StrategySonar, Vector2 } from '../../../types';
import { angleToTarget, distance, normalizeAngle } from '../../../utils/math';
import { StrategyProvider } from './StrategyProvider';

export type OracleTruthTarget = {
  truthId: string;
  position: Vector2;
  velocity: Vector2;
};

const LOOKAHEAD_SEC = 1.5;
const MIN_ROI_DEG = 8;
const MAX_ROI_DEG = 70;
const SEARCH_SWEEP_DEG = 30;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

const reflectAxis = (position: number, velocity: number, limit: number) => {
  let p = position;
  let v = velocity;
  for (let guard = 0; guard < 4; guard += 1) {
    if (p < 0) {
      p = -p;
      v = -v;
    } else if (p > limit) {
      p = 2 * limit - p;
      v = -v;
    } else break;
  }
  return { position: p, velocity: v };
};

const predictTarget = (target: OracleTruthTarget, snapshot: StrategySnapshot) => {
  const x = reflectAxis(target.position.x + target.velocity.x * LOOKAHEAD_SEC, target.velocity.x, snapshot.pool.width);
  const y = reflectAxis(target.position.y + target.velocity.y * LOOKAHEAD_SEC, target.velocity.y, snapshot.pool.length);
  return { ...target, position: { x: x.position, y: y.position } };
};

const localAngle = (sonar: StrategySonar, position: Vector2) => normalizeAngle(angleToTarget(sonar.position, position) - sonar.mountYaw);

const eligibleSonars = (snapshot: StrategySnapshot, target: OracleTruthTarget) => {
  const visible = snapshot.sonars
    .map((sonar, index) => ({ sonar, index }))
    .filter(({ sonar }) => sonar.available)
    .filter(({ sonar }) => {
      const angle = localAngle(sonar, target.position);
      return angle >= sonar.minLocalAngle && angle <= sonar.maxLocalAngle;
    })
    .map(({ index }) => index);
  if (visible.length > 0) return visible;
  const available = snapshot.sonars
    .map((sonar, index) => ({ sonar, index }))
    .filter(({ sonar }) => sonar.available);
  if (available.length === 0) return [];
  return [available.reduce((best, candidate) =>
    distance(candidate.sonar.position, target.position) < distance(best.sonar.position, target.position)
      ? candidate
      : best
  ).index];
};

const roiGeometry = (sonar: StrategySonar, targets: OracleTruthTarget[], maxRange: number) => {
  const angles = targets.map(target => localAngle(sonar, target.position));
  const rawLo = Math.min(...angles) - 4;
  const rawHi = Math.max(...angles) + 4;
  const width = clamp(rawHi - rawLo, MIN_ROI_DEG, MAX_ROI_DEG);
  const center = (rawLo + rawHi) / 2;
  const lo = clamp(center - width / 2, sonar.minLocalAngle, sonar.maxLocalAngle - width);
  const hi = lo + width;
  const range = clamp(
    Math.max(...targets.map(target => distance(sonar.position, target.position))) + 2,
    1,
    maxRange,
  );
  return { lo, hi, range };
};

const scanDuration = (snapshot: StrategySnapshot, sonar: StrategySonar, lo: number, hi: number, range: number) => {
  const physics = snapshot.physics;
  const beams = Math.max(1, Math.floor(Math.abs(hi - lo) / physics.scanStepAngle) + 1);
  const receive = Math.max(2 * range / physics.speedOfSound, physics.samplesPerBeam * physics.samplePeriodSec);
  const beamInterval = receive * physics.receiveGuardFactor + physics.processingOverheadSec + physics.scanStepOverheadSec;
  const reposition = Math.min(Math.abs(sonar.currentLocalAngle - lo), Math.abs(sonar.currentLocalAngle - hi)) / physics.slewSpeed;
  return reposition + beams * beamInterval * Math.max(1, physics.tdmaSlotCount);
};

const optimizeTruthAssignment = (snapshot: StrategySnapshot, targets: OracleTruthTarget[]) => {
  if (targets.length === 0) return [] as number[];
  const options = targets.map(target => eligibleSonars(snapshot, target));
  if (options.some(indices => indices.length === 0)) return targets.map(() => -1);
  let best: number[] = [];
  let bestCost = Infinity;
  const assignment = Array(targets.length).fill(-1);

  const evaluate = () => {
    const groups = snapshot.sonars.map(() => [] as OracleTruthTarget[]);
    assignment.forEach((sonarIndex, targetIndex) => groups[sonarIndex].push(targets[targetIndex]));
    const durations = groups.map((group, sonarIndex) => {
      if (group.length === 0) return 0;
      const geometry = roiGeometry(snapshot.sonars[sonarIndex], group, snapshot.physics.maxRange);
      return scanDuration(snapshot, snapshot.sonars[sonarIndex], geometry.lo, geometry.hi, geometry.range);
    });
    const serviceCost = groups.reduce((sum, group, index) => sum + durations[index] * Math.max(1, group.length), 0);
    const makespan = Math.max(...durations, 0);
    const cost = serviceCost + 0.75 * makespan;
    if (cost < bestCost) {
      bestCost = cost;
      best = [...assignment];
    }
  };

  const visit = (targetIndex: number) => {
    if (targetIndex === targets.length) {
      evaluate();
      return;
    }
    for (const sonarIndex of options[targetIndex]) {
      assignment[targetIndex] = sonarIndex;
      visit(targetIndex + 1);
    }
  };
  visit(0);
  return best;
};

export class BenchmarkTruthOracleProvider implements StrategyProvider {
  readonly strategyId = 'TRUTH_LOOKAHEAD_ORACLE';
  readonly metadata = {
    strategyId: this.strategyId,
    implementationLanguage: 'typescript' as const,
    implementation: 'BenchmarkTruthOracleProvider:clairvoyant-lookahead',
    codeVersion: 'truth-oracle-v1',
    parameters: {
      benchmarkOnlyTruthAccess: true,
      lookaheadSec: LOOKAHEAD_SEC,
      minRoiDeg: MIN_ROI_DEG,
      maxRoiDeg: MAX_ROI_DEG,
    },
  };
  invocationCount = 0;

  constructor(private readonly truthSupplier: () => OracleTruthTarget[]) {}

  async plan(snapshot: StrategySnapshot): Promise<StrategyDecision> {
    this.invocationCount += 1;
    const targets = this.truthSupplier().map(target => predictTarget(target, snapshot));
    const assignments = optimizeTruthAssignment(snapshot, targets);
    const groups = snapshot.sonars.map(() => [] as OracleTruthTarget[]);
    assignments.forEach((sonarIndex, targetIndex) => {
      if (sonarIndex >= 0) groups[sonarIndex].push(targets[targetIndex]);
    });

    return {
      strategy: this.strategyId,
      generatedAt: snapshot.simulationTime,
      plans: snapshot.sonars.map((sonar, index) => {
        if (!sonar.available) {
          return {
            sonarId: sonar.id,
            minLocalAngle: sonar.currentLocalAngle,
            maxLocalAngle: Math.min(sonar.maxLocalAngle, sonar.currentLocalAngle + 1),
            range: 1,
            assignedTargetIds: [],
            action: 'IDLE' as const,
          };
        }
        const group = groups[index];
        if (group.length > 0) {
          const geometry = roiGeometry(sonar, group, snapshot.physics.maxRange);
          return {
            sonarId: sonar.id,
            minLocalAngle: geometry.lo,
            maxLocalAngle: geometry.hi,
            range: geometry.range,
            assignedTargetIds: group.map(target => target.truthId),
            action: 'TRACK_ROI' as const,
          };
        }
        const bins = sonar.coverageBins ?? [];
        const stale = bins.length > 0
          ? bins.reduce((best, bin) => bin.ageSec > best.ageSec ? bin : best)
          : undefined;
        const center = stale
          ? (stale.minLocalAngle + stale.maxLocalAngle) / 2
          : sonar.minLocalAngle + SEARCH_SWEEP_DEG / 2;
        const lo = clamp(center - SEARCH_SWEEP_DEG / 2, sonar.minLocalAngle, sonar.maxLocalAngle - SEARCH_SWEEP_DEG);
        return {
          sonarId: sonar.id,
          minLocalAngle: lo,
          maxLocalAngle: lo + SEARCH_SWEEP_DEG,
          range: snapshot.physics.maxRange,
          assignedTargetIds: [],
          action: 'SEARCH_SECTOR' as const,
        };
      }),
    };
  }

  async close() {}
}
