import { Vector2 } from '../types';

export const degToRad = (deg: number) => (deg * Math.PI) / 180;
export const radToDeg = (rad: number) => (rad * 180) / Math.PI;

export const distance = (v1: Vector2, v2: Vector2) => {
  return Math.sqrt(Math.pow(v2.x - v1.x, 2) + Math.pow(v2.y - v1.y, 2));
};

export const normalizeAngle = (angle: number) => {
  let a = angle % 360;
  if (a < 0) a += 360;
  return a;
};

// Returns angle from source to target in degrees [0, 360)
export const angleToTarget = (source: Vector2, target: Vector2) => {
  const dy = target.y - source.y;
  const dx = target.x - source.x;
  let theta = Math.atan2(dy, dx); // rads -PI to PI
  theta = radToDeg(theta);
  return normalizeAngle(theta);
};

// Check if a point is within a sonar beam sector
export const isPointInSector = (
  point: Vector2,
  origin: Vector2,
  angleCenter: number,
  beamWidth: number,
  maxRange: number
) => {
  const dist = distance(point, origin);
  if (dist > maxRange) return false;

  const angleToPoint = angleToTarget(origin, point);
  const diff = Math.abs(angleToPoint - angleCenter);
  // Handle wrap around (e.g. 359 vs 1)
  const wrappedDiff = Math.min(diff, 360 - diff);
  
  return wrappedDiff <= beamWidth / 2;
};
