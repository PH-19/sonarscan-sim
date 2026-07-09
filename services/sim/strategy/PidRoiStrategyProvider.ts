import { SonarStrategyPlan, StrategyDecision, StrategySnapshot, StrategySonar, StrategyTrack } from '../../../types';
import { angleToTarget, distance, normalizeAngle } from '../../../utils/math';
import { StrategyProvider } from './StrategyProvider';

const STRATEGY_ID = 'PID_ROI';
const MIN_ROI_WIDTH_DEG = 12;
const MAX_ROI_WIDTH_DEG = 55;
const SEARCH_WIDTH_DEG = 30;
const RANGE_PADDING_M = 5;

type PidState = {
  integral: number;
  previousError: number;
  lastTime: number;
};

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

const signedAngleError = (target: number, current: number) => {
  return ((target - current + 540) % 360) - 180;
};

const relativeSectorAngle = (sonar: StrategySonar, track: StrategyTrack) => {
  return normalizeAngle(angleToTarget(sonar.position, track.position) - sonar.mountYaw);
};

const covarianceTrace = (track: StrategyTrack) => {
  const covariance = track.covariance;
  return Math.max(0, covariance?.[0]?.[0] ?? 0) + Math.max(0, covariance?.[1]?.[1] ?? 0);
};

const predictTrack = (track: StrategyTrack, horizonSec: number): StrategyTrack => {
  if (!track.velocity) return track;
  return {
    ...track,
    position: {
      x: track.position.x + track.velocity.x * horizonSec,
      y: track.position.y + track.velocity.y * horizonSec,
    },
  };
};

const fullScanPlan = (sonar: StrategySonar, maxRange: number): SonarStrategyPlan => ({
  sonarId: sonar.id,
  minLocalAngle: sonar.minLocalAngle,
  maxLocalAngle: sonar.maxLocalAngle,
  range: maxRange,
  assignedTargetIds: [],
  action: sonar.available ? 'FULL_SWEEP' : 'IDLE',
});

const idlePlan = (sonar: StrategySonar): SonarStrategyPlan => ({
  sonarId: sonar.id,
  minLocalAngle: sonar.currentLocalAngle,
  maxLocalAngle: Math.min(sonar.maxLocalAngle, sonar.currentLocalAngle + 1),
  range: 1,
  assignedTargetIds: [],
  action: 'IDLE',
});

const searchPlan = (snapshot: StrategySnapshot, sonar: StrategySonar, sonarIndex: number): SonarStrategyPlan => {
  if (!sonar.available) return idlePlan(sonar);
  const oldestBin = [...sonar.coverageBins].sort((a, b) => b.ageSec - a.ageSec)[0];
  const fallbackCenter = sonar.minLocalAngle
    + (((Math.floor(snapshot.simulationTime / 2.5) + sonarIndex) % 6) + 0.5)
    * ((sonar.maxLocalAngle - sonar.minLocalAngle) / 6);
  const center = oldestBin
    ? (oldestBin.minLocalAngle + oldestBin.maxLocalAngle) / 2
    : fallbackCenter;
  const half = SEARCH_WIDTH_DEG / 2;
  return {
    sonarId: sonar.id,
    minLocalAngle: clamp(center - half, sonar.minLocalAngle, sonar.maxLocalAngle),
    maxLocalAngle: clamp(center + half, sonar.minLocalAngle, sonar.maxLocalAngle),
    range: snapshot.physics.maxRange,
    assignedTargetIds: [],
    action: 'SEARCH_SECTOR',
  };
};

const trackPriority = (track: StrategyTrack) => {
  const age = track.timeSinceUpdate ?? 0;
  const confidence = track.confidence ?? 0.5;
  return age * 2.5 + Math.sqrt(covarianceTrace(track)) * 1.5 + (1 - confidence) * 4;
};

const assignPidTargets = (snapshot: StrategySnapshot) => {
  const assignments = new Map<string, StrategyTrack>();
  const usedTracks = new Set<string>();
  const candidates: {
    sonar: StrategySonar;
    sonarIndex: number;
    track: StrategyTrack;
    predicted: StrategyTrack;
    localAngle: number;
    range: number;
    score: number;
  }[] = [];

  snapshot.sonars.forEach((sonar, sonarIndex) => {
    if (!sonar.available) return;
    for (const track of snapshot.tracks) {
      if (track.status === 'lost') continue;
      const horizonSec = clamp(0.8 + (track.timeSinceUpdate ?? 0) * 0.35, 0.8, 3.0);
      const predicted = predictTrack(track, horizonSec);
      const localAngle = relativeSectorAngle(sonar, predicted);
      if (localAngle < sonar.minLocalAngle || localAngle > sonar.maxLocalAngle) continue;
      const range = distance(sonar.position, predicted.position);
      const angularError = Math.abs(signedAngleError(localAngle, sonar.currentLocalAngle));
      candidates.push({
        sonar,
        sonarIndex,
        track,
        predicted,
        localAngle,
        range,
        score: trackPriority(track) - 0.025 * range - 0.006 * angularError,
      });
    }
  });

  candidates.sort((a, b) => b.score - a.score);
  const usedSonars = new Set<string>();
  for (const candidate of candidates) {
    if (usedSonars.has(candidate.sonar.id) || usedTracks.has(candidate.track.id)) continue;
    usedSonars.add(candidate.sonar.id);
    usedTracks.add(candidate.track.id);
    assignments.set(candidate.sonar.id, candidate.predicted);
  }
  return assignments;
};

export class PidRoiStrategyProvider implements StrategyProvider {
  invocationCount = 0;
  readonly metadata = {
    strategyId: STRATEGY_ID,
    implementationLanguage: 'typescript' as const,
    implementation: 'services/sim/strategy/PidRoiStrategyProvider:PidRoiStrategyProvider',
    codeVersion: 'pid-roi-v1',
    parameters: {
      kp: 0.82,
      ki: 0.015,
      kd: 0.18,
      minRoiWidthDeg: MIN_ROI_WIDTH_DEG,
      maxRoiWidthDeg: MAX_ROI_WIDTH_DEG,
      searchWidthDeg: SEARCH_WIDTH_DEG,
    },
  };

  private readonly states = new Map<string, PidState>();

  async plan(snapshot: StrategySnapshot): Promise<StrategyDecision> {
    this.invocationCount += 1;
    const maxRange = snapshot.physics.maxRange;
    const assignments = assignPidTargets(snapshot);
    const plans = snapshot.sonars.map((sonar, sonarIndex) => {
      if (!sonar.available) return idlePlan(sonar);
      const target = assignments.get(sonar.id);
      if (!target) {
        if (snapshot.tracks.length === 0) return searchPlan(snapshot, sonar, sonarIndex);
        return searchPlan(snapshot, sonar, sonarIndex);
      }

      const targetAngle = clamp(relativeSectorAngle(sonar, target), sonar.minLocalAngle, sonar.maxLocalAngle);
      const now = snapshot.simulationTime;
      const state = this.states.get(sonar.id) ?? { integral: 0, previousError: 0, lastTime: now };
      const dt = clamp(now - state.lastTime, 0.05, 2.0);
      const error = signedAngleError(targetAngle, sonar.currentLocalAngle);
      state.integral = clamp(state.integral + error * dt, -90, 90);
      const derivative = (error - state.previousError) / dt;
      state.previousError = error;
      state.lastTime = now;
      this.states.set(sonar.id, state);

      const correction = 0.82 * error + 0.015 * state.integral + 0.18 * derivative;
      const center = clamp(sonar.currentLocalAngle + correction, sonar.minLocalAngle, sonar.maxLocalAngle);
      const uncertaintyWidth = Math.sqrt(covarianceTrace(target)) * 4 + (target.timeSinceUpdate ?? 0) * 2;
      const halfWidth = clamp(MIN_ROI_WIDTH_DEG / 2 + uncertaintyWidth, MIN_ROI_WIDTH_DEG / 2, MAX_ROI_WIDTH_DEG / 2);
      const scanRange = clamp(distance(sonar.position, target.position) + RANGE_PADDING_M + Math.sqrt(covarianceTrace(target)), 1, maxRange);

      return {
        sonarId: sonar.id,
        minLocalAngle: clamp(center - halfWidth, sonar.minLocalAngle, sonar.maxLocalAngle),
        maxLocalAngle: clamp(center + halfWidth, sonar.minLocalAngle, sonar.maxLocalAngle),
        range: scanRange,
        assignedTargetIds: [target.id],
        action: 'TRACK_ROI' as const,
      };
    });

    if (plans.every(plan => plan.action === 'IDLE')) {
      return {
        strategy: STRATEGY_ID,
        generatedAt: snapshot.simulationTime,
        plans: snapshot.sonars.map(sonar => fullScanPlan(sonar, maxRange)),
      };
    }

    return {
      strategy: STRATEGY_ID,
      generatedAt: snapshot.simulationTime,
      plans,
    };
  }

  async close() {}
}
