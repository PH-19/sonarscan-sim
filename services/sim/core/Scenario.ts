import { SonarMode, SonarState, Vector2 } from '../../../types';
import {
  PING360_MAX_RANGE_M,
  POOL_LENGTH,
  POOL_WIDTH,
  SONAR_LOCAL_MAX_ANGLE,
  SONAR_LOCAL_MIN_ANGLE,
} from '../../../constants';

export const DEFAULT_SONAR_COUNT = 4;
export const MIN_SONAR_COUNT = 1;
export const MAX_SONAR_COUNT = 40;

export const SONAR_LAYOUT_NAMES = [
  'long_edges',
  'mixed_2_short',
  'mixed_4_short',
] as const;
export type SonarLayoutName = typeof SONAR_LAYOUT_NAMES[number];
export const DEFAULT_SONAR_LAYOUT: SonarLayoutName = 'long_edges';

export type SupportedSonarCount = number;

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

export const normalizeSonarLayout = (
  layout: string = DEFAULT_SONAR_LAYOUT,
): SonarLayoutName => {
  if (!(SONAR_LAYOUT_NAMES as readonly string[]).includes(layout)) {
    throw new Error(`sonarLayout must be one of: ${SONAR_LAYOUT_NAMES.join(', ')}`);
  }
  return layout as SonarLayoutName;
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

// A staggered long-edge gate array keeps working range close to the 20 m pool
// width. Alternating sides at half-station offset also avoids mirror-symmetric
// viewpoints while retaining the faster cross-pool scans.
const longEdgeLayout = (count: number): SonarPlacement[] => {
  return Array.from({ length: count }, (_, index) => {
    const y = POOL_LENGTH * (index + 0.5) / count;
    return index % 2 === 0 ? xMinLongEdge(y) : xMaxLongEdge(y);
  });
};

const shortEdgeLayout = (count: number): SonarPlacement[] => {
  const pairCount = Math.max(1, Math.ceil(count / 2));
  const placements: SonarPlacement[] = [];
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const x = POOL_WIDTH * (pairIndex + 0.5) / pairCount;
    placements.push(yMinShortEdge(x));
    if (placements.length < count) placements.push(yMaxShortEdge(x));
  }
  return placements;
};

const mixedPerimeterLayout = (
  count: SupportedSonarCount,
  requestedShortEdgeCount: 2 | 4,
): SonarPlacement[] => {
  if (count <= 2) return longEdgeLayout(count);
  // Keep at least two long-edge units so "mixed" always tests complementary
  // geometry rather than silently becoming a short-edge-only deployment.
  const shortEdgeCount = Math.min(requestedShortEdgeCount, count - 2);
  const longEdgeCount = count - shortEdgeCount;
  return [
    ...longEdgeLayout(longEdgeCount),
    ...shortEdgeLayout(shortEdgeCount),
  ];
};

export const SONAR_LAYOUTS_BY_COUNT: Readonly<Record<number, readonly SonarPlacement[]>> = {
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

export const makeSonarsByCount = (
  count = DEFAULT_SONAR_COUNT,
  layout: SonarLayoutName = DEFAULT_SONAR_LAYOUT,
): SonarState[] => {
  const sonarCount = normalizeSonarCount(count);
  const sonarLayout = normalizeSonarLayout(layout);
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
      scanRange: PING360_MAX_RANGE_M,
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

  // Preserve the historical one-to-three diagnostic layouts. Deployment
  // layout comparisons in this project begin at four units.
  const placements = sonarCount < 4
    ? SONAR_LAYOUTS_BY_COUNT[sonarCount]
    : sonarLayout === 'long_edges'
      ? longEdgeLayout(sonarCount)
      : mixedPerimeterLayout(sonarCount, sonarLayout === 'mixed_4_short' ? 4 : 2);
  return placements.map((placement, index) => (
    makeSonar(`S${index + 1}`, { ...placement.position }, placement.mountAngle)
  ));
};
