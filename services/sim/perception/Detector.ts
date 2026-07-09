import { Detection, SonarFrame, SonarState } from '../../../types';
import {
  AQUASCAN_DBSCAN_EPS_BINS,
  AQUASCAN_DBSCAN_MIN_PTS,
  AQUASCAN_KERNEL_CAP,
  AQUASCAN_MAX_ASPECT,
  AQUASCAN_MAX_CROSS_RANGE_M,
  AQUASCAN_MAX_RANGE_EXTENT_M,
  AQUASCAN_MIN_ASPECT,
  AQUASCAN_MIN_CROSS_RANGE_M,
  AQUASCAN_MIN_RANGE_EXTENT_M,
  AQUASCAN_WEAK_ECHO_MIN,
  AQUASCAN_WEAK_ECHO_PERCENTILE,
  IMAGING_NOISE_FLOOR,
  IMAGING_NOISE_TO_MEAS_SIGMA_M,
  IMAGING_RANGE_BINS,
  IMAGING_THRESHOLD,
  POOL_LENGTH,
  POOL_WIDTH,
} from '../../../constants';
import { degToRad } from '../../../utils/math';
import { createLCGRng, hashStringToUint32 } from '../../../utils/rng';

export type DetectorParams = {
  threshold: number;
  dbscanEpsBins: number;
  dbscanMinPts: number;
  noiseScale: number;
  kernelCap: number;
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
    const subtracted = this.backgroundSubtract(frame);
    const mask = new Uint8Array(nCells);
    const labels = new Int32Array(nCells);
    const threshold = this.params.threshold;

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
      .slice(0, 24)
      .forEach((cluster, index) => {
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

    return this.mergeNearbyDetections(detections, 2.0);
  }

  private mergeNearbyDetections(detections: Detection[], gateM: number) {
    const merged: Detection[] = [];
    for (const detection of detections.sort((a, b) => b.intensity - a.intensity)) {
      const existing = merged.find(item => Math.hypot(
        item.position.x - detection.position.x,
        item.position.y - detection.position.y
      ) <= gateM);
      if (!existing) {
        merged.push({ ...detection, position: { ...detection.position }, bbox: detection.bbox ? { ...detection.bbox } : undefined });
        continue;
      }
      const totalIntensity = Math.max(1e-6, existing.intensity + detection.intensity);
      existing.position = {
        x: (existing.position.x * existing.intensity + detection.position.x * detection.intensity) / totalIntensity,
        y: (existing.position.y * existing.intensity + detection.position.y * detection.intensity) / totalIntensity,
      };
      existing.range = (existing.range * existing.intensity + detection.range * detection.intensity) / totalIntensity;
      existing.time = Math.max(existing.time, detection.time);
      existing.confidence = 1 - (1 - existing.confidence) * (1 - detection.confidence);
      existing.intensity = totalIntensity;
      if (existing.bbox && detection.bbox) {
        existing.bbox = {
          aMin: Math.min(existing.bbox.aMin, detection.bbox.aMin),
          aMax: Math.max(existing.bbox.aMax, detection.bbox.aMax),
          rMin: Math.min(existing.bbox.rMin, detection.bbox.rMin),
          rMax: Math.max(existing.bbox.rMax, detection.bbox.rMax),
        };
      }
    }
    return merged;
  }

  private backgroundSubtract(frame: SonarFrame) {
    const out = new Float32Array(frame.intensities.length);

    for (let a = 0; a < frame.angleBins; a++) {
      const base = a * frame.rangeBins;
      for (let r = 0; r < frame.rangeBins; r++) {
        const v = frame.intensities[base + r] - IMAGING_NOISE_FLOOR;
        out[base + r] = v > 0 ? v : 0;
      }
    }

    return out;
  }

  private percentile(values: Float32Array, p: number, stride = 1) {
    const sampled: number[] = [];
    for (let i = 0; i < values.length; i += Math.max(1, stride)) sampled.push(values[i]);
    if (sampled.length === 0) return 0;
    sampled.sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sampled.length - 1, Math.floor((sampled.length - 1) * p)));
    return sampled[idx];
  }

  private adaptiveThreshold(values: Float32Array) {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let i = 0; i < values.length; i += 5) {
      const v = values[i];
      sum += v;
      sumSq += v * v;
      n += 1;
    }
    if (n === 0) return 0;
    const avg = sum / n;
    const variance = Math.max(0, sumSq / n - avg * avg);
    return avg + Math.sqrt(variance) * (0.9 + this.params.noiseScale * 0.2);
  }

  private normalizedKernelCap() {
    const cap = Math.max(3, Math.min(13, Math.floor(this.params.kernelCap || AQUASCAN_KERNEL_CAP)));
    return cap % 2 === 0 ? cap - 1 : cap;
  }

  private rangeDenoise(
    input: Uint8Array,
    output: Uint8Array,
    angleBins: number,
    rangeBins: number,
    kernelSize: number
  ) {
    const half = Math.floor(Math.max(1, kernelSize) / 2);
    for (let a = 0; a < angleBins; a++) {
      const base = a * rangeBins;
      for (let r = 0; r < rangeBins; r++) {
        let sum = 0;
        let len = 0;
        for (let rr = Math.max(0, r - half); rr <= Math.min(rangeBins - 1, r + half); rr++) {
          sum += input[base + rr];
          len += 1;
        }
        const need = Math.max(1, Math.ceil(len * 0.35));
        output[base + r] = sum >= need ? 1 : 0;
      }
    }
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
