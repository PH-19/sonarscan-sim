import { Detection, EngineEvalMetrics, SonarFrame, SwimmerTruth, TrackBelief, Vector2 } from '../../../types';
import { IMAGING_FOV_DEG, MATCH_GATE_RADIUS_M } from '../../../constants';
import { angleToTarget } from '../../../utils/math';
import { angleInSweep } from '../sonar/AngleSweep';

const DEFAULT_EVAL_WINDOW_SEC = 10;
// Retain a full workshop run. UI queries still use short windows, while the
// headless runner can request whole-run metrics without silently losing data.
const EVAL_RETENTION_SEC = 3600;

type DetectionFrameStats = {
  time: number;
  tp: number;
  fp: number;
  fn: number;
  iouSum: number;
};

type TrackFrameStats = {
  time: number;
  truthIds: string[];
  matches: TrackTruthMatch[];
  tp: number;
  falseTracks: number;
  missedTracks: number;
  idSwitches: number;
  fragmentations: number;
  errors: number[];
};

type TrackTruthMatch = {
  truthId: string;
  trackId: string;
  distance: number;
};

type TrackIdentityScanSample = {
  time: number;
  truthId: string;
  trackId?: string;
  correct: boolean;
  localCorrect: boolean;
  outcome: 'correct' | 'wrong_id' | 'missed';
};

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
};

const dist = (a: Vector2, b: Vector2) => Math.hypot(a.x - b.x, a.y - b.y);

export class Evaluator {
  private detectionFrames: DetectionFrameStats[] = [];
  private trackFrames: TrackFrameStats[] = [];
  private trackIdentityScanSamples: TrackIdentityScanSample[] = [];
  private localizationErrors: { time: number; err: number }[] = [];
  private falseAlarmCounts: { time: number; count: number }[] = [];
  private hitStats: { time: number; opportunities: number; hits: number }[] = [];
  private frameTimesBySonar = new Map<string, number[]>();
  private lastSeenTimeByTruth = new Map<string, number>();
  private updateTimesByTruth = new Map<string, number[]>();
  private firstDetectionTimeByTruth = new Map<string, number>();
  private lastTrackByTruth = new Map<string, string>();
  private seenTrackByTruth = new Map<string, Set<string>>();
  private canonicalTrackByTruth = new Map<string, string>();
  private canonicalTruthByTrack = new Map<string, string>();
  private localTrackByTruth = new Map<string, string>();
  private pendingLocalTrackByTruth = new Map<string, string>();

  reset() {
    this.detectionFrames = [];
    this.trackFrames = [];
    this.trackIdentityScanSamples = [];
    this.localizationErrors = [];
    this.falseAlarmCounts = [];
    this.hitStats = [];
    this.frameTimesBySonar.clear();
    this.lastSeenTimeByTruth.clear();
    this.updateTimesByTruth.clear();
    this.firstDetectionTimeByTruth.clear();
    this.lastTrackByTruth.clear();
    this.seenTrackByTruth.clear();
    this.canonicalTrackByTruth.clear();
    this.canonicalTruthByTrack.clear();
    this.localTrackByTruth.clear();
    this.pendingLocalTrackByTruth.clear();
  }

  registerTruth(truth: SwimmerTruth) {
    this.lastSeenTimeByTruth.set(truth.truthId, truth.enteredAt);
    this.updateTimesByTruth.set(truth.truthId, []);
  }

  removeTruth(truthId: string) {
    this.lastSeenTimeByTruth.delete(truthId);
    this.updateTimesByTruth.delete(truthId);
    this.firstDetectionTimeByTruth.delete(truthId);
    this.lastTrackByTruth.delete(truthId);
    this.seenTrackByTruth.delete(truthId);
    this.localTrackByTruth.delete(truthId);
    this.pendingLocalTrackByTruth.delete(truthId);
    const trackId = this.canonicalTrackByTruth.get(truthId);
    this.canonicalTrackByTruth.delete(truthId);
    if (trackId && this.canonicalTruthByTrack.get(trackId) === truthId) {
      this.canonicalTruthByTrack.delete(trackId);
    }
  }

  recordFrame(
    frame: SonarFrame,
    detections: Detection[],
    truth: SwimmerTruth[],
    tracks: TrackBelief[],
    sampleTruth: (time: number) => SwimmerTruth[] = () => truth
  ) {
    const visibleTruth = this.visibleTruth(frame, truth, sampleTruth);
    const detectionMatches = this.matchDetections(frame, detections, visibleTruth);
    const matchedDetectionIndexes = new Set(detectionMatches.map(match => match.detectionIndex));
    const annotatedDetections = detections.map((detection, index) => ({
      ...detection,
      source: matchedDetectionIndexes.has(index) ? 'target' as const : 'false_alarm' as const,
    }));
    const tp = detectionMatches.length;
    const fp = Math.max(0, detections.length - tp);
    const fn = Math.max(0, visibleTruth.length - tp);
    const iouSum = detectionMatches.reduce((sum, match) => sum + match.iou, 0);
    this.detectionFrames.push({ time: frame.endTime, tp, fp, fn, iouSum });
    if (fp > 0) this.falseAlarmCounts.push({ time: frame.endTime, count: fp });
    if (visibleTruth.length > 0) {
      this.hitStats.push({ time: frame.endTime, opportunities: visibleTruth.length, hits: tp });
    }
    this.recordTrackIdentityScanState(frame.endTime, visibleTruth, tracks);

    for (const match of detectionMatches) {
      this.localizationErrors.push({ time: frame.endTime, err: match.distance });
      this.lastSeenTimeByTruth.set(match.truth.truthId, frame.endTime);
      const arr = this.updateTimesByTruth.get(match.truth.truthId) ?? [];
      arr.push(frame.endTime);
      this.updateTimesByTruth.set(match.truth.truthId, arr);
      if (!this.firstDetectionTimeByTruth.has(match.truth.truthId)) {
        this.firstDetectionTimeByTruth.set(match.truth.truthId, frame.endTime);
      }
    }

    const ft = this.frameTimesBySonar.get(frame.sonarId) ?? [];
    ft.push(frame.endTime);
    this.frameTimesBySonar.set(frame.sonarId, ft);
    this.prune(frame.endTime);

    return {
      annotatedDetections,
      matchedDetections: detectionMatches.map(match => match.detection),
    };
  }

  recordTrackState(time: number, truth: SwimmerTruth[], tracks: TrackBelief[]) {
    const last = this.trackFrames[this.trackFrames.length - 1];
    if (last && Math.abs(last.time - time) < 1e-9) return;
    this.trackFrames.push(this.evaluateTracks(time, truth, tracks));
    this.prune(time);
  }

  metrics(now: number, truth: SwimmerTruth[], sonarCount: number, windowSec = DEFAULT_EVAL_WINDOW_SEC): EngineEvalMetrics {
    const cutoff = now - windowSec;
    const scanIntervals: number[] = [];
    const scanRates: number[] = [];
    const revisitMeans: number[] = [];

    for (const swimmer of truth) {
      const times = this.updateTimesByTruth.get(swimmer.truthId) ?? [];
      while (times.length > 0 && times[0] < cutoff) times.shift();
      const scanRate = windowSec > 0 ? times.length / windowSec : 0;
      scanRates.push(scanRate);
      scanIntervals.push(scanRate > 0 ? 1 / scanRate : windowSec);
      if (times.length >= 2) {
        revisitMeans.push((times[times.length - 1] - times[0]) / (times.length - 1));
      }
    }

    const det = this.detectionFrames.filter(f => f.time >= cutoff);
    const tp = det.reduce((sum, f) => sum + f.tp, 0);
    const fp = det.reduce((sum, f) => sum + f.fp, 0);
    const fn = det.reduce((sum, f) => sum + f.fn, 0);
    const iouSum = det.reduce((sum, f) => sum + f.iouSum, 0);

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const mdr = tp + fn > 0 ? fn / (tp + fn) : 0;

    const falseCount = this.falseAlarmCounts.filter(f => f.time >= cutoff).reduce((sum, f) => sum + f.count, 0);
    let opportunities = 0;
    let hits = 0;
    for (const stat of this.hitStats) {
      if (stat.time < cutoff) continue;
      opportunities += stat.opportunities;
      hits += stat.hits;
    }

    const locErrors = this.localizationErrors.filter(e => e.time >= cutoff).map(e => e.err);
    const trackFrames = this.trackFrames.filter(f => f.time >= cutoff);
    const trackErrors = trackFrames.flatMap(f => f.errors);
    const sqErrors = trackErrors.map(e => e * e);
    const trackTruePositives = trackFrames.reduce((sum, f) => sum + f.tp, 0);
    const falseTracks = trackFrames.reduce((sum, f) => sum + f.falseTracks, 0);
    const missedTracks = trackFrames.reduce((sum, f) => sum + f.missedTracks, 0);
    const idSwitches = trackFrames.reduce((sum, f) => sum + f.idSwitches, 0);
    const trackFragmentations = trackFrames.reduce((sum, f) => sum + f.fragmentations, 0);
    const identitySamples = this.trackIdentityScanSamples.filter(sample => sample.time >= cutoff);
    const correctIdentityScans = identitySamples.filter(sample => sample.correct).length;
    const localCorrectIdentityScans = identitySamples.filter(sample => sample.localCorrect).length;

    let framesInWindow = 0;
    for (const times of this.frameTimesBySonar.values()) {
      while (times.length > 0 && times[0] < cutoff) times.shift();
      framesInWindow += times.length;
    }

    const ttfValues: number[] = [];
    const deadlineDetections = { d3: 0, d5: 0, d10: 0, total: 0 };
    for (const swimmer of truth) {
      if (swimmer.enteredAt < cutoff) continue;
      const first = this.firstDetectionTimeByTruth.get(swimmer.truthId);
      const ttf = Math.max(0, (first ?? now) - swimmer.enteredAt);
      ttfValues.push(ttf);
      deadlineDetections.total += 1;
      if (first !== undefined && ttf <= 3) deadlineDetections.d3 += 1;
      if (first !== undefined && ttf <= 5) deadlineDetections.d5 += 1;
      if (first !== undefined && ttf <= 10) deadlineDetections.d10 += 1;
    }

    const gospaComponents = trackFrames.map(frame => this.computeGOSPAComponents(frame.errors, frame.missedTracks, frame.falseTracks));
    const gospa = mean(gospaComponents.map(component => component.total));
    const trackContinuity = trackTruePositives > 0
      ? trackTruePositives / (trackTruePositives + idSwitches + trackFragmentations)
      : 0;
    const trackingOpportunities = trackTruePositives + missedTracks;

    return {
      timestamp: now,
      activeSwimmers: truth.length,
      avgAoISec: mean(scanIntervals),
      p90AoISec: percentile(scanIntervals, 0.9),
      avgScanRateHz: mean(scanRates),
      trackingRMSEm: sqErrors.length ? Math.sqrt(mean(sqErrors)) : 0,
      p90TrackingErrorM: percentile(trackErrors, 0.9),
      avgRevisitIntervalSec: mean(revisitMeans),
      falseAlarmsPerSec: windowSec > 0 ? falseCount / windowSec : 0,
      detectionHitRate: opportunities > 0 ? hits / opportunities : 0,
      avgLocalizationErrorM: mean(locErrors),
      p90LocalizationErrorM: percentile(locErrors, 0.9),
      avgTimeToFirstDetectionSec: mean(ttfValues),
      p90TimeToFirstDetectionSec: percentile(ttfValues, 0.9),
      precision,
      recall,
      f1,
      mdr,
      meanIoU: tp > 0 ? iouSum / tp : 0,
      fps: windowSec > 0 && sonarCount > 0 ? framesInWindow / windowSec / sonarCount : 0,
      trackingRate: trackingOpportunities > 0 ? trackTruePositives / trackingOpportunities : 0,
      trackTruePositives,
      falseTracks,
      missedTracks,
      idSwitches,
      trackFragmentations,
      strictTrackAccuracy: identitySamples.length > 0 ? correctIdentityScans / identitySamples.length : 0,
      localTrackAccuracy: identitySamples.length > 0 ? localCorrectIdentityScans / identitySamples.length : 0,
      strictIdentityTracks: correctIdentityScans,
      localIdentityTracks: localCorrectIdentityScans,
      identityTrackOpportunities: identitySamples.length,
      gospa,
      gospaLocalization: mean(gospaComponents.map(component => component.localization)),
      gospaMissed: mean(gospaComponents.map(component => component.missed)),
      gospaFalse: mean(gospaComponents.map(component => component.falseTargets)),
      trackContinuity,
      deadlineDetection3Sec: deadlineDetections.total > 0 ? deadlineDetections.d3 / deadlineDetections.total : 0,
      deadlineDetection5Sec: deadlineDetections.total > 0 ? deadlineDetections.d5 / deadlineDetections.total : 0,
      deadlineDetection10Sec: deadlineDetections.total > 0 ? deadlineDetections.d10 / deadlineDetections.total : 0,
    };
  }

  private visibleTruth(
    frame: SonarFrame,
    truth: SwimmerTruth[],
    sampleTruth: (time: number) => SwimmerTruth[]
  ) {
    if (frame.beams.length > 0) {
      const visible = new Map<string, SwimmerTruth>();
      for (const beam of frame.beams) {
        for (const swimmer of sampleTruth(beam.time)) {
          const range = dist(frame.sonarPosition, swimmer.position);
          if (range > (beam.range ?? frame.range)) continue;
          const bearing = angleToTarget(frame.sonarPosition, swimmer.position);
          const delta = Math.abs(((bearing - beam.angle + 540) % 360) - 180);
          if (delta <= IMAGING_FOV_DEG / 2) visible.set(swimmer.truthId, swimmer);
        }
      }
      return [...visible.values()];
    }
    return truth.filter(swimmer => {
      const range = dist(frame.sonarPosition, swimmer.position);
      if (range > frame.range) return false;
      const bearing = angleToTarget(frame.sonarPosition, swimmer.position);
      return angleInSweep(bearing, frame);
    });
  }

  private matchDetections(frame: SonarFrame, detections: Detection[], truth: SwimmerTruth[]) {
    const pairs: { detectionIndex: number; truthIndex: number; distance: number; iou: number }[] = [];
    detections.forEach((detection, detectionIndex) => {
      truth.forEach((swimmer, truthIndex) => {
        const d = dist(detection.position, swimmer.position);
        if (d <= MATCH_GATE_RADIUS_M) {
          const iou = detection.bbox ? this.computePolarIoU(frame, detection.bbox, swimmer) : 0;
          pairs.push({ detectionIndex, truthIndex, distance: d, iou });
        }
      });
    });

    pairs.sort((a, b) => a.distance - b.distance);
    const usedDetections = new Set<number>();
    const usedTruth = new Set<number>();
    const matches: { detectionIndex: number; detection: Detection; truth: SwimmerTruth; distance: number; iou: number }[] = [];
    for (const pair of pairs) {
      if (usedDetections.has(pair.detectionIndex) || usedTruth.has(pair.truthIndex)) continue;
      usedDetections.add(pair.detectionIndex);
      usedTruth.add(pair.truthIndex);
      matches.push({
        detectionIndex: pair.detectionIndex,
        detection: { ...detections[pair.detectionIndex], source: 'target' },
        truth: truth[pair.truthIndex],
        distance: pair.distance,
        iou: pair.iou,
      });
    }
    return matches;
  }

  private matchTracksToTruth(truth: SwimmerTruth[], tracks: TrackBelief[]) {
    const liveTracks = tracks.filter(track => track.status === 'confirmed');
    const pairs: { trackIndex: number; truthIndex: number; distance: number }[] = [];
    liveTracks.forEach((track, trackIndex) => {
      truth.forEach((swimmer, truthIndex) => {
        const d = dist(track.position, swimmer.position);
        if (d <= MATCH_GATE_RADIUS_M) pairs.push({ trackIndex, truthIndex, distance: d });
      });
    });

    pairs.sort((a, b) => a.distance - b.distance);
    const usedTracks = new Set<number>();
    const usedTruth = new Set<number>();
    const matches: { truthId: string; trackId: string; distance: number }[] = [];
    for (const pair of pairs) {
      if (usedTracks.has(pair.trackIndex) || usedTruth.has(pair.truthIndex)) continue;
      usedTracks.add(pair.trackIndex);
      usedTruth.add(pair.truthIndex);
      matches.push({
        truthId: truth[pair.truthIndex].truthId,
        trackId: liveTracks[pair.trackIndex].trackId,
        distance: pair.distance,
      });
    }
    return matches;
  }

  private recordTrackIdentityScanState(time: number, truth: SwimmerTruth[], tracks: TrackBelief[]) {
    if (truth.length === 0) return;
    const matchByTruth = new Map(this.matchTracksToTruth(truth, tracks).map(match => [match.truthId, match]));

    for (const swimmer of truth) {
      const match = matchByTruth.get(swimmer.truthId);
      if (!match) {
        this.trackIdentityScanSamples.push({
          time,
          truthId: swimmer.truthId,
          correct: false,
          localCorrect: this.recordLocalIdentitySample(swimmer.truthId),
          outcome: 'missed',
        });
        continue;
      }

      const canonicalTrackId = this.canonicalTrackByTruth.get(swimmer.truthId);
      const canonicalTruthId = this.canonicalTruthByTrack.get(match.trackId);
      let correct = false;

      if (!canonicalTrackId && (!canonicalTruthId || canonicalTruthId === swimmer.truthId)) {
        this.canonicalTrackByTruth.set(swimmer.truthId, match.trackId);
        this.canonicalTruthByTrack.set(match.trackId, swimmer.truthId);
        correct = true;
      } else if (canonicalTrackId === match.trackId && (!canonicalTruthId || canonicalTruthId === swimmer.truthId)) {
        this.canonicalTruthByTrack.set(match.trackId, swimmer.truthId);
        correct = true;
      }

      this.trackIdentityScanSamples.push({
        time,
        truthId: swimmer.truthId,
        trackId: match.trackId,
        correct,
        localCorrect: this.recordLocalIdentitySample(swimmer.truthId, match.trackId),
        outcome: correct ? 'correct' : 'wrong_id',
      });
    }
  }

  private recordLocalIdentitySample(truthId: string, trackId?: string) {
    if (!trackId) {
      this.pendingLocalTrackByTruth.delete(truthId);
      return false;
    }

    const acceptedTrackId = this.localTrackByTruth.get(truthId);
    if (!acceptedTrackId) {
      this.localTrackByTruth.set(truthId, trackId);
      this.pendingLocalTrackByTruth.delete(truthId);
      return true;
    }

    if (acceptedTrackId === trackId) {
      this.pendingLocalTrackByTruth.delete(truthId);
      return true;
    }

    const pendingTrackId = this.pendingLocalTrackByTruth.get(truthId);
    if (pendingTrackId === trackId) {
      this.localTrackByTruth.set(truthId, trackId);
      this.pendingLocalTrackByTruth.delete(truthId);
      return true;
    }

    this.pendingLocalTrackByTruth.set(truthId, trackId);
    return false;
  }

  private computePolarIoU(frame: SonarFrame, bbox: { aMin: number; aMax: number; rMin: number; rMax: number }, swimmer: SwimmerTruth): number {
    const swimmerRange = dist(frame.sonarPosition, swimmer.position);
    const bestBeamIndex = Math.max(0, Math.min(frame.beams.length - 1, Math.round((bbox.aMin + bbox.aMax) / 2)));
    const rangeStep = (frame.beams[bestBeamIndex]?.range ?? frame.range) / frame.rangeBins;
    const swimmerRadiusBins = 1.5;
    const swimmerRBin = swimmerRange / rangeStep;
    const swimmerAngle = angleToTarget(frame.sonarPosition, swimmer.position);
    let swimmerABin = 0;
    let bestDelta = Infinity;
    for (let index = 0; index < frame.beams.length; index++) {
      const delta = Math.abs(((swimmerAngle - frame.beams[index].angle + 540) % 360) - 180);
      if (delta < bestDelta) {
        bestDelta = delta;
        swimmerABin = index;
      }
    }
    const truthRMin = Math.max(0, swimmerRBin - swimmerRadiusBins);
    const truthRMax = Math.min(frame.rangeBins, swimmerRBin + swimmerRadiusBins);
    const truthAMin = Math.max(0, swimmerABin - swimmerRadiusBins * 1.5);
    const truthAMax = Math.min(frame.angleBins, swimmerABin + swimmerRadiusBins * 1.5);

    const interRMin = Math.max(bbox.rMin, truthRMin);
    const interRMax = Math.min(bbox.rMax, truthRMax);
    const interAMin = Math.max(bbox.aMin, truthAMin);
    const interAMax = Math.min(bbox.aMax, truthAMax);
    if (interRMax <= interRMin || interAMax <= interAMin) return 0;

    const interArea = (interRMax - interRMin) * (interAMax - interAMin);
    const detArea = (bbox.rMax - bbox.rMin) * (bbox.aMax - bbox.aMin);
    const truthArea = (truthRMax - truthRMin) * (truthAMax - truthAMin);
    const unionArea = detArea + truthArea - interArea;
    return unionArea > 0 ? interArea / unionArea : 0;
  }

  private evaluateTracks(time: number, truth: SwimmerTruth[], tracks: TrackBelief[]): TrackFrameStats {
    const liveTracks = tracks.filter(track => track.status === 'confirmed');
    const pairs: { trackIndex: number; truthIndex: number; distance: number }[] = [];
    liveTracks.forEach((track, trackIndex) => {
      truth.forEach((swimmer, truthIndex) => {
        const d = dist(track.position, swimmer.position);
        if (d <= MATCH_GATE_RADIUS_M) pairs.push({ trackIndex, truthIndex, distance: d });
      });
    });

    pairs.sort((a, b) => a.distance - b.distance);
    const usedTracks = new Set<number>();
    const usedTruth = new Set<number>();
    let idSwitches = 0;
    let fragmentations = 0;
    const errors: number[] = [];
    const matches: TrackTruthMatch[] = [];

    for (const pair of pairs) {
      if (usedTracks.has(pair.trackIndex) || usedTruth.has(pair.truthIndex)) continue;
      usedTracks.add(pair.trackIndex);
      usedTruth.add(pair.truthIndex);
      errors.push(pair.distance);

      const truthId = truth[pair.truthIndex].truthId;
      const trackId = liveTracks[pair.trackIndex].trackId;
      matches.push({ truthId, trackId, distance: pair.distance });
      const previous = this.lastTrackByTruth.get(truthId);
      if (previous && previous !== trackId) idSwitches += 1;
      this.lastTrackByTruth.set(truthId, trackId);

      const seen = this.seenTrackByTruth.get(truthId) ?? new Set<string>();
      if (!seen.has(trackId) && seen.size > 0) fragmentations += 1;
      seen.add(trackId);
      this.seenTrackByTruth.set(truthId, seen);
    }

    return {
      time,
      truthIds: truth.map(swimmer => swimmer.truthId),
      matches,
      tp: usedTracks.size,
      falseTracks: Math.max(0, liveTracks.length - usedTracks.size),
      missedTracks: Math.max(0, truth.length - usedTruth.size),
      idSwitches,
      fragmentations,
      errors,
    };
  }

  private computeGOSPAComponents(localizationErrors: number[], missedTracks: number, falseTracks: number) {
    const c = 5;
    const p = 2;
    const alpha = 2;
    const locCost = localizationErrors.reduce((sum, e) => sum + Math.pow(Math.min(e, c), p), 0);
    const missCost = missedTracks * Math.pow(c, p) / alpha;
    const falseCost = falseTracks * Math.pow(c, p) / alpha;
    return {
      total: Math.pow(locCost + missCost + falseCost, 1 / p),
      localization: Math.pow(locCost, 1 / p),
      missed: Math.pow(missCost, 1 / p),
      falseTargets: Math.pow(falseCost, 1 / p),
    };
  }

  private prune(now: number) {
    const cutoff = now - EVAL_RETENTION_SEC;
    this.detectionFrames = this.detectionFrames.filter(f => f.time >= cutoff);
    this.trackFrames = this.trackFrames.filter(f => f.time >= cutoff);
    this.trackIdentityScanSamples = this.trackIdentityScanSamples.filter(sample => sample.time >= cutoff);
    this.localizationErrors = this.localizationErrors.filter(e => e.time >= cutoff);
    this.falseAlarmCounts = this.falseAlarmCounts.filter(f => f.time >= cutoff);
    this.hitStats = this.hitStats.filter(s => s.time >= cutoff);
    for (const times of this.frameTimesBySonar.values()) {
      while (times.length > 0 && times[0] < cutoff) times.shift();
    }
  }
}
