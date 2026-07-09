import { BeamReturn, SonarCommand, SonarFrame, SonarState, SwimmerTruth } from '../../../types';
import {
  IMAGING_BLOB_RADIUS_BINS,
  IMAGING_BLOB_SIGMA_BINS,
  IMAGING_ECHO_RANGE_ATTENUATION_M,
  IMAGING_ECHO_STRENGTH,
  IMAGING_FOV_DEG,
  IMAGING_GHOST_RANGE_OFFSET_M,
  IMAGING_GHOST_REL_STRENGTH,
  IMAGING_NOISE_FLOOR,
  IMAGING_NOISE_STD,
  IMAGING_RANGE_BINS,
  IMAGING_SPECKLE_PROB,
  IMAGING_SPECKLE_STRENGTH,
  IMAGING_STATIC_ECHO_SIGMA_BINS,
  IMAGING_STATIC_LANE_ECHO_STRENGTH,
  IMAGING_STATIC_WALL_ECHO_STRENGTH,
  IMAGING_WEAK_BAND_PROB,
  IMAGING_WEAK_BAND_STRENGTH,
  MAX_RANGE_NAIVE,
  POOL_LANE_COUNT,
  POOL_WIDTH,
  SIM_SWIMMER_DIAMETER_M,
  SIM_SWIMMER_LENGTH_M,
} from '../../../constants';
import { angleToTarget, degToRad, distance, normalizeAngle } from '../../../utils/math';
import { createLCGRng, hashStringToUint32 } from '../../../utils/rng';
import { fieldNormal, fieldUniform } from '../../../utils/randomField';
import { SonarTimingModel } from './SonarTimingModel';
import { PoolGeometry } from './PoolGeometry';
import { localToWorldBearing } from './SonarCoordinates';

export type MeasurementParams = {
  noiseScale: number;
  speckleProb: number;
};

export type TruthSampler = (time: number) => SwimmerTruth[];

const signedDeltaAngleDeg = (targetDeg: number, centerDeg: number) => {
  return ((targetDeg - centerDeg + 540) % 360) - 180;
};

export class MeasurementModel {
  private readonly geometry = new PoolGeometry();

  constructor(
    private readonly timing: SonarTimingModel,
    private readonly seed: number,
    private params: MeasurementParams
  ) {}

  setParams(params: Partial<MeasurementParams>) {
    this.params = { ...this.params, ...params };
  }

  buildFrame(sonar: SonarState, command: SonarCommand, sampleTruth: TruthSampler): SonarFrame {
    const beamCount = this.timing.scanBeamCount(command);
    const angleBins = Math.max(2, beamCount);
    const rangeBins = IMAGING_RANGE_BINS;
    const intensities = new Float32Array(angleBins * rangeBins);
    const beams: BeamReturn[] = [];
    const scanStartLocalAngle = command.scanStartLocalAngle;
    const startAngle = localToWorldBearing(sonar, scanStartLocalAngle);
    const endAngle = localToWorldBearing(sonar, command.endLocalAngle);
    const minAngle = Math.min(startAngle, endAngle);
    const maxAngle = Math.max(startAngle, endAngle);

    for (let beamIndex = 0; beamIndex < beamCount; beamIndex++) {
      const localAngle = this.timing.beamLocalAngle(command, beamIndex);
      const angle = localToWorldBearing(sonar, localAngle);
      const time = this.timing.beamTime(command, beamIndex);
      const beamRange = this.timing.beamRange(command, beamIndex);
      const rangeStep = beamRange / rangeBins;
      const swimmers = sampleTruth(time);
      const aIdx = beamIndex;
      const base = aIdx * rangeBins;
      const timeSlot = Math.round(time * 1000);
      const angleSlot = Math.round(localAngle * 10);
      const dynRng = createLCGRng(hashStringToUint32(`${this.seed}|sonar|${sonar.id}|dyn|${timeSlot}|angle|${angleSlot}`));
      const sonarSlot = hashStringToUint32(sonar.id);
      const environmentTimeSlot = Math.floor(time * 4); // 250ms coherent water/noise field.
      const worldAngleSlot = Math.round(angle * 10);

      for (let r = 0; r < rangeBins; r++) {
        const rangeM = (r + 0.5) * rangeStep;
        const physicalRangeSlot = Math.round(rangeM * 20); // 5cm canonical cells.
        const rangeNoise = 1 + rangeM / Math.max(1, MAX_RANGE_NAIVE);
        let v = IMAGING_NOISE_FLOOR + fieldNormal(
          this.seed,
          sonarSlot,
          environmentTimeSlot,
          worldAngleSlot,
          physicalRangeSlot
        ) * IMAGING_NOISE_STD * this.params.noiseScale * rangeNoise;
        if (fieldUniform(this.seed, sonarSlot, environmentTimeSlot, worldAngleSlot, physicalRangeSlot, 1) < this.params.speckleProb) {
          const u = Math.max(1e-6, fieldUniform(this.seed, sonarSlot, environmentTimeSlot, worldAngleSlot, physicalRangeSlot, 2));
          const heavyTail = 1 / Math.pow(1 - u, 1 / 2.2) - 1;
          v += IMAGING_SPECKLE_STRENGTH * heavyTail;
        }
        intensities[base + r] = Math.max(0, v);
      }

      if (dynRng.next() < IMAGING_WEAK_BAND_PROB) {
        this.addGaussianEcho(intensities, base, dynRng.nextInt(rangeBins), rangeBins - 1, IMAGING_WEAK_BAND_STRENGTH * this.params.noiseScale, 1.6);
      }

      this.writeStaticClutter(intensities, base, sonar, angle, beamRange, rangeStep, rangeBins, dynRng.next());
      this.writeSwimmerEchoes(intensities, base, sonar, angle, beamRange, rangeStep, rangeBins, swimmers, dynRng.next());

      beams.push({
        beamIndex,
        time,
        angle,
        localAngle,
        range: beamRange,
        intensities: Array.from(intensities.slice(base, base + rangeBins)),
      });
    }

    return {
      sonarId: command.sonarId,
      commandId: command.commandId,
      sonarPosition: { ...sonar.position },
      startTime: command.startTime,
      endTime: this.timing.endTime(command),
      beams,
      angleBins,
      rangeBins,
      startAngle,
      endAngle,
      minAngle,
      maxAngle,
      startLocalAngle: scanStartLocalAngle,
      endLocalAngle: command.endLocalAngle,
      range: command.range,
      intensities,
    };
  }

  private writeStaticClutter(
    intensities: Float32Array,
    base: number,
    sonar: SonarState,
    angle: number,
    maxRange: number,
    rangeStep: number,
    rangeBins: number,
    randomPhase: number
  ) {
    const wallDist = this.geometry.distanceToBoundary(sonar.position, angle);
    if (wallDist !== null && wallDist <= maxRange) {
      this.addGaussianEcho(intensities, base, wallDist / rangeStep, rangeBins - 1, IMAGING_STATIC_WALL_ECHO_STRENGTH, IMAGING_STATIC_ECHO_SIGMA_BINS);
      const ghostDist = wallDist + IMAGING_GHOST_RANGE_OFFSET_M * (0.6 + 0.8 * randomPhase);
      if (ghostDist <= maxRange) {
        this.addGaussianEcho(
          intensities,
          base,
          ghostDist / rangeStep,
          rangeBins - 1,
          IMAGING_STATIC_WALL_ECHO_STRENGTH * IMAGING_GHOST_REL_STRENGTH * this.params.noiseScale,
          IMAGING_STATIC_ECHO_SIGMA_BINS * 1.4
        );
      }
    }

    for (let k = 1; k < Math.max(1, POOL_LANE_COUNT); k++) {
      const xLine = POOL_WIDTH * k / Math.max(1, POOL_LANE_COUNT);
      const d = this.geometry.distanceToVerticalLine(sonar.position, angle, xLine);
      if (d === null || d > maxRange) continue;
      this.addGaussianEcho(intensities, base, d / rangeStep, rangeBins - 1, IMAGING_STATIC_LANE_ECHO_STRENGTH, IMAGING_STATIC_ECHO_SIGMA_BINS);
    }
  }

  private writeSwimmerEchoes(
    intensities: Float32Array,
    base: number,
    sonar: SonarState,
    angle: number,
    maxRange: number,
    rangeStep: number,
    rangeBins: number,
    swimmers: SwimmerTruth[],
    randomPhase: number
  ) {
    const sigma2 = IMAGING_BLOB_SIGMA_BINS * IMAGING_BLOB_SIGMA_BINS;
    let nearestVisibleRange = Infinity;

    for (const swimmer of [...swimmers].sort((a, b) => distance(sonar.position, a.position) - distance(sonar.position, b.position))) {
      const dist = distance(sonar.position, swimmer.position);
      if (dist > maxRange) continue;
      const targetAngle = angleToTarget(sonar.position, swimmer.position);
      const dAng = signedDeltaAngleDeg(targetAngle, angle);
      const bodyHeading = Math.atan2(swimmer.velocity.y, swimmer.velocity.x) * 180 / Math.PI;
      const broadside = Math.abs(Math.sin(degToRad(targetAngle - bodyHeading)));
      const projectedWidth = SIM_SWIMMER_DIAMETER_M
        + (SIM_SWIMMER_LENGTH_M - SIM_SWIMMER_DIAMETER_M) * broadside;
      const targetHalfAngle = Math.atan2(projectedWidth / 2, Math.max(0.75, dist)) * 180 / Math.PI;
      const angularSigma = Math.max(IMAGING_FOV_DEG / 2.355, targetHalfAngle / 1.5);
      if (Math.abs(dAng) > 3 * angularSigma) continue;

      const angularResponse = Math.exp(-(dAng * dAng) / (2 * angularSigma * angularSigma));
      const occlusion = nearestVisibleRange < Infinity && dist > nearestVisibleRange + SIM_SWIMMER_LENGTH_M
        ? 0.35
        : 1.0;
      nearestVisibleRange = Math.min(nearestVisibleRange, dist);
      const wallPenalty = Math.max(0.55, Math.min(1, this.geometry.wallProximity(swimmer.position) / 2));
      const spreading = 1 / (1 + Math.pow(dist / 30, 2));
      const echo = IMAGING_ECHO_STRENGTH
        * Math.exp(-dist / Math.max(1e-6, IMAGING_ECHO_RANGE_ATTENUATION_M))
        * spreading
        * angularResponse
        * (0.65 + 0.35 * broadside)
        * wallPenalty
        * occlusion;

      const center = dist / rangeStep;
      const r0 = Math.floor(center);
      for (let dr = -IMAGING_BLOB_RADIUS_BINS; dr <= IMAGING_BLOB_RADIUS_BINS; dr++) {
        const r = r0 + dr;
        if (r < 0 || r >= rangeBins) continue;
        const w = Math.exp(-(dr * dr) / (2 * sigma2));
        intensities[base + r] += echo * w;
      }

      const ghostDist = dist + IMAGING_GHOST_RANGE_OFFSET_M * (0.6 + 0.8 * randomPhase);
      if (ghostDist <= maxRange) {
        this.addGaussianEcho(
          intensities,
          base,
          ghostDist / rangeStep,
          rangeBins - 1,
          echo * IMAGING_GHOST_REL_STRENGTH * this.params.noiseScale,
          IMAGING_BLOB_SIGMA_BINS * 1.3
        );
      }
    }
  }

  private addGaussianEcho(
    intensities: Float32Array,
    base: number,
    rCenter: number,
    rMax: number,
    amp: number,
    sigmaBins: number
  ) {
    if (!(amp > 0) || !(sigmaBins > 0)) return;
    const r0 = Math.floor(rCenter);
    const radius = Math.max(1, Math.ceil(sigmaBins * 3));
    const s2 = sigmaBins * sigmaBins;
    for (let dr = -radius; dr <= radius; dr++) {
      const r = r0 + dr;
      if (r < 0 || r > rMax) continue;
      const w = Math.exp(-(dr * dr) / (2 * s2));
      intensities[base + r] += amp * w;
    }
  }
}
