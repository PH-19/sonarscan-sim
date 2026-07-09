import { normalizeAngle } from '../../../utils/math';

export type AngleSweep = {
  startAngle: number;
  endAngle: number;
};

export const sweepWidthDeg = (sweep: AngleSweep) => Math.abs(sweep.endAngle - sweep.startAngle);

export const sweepDirection = (sweep: AngleSweep): 1 | -1 => (
  sweep.endAngle >= sweep.startAngle ? 1 : -1
);

export const angleInSweep = (angleDeg: number, sweep: AngleSweep, toleranceDeg = 1e-6) => {
  const width = sweepWidthDeg(sweep);
  if (width >= 360 - toleranceDeg) return true;

  if (sweepDirection(sweep) > 0) {
    const rel = normalizeAngle(angleDeg - sweep.startAngle);
    return rel <= width + toleranceDeg;
  }

  const rel = normalizeAngle(sweep.startAngle - angleDeg);
  return rel <= width + toleranceDeg;
};

export const angleAtSweepFraction = (sweep: AngleSweep, fraction: number) => {
  const t = Math.max(0, Math.min(1, fraction));
  return sweep.startAngle + (sweep.endAngle - sweep.startAngle) * t;
};

export const fractionAlongSweep = (angleDeg: number, sweep: AngleSweep) => {
  const width = sweepWidthDeg(sweep);
  if (width <= 1e-9) return 0;
  const rel = sweepDirection(sweep) > 0
    ? normalizeAngle(angleDeg - sweep.startAngle)
    : normalizeAngle(sweep.startAngle - angleDeg);
  return Math.max(0, Math.min(1, rel / width));
};
