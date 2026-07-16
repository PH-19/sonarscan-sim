import { Detection, SonarFrame, SonarState } from '../../../types';
import {
  AQUASCAN_DBSCAN_EPS_BINS,
  AQUASCAN_DBSCAN_MIN_PTS,
  AQUASCAN_MAX_ASPECT,
  AQUASCAN_MAX_CROSS_RANGE_M,
  AQUASCAN_MAX_RANGE_EXTENT_M,
  AQUASCAN_MIN_ASPECT,
  AQUASCAN_MIN_CROSS_RANGE_M,
  AQUASCAN_MIN_RANGE_EXTENT_M,
  IMAGING_NOISE_FLOOR,
  IMAGING_NOISE_TO_MEAS_SIGMA_M,
  IMAGING_RANGE_BINS,
  IMAGING_THRESHOLD,
  POOL_LENGTH,
  POOL_WIDTH,
} from '../../../constants';
import { degToRad } from '../../../utils/math';
import { createLCGRng, hashStringToUint32 } from '../../../utils/rng';

const DENSE_REFERENCE_ANGULAR_STEP_DEG = 360 / 400;
const DENSE_REFERENCE_RANGE_STEP_M = 17 / 500;
const SPARSE_PIPELINE_RESOLUTION_SCALE_THRESHOLD = 0.5;

export type DetectorParams = {
  threshold: number;
  dbscanEpsBins: number;
  dbscanMinPts: number;
  noiseScale: number;
  minClusterCells?: number;
  medianKernel?: number;
  boxBlurRadius?: number;
  robustNormalize?: boolean;
  resolutionAware?: boolean;
  narrowSectorThreshold?: number;
  physicalFilter?: boolean;
};

type ClusterStats = {
  sumI: number;
  sumA: number;
  sumR: number;
  cells: number;
  aMin: number;
  aMax: number;
  rMin: number;
  rMax: number;
};

export class Detector {
  constructor(private readonly seed: number, private params: DetectorParams) {}

  setParams(params: Partial<DetectorParams>) {
    this.params = { ...this.params, ...params };
  }

  detect(frame: SonarFrame, sonar: SonarState) {
    const nCells = frame.angleBins * frame.rangeBins;
    const filtered = this.preprocess(frame.intensities, frame);
    const subtracted = this.backgroundSubtract(filtered);
    const mask = new Uint8Array(nCells);
    const labels = new Int32Array(nCells);
    const threshold = this.usesSparseFramePipeline(frame)
      ? this.params.narrowSectorThreshold ?? this.params.threshold
      : this.params.threshold;

    for (let i = 0; i < nCells; i++) {
      mask[i] = subtracted[i] >= threshold ? 1 : 0;
    }

    const clusterCount = this.dbscan(mask, labels, frame.angleBins, frame.rangeBins, this.params.dbscanEpsBins, this.params.dbscanMinPts);
    const clusters = this.clusterStats(frame, subtracted, labels, clusterCount);
    const detections: Detection[] = [];
    const fallbackAngleWidth = Math.max(1e-6, Math.abs(frame.endLocalAngle - frame.startLocalAngle));
    const fallbackAngleStep = fallbackAngleWidth / Math.max(1, frame.angleBins - 1);
    const beamAt = (index: number) => frame.beams[Math.max(0, Math.min(frame.beams.length - 1, index))];
    const angleSpanForCluster = (aMin: number, aMax: number) => {
      const first = beamAt(aMin);
      const last = beamAt(aMax);
      if (!first || !last) return (aMax - aMin + 1) * fallbackAngleStep;
      const rawSpan = Math.abs(last.localAngle - first.localAngle);
      return Math.max(fallbackAngleStep, rawSpan + fallbackAngleStep);
    };

    clusters
      .filter(c => c.cells > 0 && c.sumI > 0)
      .sort((a, b) => b.sumI - a.sumI)
      .slice(0, 128)
      .forEach((cluster, index) => {
        if (cluster.cells < this.effectiveMinClusterCells(frame)) return;
        const aSpanBins = cluster.aMax - cluster.aMin + 1;
        const rSpanBins = cluster.rMax - cluster.rMin + 1;
        const aCent = cluster.sumA / cluster.sumI;
        const rCent = cluster.sumR / cluster.sumI;
        const representativeBeam = beamAt(Math.round(aCent));
        const beamRange = representativeBeam?.range ?? frame.range;
        const rangeStep = beamRange / frame.rangeBins;
        const rangeM = rCent * rangeStep;
        const angleSpanDeg = angleSpanForCluster(cluster.aMin, cluster.aMax);
        const rangeSpanM = rSpanBins * rangeStep;
        const crossRangeM = rangeM * degToRad(angleSpanDeg);

        if (aSpanBins > 30) return;
        if (crossRangeM > 5.0) return;
        const sparseFrame = this.usesSparseFramePipeline(frame);
        if (this.params.physicalFilter && !sparseFrame) {
          const aspect = crossRangeM / Math.max(1e-9, rangeSpanM);
          if (
            crossRangeM < AQUASCAN_MIN_CROSS_RANGE_M
            || crossRangeM > AQUASCAN_MAX_CROSS_RANGE_M
            || rangeSpanM < AQUASCAN_MIN_RANGE_EXTENT_M
            || rangeSpanM > AQUASCAN_MAX_RANGE_EXTENT_M
            || aspect < AQUASCAN_MIN_ASPECT
            || aspect > AQUASCAN_MAX_ASPECT
          ) return;
        }

        const bearing = representativeBeam?.angle ?? frame.startAngle;
        const detectionTime = representativeBeam?.time ?? frame.endTime;
        const angRad = degToRad(bearing);
        const noiseSigma = IMAGING_NOISE_TO_MEAS_SIGMA_M * this.params.noiseScale / Math.max(0.05, threshold);
        const jitterRng = createLCGRng(hashStringToUint32(
          `${this.seed}|det|${frame.sonarId}|${Math.round(detectionTime * 1000)}|${Math.round(bearing * 10)}|${Math.round(rangeM * 20)}`
        ));
        const jitter = (0.08 + noiseSigma + rangeM * 0.004);
        const x = Math.max(0, Math.min(POOL_WIDTH, sonar.position.x + Math.cos(angRad) * rangeM + jitterRng.nextNormal(0, jitter)));
        const y = Math.max(0, Math.min(POOL_LENGTH, sonar.position.y + Math.sin(angRad) * rangeM + jitterRng.nextNormal(0, jitter)));
        const confidence = Math.max(0, Math.min(1, (cluster.sumI / Math.max(1, cluster.cells) - threshold) / Math.max(0.1, threshold)));

        detections.push({
          id: `${frame.commandId}:d${index}`,
          frameId: frame.commandId,
          time: detectionTime,
          sonarId: frame.sonarId,
          position: { x, y },
          range: rangeM,
          bearing,
          confidence,
          intensity: cluster.sumI,
          bbox: {
            aMin: cluster.aMin,
            aMax: cluster.aMax + 1,
            rMin: cluster.rMin,
            rMax: cluster.rMax + 1,
          },
        });
      });

    // Do not merge spatially close components here. Cardinality reduction is
    // irreversible before track-conditioned association and is particularly
    // harmful for the 0.9 m counter-flow separation in public lap lanes.
    return detections;
  }

  private preprocess(input: Float32Array, frame: SonarFrame) {
    const { angleBins, rangeBins } = frame;
    let output = this.params.robustNormalize ? this.robustNormalize(input) : input;
    const sparseFrame = this.usesSparseFramePipeline(frame);
    const medianKernel = Math.max(1, Math.min(7, Math.floor(this.params.medianKernel ?? 1)));
    if (medianKernel > 1 && !sparseFrame) {
      output = this.medianFilter2D(output, angleBins, rangeBins, medianKernel);
    }
    const boxBlurRadius = Math.max(0, Math.min(4, Math.floor(this.params.boxBlurRadius ?? 0)));
    if (boxBlurRadius > 0 && !sparseFrame) {
      output = this.boxBlur2D(output, angleBins, rangeBins, boxBlurRadius);
    }
    return output;
  }

  private effectiveMinClusterCells(frame: SonarFrame) {
    const configured = Math.max(0, Math.floor(this.params.minClusterCells ?? 0));
    if (!this.params.resolutionAware || configured === 0) return configured;
    if (this.usesSparseFramePipeline(frame)) {
      return Math.min(configured, Math.max(1, Math.floor(this.params.dbscanMinPts)));
    }
    const resolutionScale = this.frameResolutionScale(frame);
    return Math.max(1, Math.round(configured * resolutionScale));
  }

  private frameResolutionScale(frame: SonarFrame) {
    const angularStepDeg = frame.beams.length >= 2
      ? Math.max(1e-6, Math.abs(frame.beams[frame.beams.length - 1].localAngle - frame.beams[0].localAngle) / (frame.beams.length - 1))
      : Math.max(
          1e-6,
          Math.abs(frame.endLocalAngle - frame.startLocalAngle) / Math.max(1, frame.angleBins - 1)
        );
    const representativeRange = frame.beams[Math.floor(frame.beams.length / 2)]?.range ?? frame.range;
    const rangeStepM = Math.max(1e-6, representativeRange / frame.rangeBins);
    return Math.max(0.1, Math.min(
      2,
      (DENSE_REFERENCE_ANGULAR_STEP_DEG / angularStepDeg)
        * (DENSE_REFERENCE_RANGE_STEP_M / rangeStepM)
    ));
  }

  private usesSparseFramePipeline(frame: SonarFrame) {
    return Boolean(
      this.params.resolutionAware
      && (
        Math.abs(frame.endLocalAngle - frame.startLocalAngle) < 120
        // The real-image morphology was calibrated around 0.9 degree x
        // 0.034 m cells. A wide runtime frame can still be sparse when its
        // range/angle cells are much larger; applying the dense-image kernel
        // then erases a swimmer echo before clustering. Route by information
        // density rather than field-of-view alone.
        || this.frameResolutionScale(frame) < SPARSE_PIPELINE_RESOLUTION_SCALE_THRESHOLD
      )
    );
  }

  private robustNormalize(input: Float32Array) {
    const positive: number[] = [];
    for (let index = 0; index < input.length; index++) {
      if (input[index] > 0) positive.push(input[index]);
    }
    const output = new Float32Array(input.length);
    if (positive.length === 0) return output;
    positive.sort((left, right) => left - right);
    const at = (quantile: number) => positive[Math.max(
      0,
      Math.min(positive.length - 1, Math.floor((positive.length - 1) * quantile))
    )];
    const black = at(0.50);
    const white = at(0.995);
    const scale = Math.max(1e-9, white - black);
    for (let index = 0; index < input.length; index++) {
      output[index] = Math.max(0, Math.min(1, (input[index] - black) / scale));
    }
    return output;
  }

  private backgroundSubtract(input: Float32Array) {
    const out = new Float32Array(input.length);
    for (let index = 0; index < input.length; index++) {
      const v = input[index] - IMAGING_NOISE_FLOOR;
      out[index] = v > 0 ? v : 0;
    }
    return out;
  }

  private medianFilter2D(
    input: Float32Array,
    angleBins: number,
    rangeBins: number,
    kernelSize: number
  ) {
    const size = kernelSize % 2 === 0 ? Math.max(1, kernelSize - 1) : kernelSize;
    const half = Math.floor(size / 2);
    const output = new Float32Array(input.length);
    const window: number[] = [];
    for (let a = 0; a < angleBins; a++) {
      for (let r = 0; r < rangeBins; r++) {
        window.length = 0;
        for (let da = -half; da <= half; da++) {
          const aa = a + da;
          if (aa < 0 || aa >= angleBins) continue;
          const base = aa * rangeBins;
          for (let dr = -half; dr <= half; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rangeBins) continue;
            window.push(input[base + rr]);
          }
        }
        window.sort((left, right) => left - right);
        output[a * rangeBins + r] = window[Math.floor(window.length / 2)] ?? 0;
      }
    }
    return output;
  }

  private boxBlur2D(
    input: Float32Array,
    angleBins: number,
    rangeBins: number,
    radius: number
  ) {
    const horizontal = new Float32Array(input.length);
    const output = new Float32Array(input.length);
    for (let a = 0; a < angleBins; a++) {
      const base = a * rangeBins;
      let sum = 0;
      let count = 0;
      for (let r = 0; r <= Math.min(rangeBins - 1, radius); r++) {
        sum += input[base + r];
        count += 1;
      }
      for (let r = 0; r < rangeBins; r++) {
        if (r > 0) {
          const entering = r + radius;
          if (entering < rangeBins) {
            sum += input[base + entering];
            count += 1;
          }
          const leaving = r - radius - 1;
          if (leaving >= 0) {
            sum -= input[base + leaving];
            count -= 1;
          }
        }
        horizontal[base + r] = count > 0 ? sum / count : 0;
      }
    }
    for (let r = 0; r < rangeBins; r++) {
      let sum = 0;
      let count = 0;
      for (let a = 0; a <= Math.min(angleBins - 1, radius); a++) {
        sum += horizontal[a * rangeBins + r];
        count += 1;
      }
      for (let a = 0; a < angleBins; a++) {
        if (a > 0) {
          const entering = a + radius;
          if (entering < angleBins) {
            sum += horizontal[entering * rangeBins + r];
            count += 1;
          }
          const leaving = a - radius - 1;
          if (leaving >= 0) {
            sum -= horizontal[leaving * rangeBins + r];
            count -= 1;
          }
        }
        output[a * rangeBins + r] = count > 0 ? sum / count : 0;
      }
    }

    return output;
  }

  private dbscan(
    mask: Uint8Array,
    labels: Int32Array,
    angleBins: number,
    rangeBins: number,
    epsBins: number,
    minPts: number
  ) {
    const eps = Math.max(0.5, epsBins || AQUASCAN_DBSCAN_EPS_BINS);
    const epsI = Math.ceil(eps);
    const eps2 = eps * eps;
    const minNeighbors = Math.max(1, Math.floor(minPts || AQUASCAN_DBSCAN_MIN_PTS));
    const nCells = angleBins * rangeBins;
    const neigh: number[] = [];
    const queue: number[] = [];

    const regionQuery = (idx: number) => {
      neigh.length = 0;
      const a = Math.floor(idx / rangeBins);
      const r = idx - a * rangeBins;
      for (let da = -epsI; da <= epsI; da++) {
        const aa = a + da;
        if (aa < 0 || aa >= angleBins) continue;
        for (let dr = -epsI; dr <= epsI; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rangeBins) continue;
          if (da * da + dr * dr > eps2) continue;
          const nIdx = aa * rangeBins + rr;
          if (mask[nIdx]) neigh.push(nIdx);
        }
      }
      return neigh;
    };

    let clusterId = 0;
    for (let idx = 0; idx < nCells; idx++) {
      if (!mask[idx] || labels[idx] !== 0) continue;
      const neighbors = regionQuery(idx);
      if (neighbors.length < minNeighbors) {
        labels[idx] = -1;
        continue;
      }

      clusterId++;
      labels[idx] = clusterId;
      queue.length = 0;
      for (const nIdx of neighbors) {
        if (nIdx !== idx) queue.push(nIdx);
      }

      while (queue.length) {
        const qIdx = queue.pop() as number;
        if (labels[qIdx] === -1) labels[qIdx] = clusterId;
        if (labels[qIdx] !== 0) continue;
        labels[qIdx] = clusterId;
        const qNeighbors = regionQuery(qIdx);
        if (qNeighbors.length >= minNeighbors) {
          for (const nn of qNeighbors) queue.push(nn);
        }
      }
    }

    return clusterId;
  }

  private clusterStats(frame: SonarFrame, amplitudes: Float32Array, labels: Int32Array, clusterCount: number) {
    const clusters: ClusterStats[] = Array.from({ length: clusterCount }, () => ({
      sumI: 0,
      sumA: 0,
      sumR: 0,
      cells: 0,
      aMin: Infinity,
      aMax: -Infinity,
      rMin: Infinity,
      rMax: -Infinity,
    }));

    for (let idx = 0; idx < labels.length; idx++) {
      const label = labels[idx];
      if (label <= 0) continue;
      const a = Math.floor(idx / frame.rangeBins);
      const r = idx - a * frame.rangeBins;
      const amp = amplitudes[idx];
      const cluster = clusters[label - 1];
      cluster.cells += 1;
      cluster.sumI += amp;
      cluster.sumA += amp * (a + 0.5);
      cluster.sumR += amp * (r + 0.5);
      if (a < cluster.aMin) cluster.aMin = a;
      if (a > cluster.aMax) cluster.aMax = a;
      if (r < cluster.rMin) cluster.rMin = r;
      if (r > cluster.rMax) cluster.rMax = r;
    }

    return clusters;
  }
}
