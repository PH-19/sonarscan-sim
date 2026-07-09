import {
  SonarStrategyPlan,
  StrategyDecision,
  StrategySnapshot,
  StrategySonar,
  StrategyTrack,
} from '../../../types';
import { angleToTarget, distance, normalizeAngle } from '../../../utils/math';

const TARGET_PADDING_ANGLE = 25;
const TARGET_PADDING_RANGE_M = 5;
const MIN_SWEEP_DEG = 20;

export type HeadlessStrategyPlanner = (snapshot: StrategySnapshot, strategyName: string) => StrategyDecision;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

const relativeSectorAngle = (sonar: StrategySonar, target: StrategyTrack) => {
  return normalizeAngle(angleToTarget(sonar.position, target.position) - sonar.mountYaw);
};

const eligibleSonarIndexes = (snapshot: StrategySnapshot, track: StrategyTrack) => {
  const eligible = snapshot.sonars
    .map((sonar, index) => ({ sonar, index }))
    .filter(({ sonar }) => sonar.available && relativeSectorAngle(sonar, track) <= sonar.maxLocalAngle)
    .map(({ index }) => index);
  if (eligible.length > 0) return eligible;

  const nearest = snapshot.sonars.reduce((best, sonar, index) => {
    if (!sonar.available) return best;
    const d = distance(sonar.position, track.position);
    return d < best.distance ? { index, distance: d } : best;
  }, { index: 0, distance: Infinity });
  return [nearest.index];
};

const fullScanPlan = (sonar: StrategySonar, maxRange: number): SonarStrategyPlan => ({
  sonarId: sonar.id,
  minLocalAngle: sonar.minLocalAngle,
  maxLocalAngle: sonar.maxLocalAngle,
  range: maxRange,
  assignedTargetIds: [],
  action: sonar.available ? 'FULL_SWEEP' : 'IDLE',
});

const roiPlan = (sonar: StrategySonar, tracks: StrategyTrack[], maxRange: number): SonarStrategyPlan => {
  if (tracks.length === 0) return fullScanPlan(sonar, maxRange);

  const relAngles = tracks
    .map(track => relativeSectorAngle(sonar, track))
    .filter(angle => angle <= sonar.maxLocalAngle);
  if (relAngles.length === 0) return fullScanPlan(sonar, maxRange);

  let minRel = clamp(Math.min(...relAngles) - TARGET_PADDING_ANGLE, sonar.minLocalAngle, sonar.maxLocalAngle);
  let maxRel = clamp(Math.max(...relAngles) + TARGET_PADDING_ANGLE, sonar.minLocalAngle, sonar.maxLocalAngle);
  if (maxRel - minRel < MIN_SWEEP_DEG) {
    const center = (minRel + maxRel) / 2;
    minRel = center - MIN_SWEEP_DEG / 2;
    maxRel = center + MIN_SWEEP_DEG / 2;
    if (minRel < sonar.minLocalAngle) {
      maxRel += sonar.minLocalAngle - minRel;
      minRel = sonar.minLocalAngle;
    }
    if (maxRel > sonar.maxLocalAngle) {
      minRel -= maxRel - sonar.maxLocalAngle;
      maxRel = sonar.maxLocalAngle;
    }
  }

  const range = Math.max(
    ...tracks.map(track => distance(sonar.position, track.position) + TARGET_PADDING_RANGE_M)
  );

  return {
    sonarId: sonar.id,
    minLocalAngle: clamp(minRel, sonar.minLocalAngle, sonar.maxLocalAngle),
    maxLocalAngle: clamp(maxRel, sonar.minLocalAngle, sonar.maxLocalAngle),
    range: clamp(range, 1, maxRange),
    assignedTargetIds: tracks.map(track => track.id),
    action: 'TRACK_ROI',
  };
};

const decision = (
  strategyName: string,
  snapshot: StrategySnapshot,
  plans: SonarStrategyPlan[]
): StrategyDecision => ({
  strategy: strategyName,
  generatedAt: snapshot.simulationTime,
  plans,
});

const planFullScan: HeadlessStrategyPlanner = (snapshot, strategyName) => {
  const maxRange = snapshot.physics.maxRange;
  return decision(strategyName, snapshot, snapshot.sonars.map(sonar => fullScanPlan(sonar, maxRange)));
};

const assignNearest = (snapshot: StrategySnapshot) => {
  const groups = snapshot.sonars.map(() => [] as StrategyTrack[]);
  for (const track of snapshot.tracks) {
    const eligible = eligibleSonarIndexes(snapshot, track);
    const best = eligible.reduce((bestIndex, index) => {
      const candidateDistance = distance(snapshot.sonars[index].position, track.position);
      const bestDistance = distance(snapshot.sonars[bestIndex].position, track.position);
      return candidateDistance < bestDistance ? index : bestIndex;
    }, eligible[0]);
    groups[best].push(track);
  }
  return groups;
};

const assignRoundRobin = (snapshot: StrategySnapshot) => {
  const groups = snapshot.sonars.map(() => [] as StrategyTrack[]);
  const bucket = Math.floor(snapshot.simulationTime / 5);
  const tracks = [...snapshot.tracks].sort((a, b) => a.id.localeCompare(b.id));
  tracks.forEach((track, offset) => {
    const eligible = eligibleSonarIndexes(snapshot, track);
    const preferred = (bucket + offset) % snapshot.sonars.length;
    groups[eligible.includes(preferred) ? preferred : eligible[offset % eligible.length]].push(track);
  });
  return groups;
};

const assignMaxAoi = (snapshot: StrategySnapshot) => {
  const groups = snapshot.sonars.map(() => [] as StrategyTrack[]);
  const tracks = [...snapshot.tracks].sort((a, b) => (b.timeSinceUpdate ?? 0) - (a.timeSinceUpdate ?? 0));
  for (const track of tracks) {
    const eligible = eligibleSonarIndexes(snapshot, track);
    const best = eligible.reduce((bestIndex, index) => {
      if (groups[index].length < groups[bestIndex].length) return index;
      return distance(snapshot.sonars[index].position, track.position) <
        distance(snapshot.sonars[bestIndex].position, track.position)
        ? index
        : bestIndex;
    }, eligible[0]);
    groups[best].push(track);
  }
  return groups;
};

const trackUncertainty = (track: StrategyTrack) => {
  const covariance = track.covariance;
  const positionTrace = covariance ? Math.max(0, covariance[0]?.[0] ?? 0) + Math.max(0, covariance[1]?.[1] ?? 0) : 1;
  return positionTrace + 0.5 * (track.timeSinceUpdate ?? 0) + 2 * (1 - (track.confidence ?? 0.5));
};

const assignUncertaintyGreedy = (snapshot: StrategySnapshot) => {
  const groups = snapshot.sonars.map(() => [] as StrategyTrack[]);
  const tracks = [...snapshot.tracks].sort((a, b) => trackUncertainty(b) - trackUncertainty(a));
  for (const track of tracks) {
    const eligible = eligibleSonarIndexes(snapshot, track);
    const best = eligible.reduce((bestIndex, index) => {
      const candidate = groups[index].length * 10 + distance(snapshot.sonars[index].position, track.position);
      const incumbent = groups[bestIndex].length * 10 + distance(snapshot.sonars[bestIndex].position, track.position);
      return candidate < incumbent ? index : bestIndex;
    }, eligible[0]);
    groups[best].push(track);
  }
  return groups;
};

const planRoundRobinSector: HeadlessStrategyPlanner = (snapshot, strategyName) => {
  const sectorWidth = 30;
  const sectorCount = 6;
  const bucket = Math.floor(snapshot.simulationTime / 2.5);
  return decision(strategyName, snapshot, snapshot.sonars.map((sonar, index) => {
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
    const sector = (bucket + index * 2) % sectorCount;
    const minLocalAngle = sonar.minLocalAngle + sector * sectorWidth;
    return {
      sonarId: sonar.id,
      minLocalAngle,
      maxLocalAngle: Math.min(sonar.maxLocalAngle, minLocalAngle + sectorWidth),
      range: snapshot.physics.maxRange,
      assignedTargetIds: [],
      action: 'SEARCH_SECTOR',
    };
  }));
};

const planWithGroups = (
  strategyName: string,
  snapshot: StrategySnapshot,
  groups: StrategyTrack[][]
) => {
  const maxRange = snapshot.physics.maxRange;
  return decision(
    strategyName,
    snapshot,
    snapshot.sonars.map((sonar, index) => roiPlan(sonar, groups[index], maxRange))
  );
};

export const BASELINE_REGISTRY: Record<string, HeadlessStrategyPlanner> = {
  FULL_SCAN: planFullScan,
  NAIVE: planFullScan,
  NEAREST_ROI: (snapshot, strategyName) => planWithGroups(strategyName, snapshot, assignNearest(snapshot)),
  ROUND_ROBIN_ROI: (snapshot, strategyName) => planWithGroups(strategyName, snapshot, assignRoundRobin(snapshot)),
  ROUND_ROBIN_SECTOR: planRoundRobinSector,
  MAX_AOI_GREEDY: (snapshot, strategyName) => planWithGroups(strategyName, snapshot, assignMaxAoi(snapshot)),
  UNCERTAINTY_GREEDY: (snapshot, strategyName) => planWithGroups(strategyName, snapshot, assignUncertaintyGreedy(snapshot)),
  PID_ROI: (snapshot, strategyName) => planWithGroups(strategyName, snapshot, assignUncertaintyGreedy(snapshot)),
};

export const makeStrategyDecision = (strategyName: string, snapshot: StrategySnapshot): StrategyDecision => {
  const normalized = strategyName.toUpperCase();
  const planner = BASELINE_REGISTRY[normalized];
  if (!planner) {
    throw new Error(`Unknown headless benchmark strategy "${strategyName}"`);
  }
  return planner(snapshot, normalized);
};
