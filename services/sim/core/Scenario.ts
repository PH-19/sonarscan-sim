import { SonarMode, SonarState, Vector2 } from '../../../types';
import {
  MAX_RANGE_NAIVE,
  POOL_LENGTH,
  POOL_WIDTH,
  SONAR_LOCAL_MAX_ANGLE,
  SONAR_LOCAL_MIN_ANGLE,
} from '../../../constants';

export const DEFAULT_SONAR_COUNT = 4;
export const MIN_SONAR_COUNT = 1;
export const MAX_SONAR_COUNT = 6;

export type SupportedSonarCount = 1 | 2 | 3 | 4 | 5 | 6;

type SonarPlacement = {
  position: Vector2;
  mountAngle: number;
};

export const normalizeSonarCount = (count = DEFAULT_SONAR_COUNT): SupportedSonarCount => {
  if (!Number.isFinite(count) || !Number.isInteger(count)) {
    throw new Error(`sonarCount must be an integer between ${MIN_SONAR_COUNT} and ${MAX_SONAR_COUNT}`);
  }
  if (count < MIN_SONAR_COUNT || count > MAX_SONAR_COUNT) {
    throw new Error(`sonarCount must be between ${MIN_SONAR_COUNT} and ${MAX_SONAR_COUNT}`);
  }
  return count as SupportedSonarCount;
};

const midX = POOL_WIDTH / 2;
const midY = POOL_LENGTH / 2;
const oneThirdY = POOL_LENGTH / 3;
const twoThirdsY = (2 * POOL_LENGTH) / 3;

// Simulator coordinates:
// - x = 0 and x = POOL_WIDTH are the two long pool edges.
// - y = 0 and y = POOL_LENGTH are the two short pool edges.
// mountAngle is the inward-facing 180° sector centre in world-bearing degrees.
const xMinLongEdge = (y: number): SonarPlacement => ({
  position: { x: 0, y },
  mountAngle: 0,
});
const xMaxLongEdge = (y: number): SonarPlacement => ({
  position: { x: POOL_WIDTH, y },
  mountAngle: 180,
});
const yMinShortEdge = (x: number): SonarPlacement => ({
  position: { x, y: 0 },
  mountAngle: 90,
});
const yMaxShortEdge = (x: number): SonarPlacement => ({
  position: { x, y: POOL_LENGTH },
  mountAngle: 270,
});

export const SONAR_LAYOUTS_BY_COUNT: Record<SupportedSonarCount, readonly SonarPlacement[]> = {
  1: [
    xMinLongEdge(midY),
  ],
  2: [
    xMinLongEdge(midY),
    xMaxLongEdge(midY),
  ],
  3: [
    xMinLongEdge(midY),
    yMinShortEdge(midX),
    yMaxShortEdge(midX),
  ],
  4: [
    xMinLongEdge(midY),
    xMaxLongEdge(midY),
    yMinShortEdge(midX),
    yMaxShortEdge(midX),
  ],
  5: [
    xMinLongEdge(oneThirdY),
    xMinLongEdge(twoThirdsY),
    xMaxLongEdge(midY),
    yMinShortEdge(midX),
    yMaxShortEdge(midX),
  ],
  6: [
    xMinLongEdge(oneThirdY),
    xMaxLongEdge(oneThirdY),
    xMinLongEdge(twoThirdsY),
    xMaxLongEdge(twoThirdsY),
    yMinShortEdge(midX),
    yMaxShortEdge(midX),
  ],
};

export const makeSonarsByCount = (count = DEFAULT_SONAR_COUNT): SonarState[] => {
  const sonarCount = normalizeSonarCount(count);
  const makeSonar = (id: string, position: Vector2, mountAngle: number): SonarState => {
    const mountYaw = mountAngle - 90;
    return {
      id,
      position,
      angle: mountAngle,
      mountAngle,
      mountYaw,
      available: true,
      minLocalAngle: SONAR_LOCAL_MIN_ANGLE,
      maxLocalAngle: SONAR_LOCAL_MAX_ANGLE,
      currentLocalAngle: SONAR_LOCAL_MIN_ANGLE,
      currentAngle: mountYaw,
      scanDirection: 1,
      mode: SonarMode.IDLE,
      targetLocalAngle: SONAR_LOCAL_MAX_ANGLE,
      targetAngle: mountYaw + SONAR_LOCAL_MAX_ANGLE,
      scanRange: MAX_RANGE_NAIVE,
      pingAccumulator: 0,
      lastScanTime: 0,
      cycleDuration: 0,
      detectedPoints: [],
      matchedPoints: [],
      commandProgress: 0,
      activeAction: 'IDLE',
      activeScanMinLocalAngle: SONAR_LOCAL_MIN_ANGLE,
      activeScanMaxLocalAngle: SONAR_LOCAL_MAX_ANGLE,
      assignedTargetIds: [],
    };
  };

  return SONAR_LAYOUTS_BY_COUNT[sonarCount].map((placement, index) => (
    makeSonar(`S${index + 1}`, { ...placement.position }, placement.mountAngle)
  ));
};
