import { Vector2 } from '../../../types';
import { POOL_LENGTH, POOL_WIDTH } from '../../../constants';
import { degToRad } from '../../../utils/math';

export class PoolGeometry {
  distanceToBoundary(origin: Vector2, angleDeg: number) {
    const angRad = degToRad(angleDeg);
    const dx = Math.cos(angRad);
    const dy = Math.sin(angRad);
    const eps = 1e-6;
    let bestT = Infinity;

    const testX = (xEdge: number) => {
      if (Math.abs(dx) < eps) return;
      const t = (xEdge - origin.x) / dx;
      if (!(t > eps) || t >= bestT) return;
      const y = origin.y + t * dy;
      if (y < -eps || y > POOL_LENGTH + eps) return;
      bestT = t;
    };

    const testY = (yEdge: number) => {
      if (Math.abs(dy) < eps) return;
      const t = (yEdge - origin.y) / dy;
      if (!(t > eps) || t >= bestT) return;
      const x = origin.x + t * dx;
      if (x < -eps || x > POOL_WIDTH + eps) return;
      bestT = t;
    };

    testX(0);
    testX(POOL_WIDTH);
    testY(0);
    testY(POOL_LENGTH);

    return Number.isFinite(bestT) ? bestT : null;
  }

  distanceToVerticalLine(origin: Vector2, angleDeg: number, xLine: number) {
    const angRad = degToRad(angleDeg);
    const dx = Math.cos(angRad);
    const dy = Math.sin(angRad);
    const eps = 1e-6;
    if (Math.abs(dx) < eps) return null;
    const t = (xLine - origin.x) / dx;
    if (!(t > eps)) return null;
    const y = origin.y + t * dy;
    if (y < -eps || y > POOL_LENGTH + eps) return null;
    return t;
  }

  wallProximity(point: Vector2) {
    return Math.min(point.x, POOL_WIDTH - point.x, point.y, POOL_LENGTH - point.y);
  }
}
