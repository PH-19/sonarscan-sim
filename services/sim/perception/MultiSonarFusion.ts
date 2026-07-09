import { Detection, Vector2 } from '../../../types';

const DEFAULT_SPATIAL_GATE_M = 1.5;

const distance = (a: Vector2, b: Vector2) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Merge near-simultaneous detections of the same physical object before tracking.
 * This module has no access to truth; grouping uses only position and confidence.
 */
export const fuseMultiSonarDetections = (
  detections: Detection[],
  fusionTime: number,
  spatialGateM = DEFAULT_SPATIAL_GATE_M
): Detection[] => {
  const groups: Detection[][] = [];

  for (const detection of [...detections].sort((a, b) => b.confidence - a.confidence)) {
    const group = groups.find(items => {
      const center = weightedCenter(items);
      const meanTime = items.reduce((sum, item) => sum + item.time, 0) / items.length;
      return Math.abs(meanTime - detection.time) <= 1.0 && distance(center, detection.position) <= spatialGateM;
    });
    if (group) group.push(detection);
    else groups.push([detection]);
  }

  return groups.map((items, index) => {
    const position = weightedCenter(items);
    const weight = items.reduce((sum, item) => sum + Math.max(0.05, item.confidence), 0);
    const mean = (selector: (item: Detection) => number) => (
      items.reduce((sum, item) => sum + selector(item) * Math.max(0.05, item.confidence), 0) / weight
    );
    return {
      id: `fusion:${Math.round(fusionTime * 1000)}:${index}`,
      time: mean(item => item.time),
      sonarId: items.map(item => item.sonarId).sort().join('+'),
      position,
      range: mean(item => item.range),
      bearing: mean(item => item.bearing),
      confidence: 1 - items.reduce((miss, item) => miss * (1 - item.confidence), 1),
      intensity: Math.max(...items.map(item => item.intensity)),
    };
  });
};

const weightedCenter = (items: Detection[]): Vector2 => {
  const weight = items.reduce((sum, item) => sum + Math.max(0.05, item.confidence), 0);
  return {
    x: items.reduce((sum, item) => sum + item.position.x * Math.max(0.05, item.confidence), 0) / weight,
    y: items.reduce((sum, item) => sum + item.position.y * Math.max(0.05, item.confidence), 0) / weight,
  };
};
