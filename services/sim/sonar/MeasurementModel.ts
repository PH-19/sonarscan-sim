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
  PING360_MAX_RANGE_M,
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
  noiseFloorScale?: number;
  staticClutterScale?: number;
  targetEchoStrengthScale?: number;
  targetLengthM?: number;
  targetDiameterM?: number;
  targetRangeRadiusM?: number;
  targetRangeSigmaM?: number;
  targetRangeVariation?: number;
  targetTextureStrength?: number;
  targetSecondaryLobeStrength?: number;
  targetSecondaryLobeOffsetM?: number;
  structuredBackgroundStrength?: number;
  structuredBackgroundThreshold?: number;
  structuredBackgroundAngleScaleDeg?: number;
  structuredBackgroundRangeScaleM?: number;
  backgroundFrameVariation?: number;
  backgroundThreshold?: number;
  nearRangeReverbStrength?: number;
  nearRangeReverbLengthM?: number;
  nearRangeReverbLogVariation?: number;
  angularBandStrength?: number;
  rangeStripeStrength?: number;
  targetEchoDropout?: number;
  targetDropoutResidual?: number;
  targetHaloStrength?: number;
  targetHaloSigmaM?: number;
  rangeBins?: number;
  /** Optional display-grid step; physical timing still uses command.angularStepDeg. */
  recoveryAngularStepDeg?: number;
};

export type TruthSampler = (time: number) => SwimmerTruth[];

const signedDeltaAngleDeg = (targetDeg: number, centerDeg: number) => {
  return ((targetDeg - centerDeg + 540) % 360) - 180;
};

export class MeasurementModel {
  private readonly geometry = new PoolGeometry();
  private laneCount = POOL_LANE_COUNT;

  constructor(
    private readonly timing: SonarTimingModel,
    private readonly seed: number,
    private params: MeasurementParams
  ) {}

  setParams(params: Partial<MeasurementParams>) {
    this.params = { ...this.params, ...params };
  }

  replaceParams(params: MeasurementParams) {
    this.params = { ...params };
  }

  setLaneCount(laneCount: number) {
    this.laneCount = Number.isFinite(laneCount)
      ? Math.max(1, Math.min(20, Math.floor(laneCount)))
      : POOL_LANE_COUNT;
  }

  buildFrame(sonar: SonarState, command: SonarCommand, sampleTruth: TruthSampler): SonarFrame {
    const beamCount = this.timing.scanBeamCount(command);
    const acquiredAngleBins = Math.max(2, beamCount);
    const rangeBins = Number.isFinite(this.params.rangeBins)
      ? Math.max(16, Math.min(4096, Math.floor(this.params.rangeBins!)))
      : IMAGING_RANGE_BINS;
    const acquiredIntensities = new Float32Array(acquiredAngleBins * rangeBins);
    const beams: BeamReturn[] = [];
    const scanStartLocalAngle = command.scanStartLocalAngle;
    const startAngle = localToWorldBearing(sonar, scanStartLocalAngle);
    const endAngle = localToWorldBearing(sonar, command.endLocalAngle);
    const minAngle = Math.min(startAngle, endAngle);
    const maxAngle = Math.max(startAngle, endAngle);
    const sonarSlot = hashStringToUint32(sonar.id);
    const frameSlot = Math.floor(command.startTime * 4);
    const frameVariation = Math.max(0, Math.min(0.95, this.params.backgroundFrameVariation ?? 0));
    const backgroundFrameScale = Math.max(0.05, 1 + frameVariation * (
      2 * fieldUniform(this.seed, sonarSlot, frameSlot, 0, 0, 47) - 1
    ));
    const nearLogVariation = Math.max(0, Math.min(2.5, this.params.nearRangeReverbLogVariation ?? 0));
    const nearFrameNormal = fieldNormal(this.seed, sonarSlot, frameSlot, 0, 0, 53);
    const nearFrameScale = Math.exp(
      nearLogVariation * nearFrameNormal - 0.5 * nearLogVariation * nearLogVariation
    );

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
      const environmentTimeSlot = Math.floor(time * 4); // 250ms coherent water/noise field.
      const worldAngleSlot = Math.round(angle * 10);

      for (let r = 0; r < rangeBins; r++) {
        const rangeM = (r + 0.5) * rangeStep;
        const physicalRangeSlot = Math.round(rangeM * 20); // 5cm canonical cells.
        const rangeNoise = 1 + rangeM / PING360_MAX_RANGE_M;
        let v = IMAGING_NOISE_FLOOR * (this.params.noiseFloorScale ?? 1) + fieldNormal(
          this.seed,
          sonarSlot,
          environmentTimeSlot,
          worldAngleSlot,
          physicalRangeSlot
        ) * IMAGING_NOISE_STD * this.params.noiseScale * rangeNoise;
        const structuredStrength = this.params.structuredBackgroundStrength ?? 0;
        const structuredThreshold = Math.max(0, this.params.structuredBackgroundThreshold ?? 0);
        const nearRangeStrength = this.params.nearRangeReverbStrength ?? 0;
        const nearRangeLengthM = Math.max(0.5, this.params.nearRangeReverbLengthM ?? 3.5);
        const angularBandStrength = this.params.angularBandStrength ?? 0;
        const rangeStripeStrength = this.params.rangeStripeStrength ?? 0;
        if (
          structuredStrength > 0
          || nearRangeStrength > 0
          || angularBandStrength > 0
          || rangeStripeStrength > 0
        ) {
          const coarseAngle = angle / Math.max(0.5, this.params.structuredBackgroundAngleScaleDeg ?? 3.2);
          const coarseRange = rangeM / Math.max(0.1, this.params.structuredBackgroundRangeScaleM ?? 0.42);
          const correlated = Math.max(0, this.smoothField2D(
            sonarSlot,
            environmentTimeSlot,
            coarseAngle,
            coarseRange,
            31
          ) - structuredThreshold);
          const angularBand = Math.max(0, this.smoothField2D(
            sonarSlot,
            environmentTimeSlot,
            coarseAngle,
            0,
            37
          ));
          const rangeStripe = Math.max(0, this.smoothField2D(
            sonarSlot,
            environmentTimeSlot,
            0,
            coarseRange,
            41
          ));
          const nearTexture = 0.55 + 0.45 * Math.max(0, this.smoothField2D(
            sonarSlot,
            environmentTimeSlot,
            angle / 5.5,
            rangeM / 0.8,
            43
          ));
          v += backgroundFrameScale * structuredStrength * correlated;
          v += backgroundFrameScale * angularBandStrength * angularBand * Math.exp(-rangeM / 22);
          v += backgroundFrameScale * rangeStripeStrength * rangeStripe;
          v += nearFrameScale * nearRangeStrength * Math.exp(-rangeM / nearRangeLengthM) * nearTexture;
        }
        if (fieldUniform(this.seed, sonarSlot, environmentTimeSlot, worldAngleSlot, physicalRangeSlot, 1) < this.params.speckleProb) {
          const u = Math.max(1e-6, fieldUniform(this.seed, sonarSlot, environmentTimeSlot, worldAngleSlot, physicalRangeSlot, 2));
          const heavyTail = 1 / Math.pow(1 - u, 1 / 2.2) - 1;
          v += IMAGING_SPECKLE_STRENGTH * heavyTail;
        }
        acquiredIntensities[base + r] = Math.max(0, v - Math.max(0, this.params.backgroundThreshold ?? 0));
      }

      if (dynRng.next() < IMAGING_WEAK_BAND_PROB) {
        this.addGaussianEcho(acquiredIntensities, base, dynRng.nextInt(rangeBins), rangeBins - 1, IMAGING_WEAK_BAND_STRENGTH * this.params.noiseScale, 1.6);
      }

      this.writeStaticClutter(acquiredIntensities, base, sonar, angle, beamRange, rangeStep, rangeBins, dynRng.next());
      this.writeSwimmerEchoes(acquiredIntensities, base, sonar, angle, beamRange, rangeStep, rangeBins, swimmers, dynRng.next());

      beams.push({
        beamIndex,
        time,
        angle,
        localAngle,
        range: beamRange,
        intensities: Array.from(acquiredIntensities.slice(base, base + rangeBins)),
      });
    }

    const recovered = this.recoverSkippedAngles(sonar, command, beams, acquiredIntensities, rangeBins);
    const outputBeams = recovered?.beams ?? beams;
    const intensities = recovered?.intensities ?? acquiredIntensities;
    const angleBins = outputBeams.length;

    return {
      sonarId: command.sonarId,
      commandId: command.commandId,
      sonarPosition: { ...sonar.position },
      startTime: command.startTime,
      endTime: this.timing.endTime(command),
      beams: outputBeams,
      angleBins,
      acquiredAngleBins: recovered ? acquiredAngleBins : undefined,
      recoveryAngularStepDeg: recovered ? recovered.stepDeg : undefined,
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

  private recoverSkippedAngles(
    sonar: SonarState,
    command: SonarCommand,
    acquiredBeams: BeamReturn[],
    acquiredIntensities: Float32Array,
    rangeBins: number
  ) {
    const stepDeg = this.params.recoveryAngularStepDeg;
    const windows = this.timing.scanWindows(command);
    if (
      !Number.isFinite(stepDeg)
      || stepDeg! <= 0
      || stepDeg! >= Math.abs(command.angularStepDeg)
      || windows.length !== 1
      || acquiredBeams.length < 2
    ) return undefined;

    const widthDeg = Math.abs(command.endLocalAngle - command.scanStartLocalAngle);
    const recoveredCount = Math.max(2, Math.floor(widthDeg / stepDeg! + 1e-9) + 1);
    if (recoveredCount <= acquiredBeams.length) return undefined;

    const intensities = new Float32Array(recoveredCount * rangeBins);
    const beams: BeamReturn[] = [];
    for (let index = 0; index < recoveredCount; index += 1) {
      const fraction = recoveredCount <= 1 ? 0 : index / (recoveredCount - 1);
      const acquiredPosition = fraction * (acquiredBeams.length - 1);
      const lo = Math.floor(acquiredPosition);
      const hi = Math.min(acquiredBeams.length - 1, lo + 1);
      const alpha = acquiredPosition - lo;
      const localAngle = command.scanStartLocalAngle
        + (command.endLocalAngle - command.scanStartLocalAngle) * fraction;
      const time = acquiredBeams[lo].time + (acquiredBeams[hi].time - acquiredBeams[lo].time) * alpha;
      const range = (acquiredBeams[lo].range ?? command.range)
        + ((acquiredBeams[hi].range ?? command.range) - (acquiredBeams[lo].range ?? command.range)) * alpha;
      const base = index * rangeBins;
      const loBase = lo * rangeBins;
      const hiBase = hi * rangeBins;
      for (let r = 0; r < rangeBins; r += 1) {
        intensities[base + r] = acquiredIntensities[loBase + r]
          + (acquiredIntensities[hiBase + r] - acquiredIntensities[loBase + r]) * alpha;
      }
      const reconstructed = Math.abs(acquiredPosition - Math.round(acquiredPosition)) > 1e-6;
      beams.push({
        beamIndex: index,
        time,
        angle: localToWorldBearing(sonar, localAngle),
        localAngle,
        range,
        intensities: Array.from(intensities.slice(base, base + rangeBins)),
        recovered: reconstructed || undefined,
      });
    }
    return { beams, intensities, stepDeg: stepDeg! };
  }

  private smoothField2D(
    sonarSlot: number,
    timeSlot: number,
    x: number,
    y: number,
    tag: number
  ) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sample = (xi: number, yi: number) => fieldNormal(
      this.seed,
      sonarSlot,
      timeSlot,
      xi,
      yi,
      tag
    );
    const top = sample(x0, y0) + (sample(x0 + 1, y0) - sample(x0, y0)) * fx;
    const bottom = sample(x0, y0 + 1) + (sample(x0 + 1, y0 + 1) - sample(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
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
    const clutterScale = this.params.staticClutterScale ?? 1;
    const wallDist = this.geometry.distanceToBoundary(sonar.position, angle);
    if (wallDist !== null && wallDist <= maxRange) {
      this.addGaussianEcho(intensities, base, wallDist / rangeStep, rangeBins - 1, IMAGING_STATIC_WALL_ECHO_STRENGTH * clutterScale, IMAGING_STATIC_ECHO_SIGMA_BINS);
      const ghostDist = wallDist + IMAGING_GHOST_RANGE_OFFSET_M * (0.6 + 0.8 * randomPhase);
      if (ghostDist <= maxRange) {
        this.addGaussianEcho(
          intensities,
          base,
          ghostDist / rangeStep,
          rangeBins - 1,
          IMAGING_STATIC_WALL_ECHO_STRENGTH * IMAGING_GHOST_REL_STRENGTH * this.params.noiseScale * clutterScale,
          IMAGING_STATIC_ECHO_SIGMA_BINS * 1.4
        );
      }
    }

    for (let k = 1; k < this.laneCount; k++) {
      const xLine = POOL_WIDTH * k / this.laneCount;
      const d = this.geometry.distanceToVerticalLine(sonar.position, angle, xLine);
      if (d === null || d > maxRange) continue;
      this.addGaussianEcho(intensities, base, d / rangeStep, rangeBins - 1, IMAGING_STATIC_LANE_ECHO_STRENGTH * clutterScale, IMAGING_STATIC_ECHO_SIGMA_BINS);
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
    const targetLengthM = this.params.targetLengthM ?? SIM_SWIMMER_LENGTH_M;
    const targetDiameterM = this.params.targetDiameterM ?? SIM_SWIMMER_DIAMETER_M;
    const echoStrength = IMAGING_ECHO_STRENGTH * (this.params.targetEchoStrengthScale ?? 1);
    const rangeVariation = Math.max(0, Math.min(0.8, this.params.targetRangeVariation ?? 0));
    const textureStrength = Math.max(0, Math.min(1, this.params.targetTextureStrength ?? 0));
    const targetDropout = Math.max(0, Math.min(0.95, this.params.targetEchoDropout ?? 0));
    const dropoutResidual = Math.max(0, Math.min(1, this.params.targetDropoutResidual ?? 0.08));
    let nearestVisibleRange = Infinity;

    for (const swimmer of [...swimmers].sort((a, b) => distance(sonar.position, a.position) - distance(sonar.position, b.position))) {
      const dist = distance(sonar.position, swimmer.position);
      if (dist > maxRange) continue;
      const targetAngle = angleToTarget(sonar.position, swimmer.position);
      const dAng = signedDeltaAngleDeg(targetAngle, angle);
      const bodyHeading = Math.atan2(swimmer.velocity.y, swimmer.velocity.x) * 180 / Math.PI;
      const broadside = Math.abs(Math.sin(degToRad(targetAngle - bodyHeading)));
      const targetSlot = hashStringToUint32(swimmer.id);
      const shapeScale = 1 + rangeVariation * (
        2 * fieldUniform(this.seed, targetSlot, 0, 0, 0, 17) - 1
      );
      const projectedWidth = targetDiameterM
        + (targetLengthM - targetDiameterM) * broadside;
      const targetHalfAngle = Math.atan2(projectedWidth / 2, Math.max(0.75, dist)) * 180 / Math.PI;
      const angularSigma = Math.max(IMAGING_FOV_DEG / 2.355, targetHalfAngle / 1.5);
      if (Math.abs(dAng) > 3 * angularSigma) continue;

      const angularResponse = Math.exp(-(dAng * dAng) / (2 * angularSigma * angularSigma));
      const occlusion = nearestVisibleRange < Infinity && dist > nearestVisibleRange + targetLengthM
        ? 0.35
        : 1.0;
      nearestVisibleRange = Math.min(nearestVisibleRange, dist);
      const wallPenalty = Math.max(0.55, Math.min(1, this.geometry.wallProximity(swimmer.position) / 2));
      const spreading = 1 / (1 + Math.pow(dist / 30, 2));
      const angularTexture = 1 - textureStrength / 2 + textureStrength * fieldUniform(
        this.seed,
        targetSlot,
        Math.round(angle * 10),
        Math.round(dist * 20),
        0,
        19
      );
      const echo = echoStrength
        * Math.exp(-dist / Math.max(1e-6, IMAGING_ECHO_RANGE_ATTENUATION_M))
        * spreading
        * angularResponse
        * (0.65 + 0.35 * broadside)
        * wallPenalty
        * occlusion
        * angularTexture;

      const center = dist / rangeStep;
      const r0 = Math.floor(center);
      const radiusBins = this.params.targetRangeRadiusM === undefined
        ? IMAGING_BLOB_RADIUS_BINS
        : Math.max(1, Math.ceil(this.params.targetRangeRadiusM * shapeScale / rangeStep));
      const sigmaBins = this.params.targetRangeSigmaM === undefined
        ? IMAGING_BLOB_SIGMA_BINS
        : Math.max(0.5, this.params.targetRangeSigmaM * shapeScale / rangeStep);
      const sigma2 = sigmaBins * sigmaBins;
      const secondaryStrength = Math.max(0, Math.min(1, this.params.targetSecondaryLobeStrength ?? 0));
      const secondaryOffsetBins = (this.params.targetSecondaryLobeOffsetM ?? 0) / rangeStep;
      const secondarySigma2 = Math.max(0.25, sigma2 * 0.55);
      for (let dr = -radiusBins; dr <= radiusBins; dr++) {
        const r = r0 + dr;
        if (r < 0 || r >= rangeBins) continue;
        const primary = Math.exp(-(dr * dr) / (2 * sigma2));
        const secondaryDelta = dr - secondaryOffsetBins;
        const secondary = secondaryStrength * Math.exp(
          -(secondaryDelta * secondaryDelta) / (2 * secondarySigma2)
        );
        const w = primary + secondary;
        const radialTexture = 1 - textureStrength / 2 + textureStrength * fieldUniform(
          this.seed,
          targetSlot,
          Math.round(angle * 10),
          Math.round(dist * 20),
          r,
          23
        );
        const dropoutField = fieldUniform(
          this.seed,
          targetSlot,
          Math.round(angle * 4),
          Math.floor(r / 3),
          0,
          29
        );
        const dropoutScale = dropoutField < targetDropout ? dropoutResidual : 1;
        intensities[base + r] += echo * w * radialTexture * dropoutScale;
      }

      const haloStrength = Math.max(0, Math.min(1, this.params.targetHaloStrength ?? 0));
      if (haloStrength > 0) {
        const haloSigmaBins = Math.max(
          0.5,
          (this.params.targetHaloSigmaM ?? 0.75) / rangeStep
        );
        this.addGaussianEcho(
          intensities,
          base,
          center,
          rangeBins - 1,
          echo * haloStrength,
          haloSigmaBins
        );
      }

      const ghostDist = dist + IMAGING_GHOST_RANGE_OFFSET_M * (0.6 + 0.8 * randomPhase);
      if (ghostDist <= maxRange) {
        this.addGaussianEcho(
          intensities,
          base,
          ghostDist / rangeStep,
          rangeBins - 1,
          echo * IMAGING_GHOST_REL_STRENGTH * this.params.noiseScale,
          sigmaBins * 1.3
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
