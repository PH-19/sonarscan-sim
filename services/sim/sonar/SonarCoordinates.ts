import { SonarConfig } from '../../../types';
import { normalizeAngle } from '../../../utils/math';

export type SonarMount = Pick<SonarConfig, 'mountYaw'>;

/** Convert a mechanical local azimuth (degrees) to a world bearing (degrees). */
export const localToWorldBearing = (sonar: SonarMount, localAngleDeg: number) => (
  normalizeAngle(sonar.mountYaw + localAngleDeg)
);

/**
 * Convert a world bearing to the equivalent local azimuth nearest the mechanical
 * interval. The caller still decides whether the result is inside its limits.
 */
export const worldToLocalAngle = (sonar: SonarMount, worldBearingDeg: number) => (
  normalizeAngle(worldBearingDeg - sonar.mountYaw)
);
