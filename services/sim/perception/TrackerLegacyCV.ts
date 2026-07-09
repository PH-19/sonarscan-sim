import { Detection, SonarFrame, TrackBelief, Vector2 } from '../../../types';
import { IMAGING_FOV_DEG, POOL_LENGTH, POOL_WIDTH, SWIMMER_SPEED_MAX } from '../../../constants';
import { angleToTarget } from '../../../utils/math';
import { hungarianAssignment } from '../../../utils/assignment';
import { createCV2D, getPositionCV2D, KalmanStateCV2D, predictCV2D, updateCV2D } from '../../../utils/kalman';

const TRACK_SIGMA_ACCEL = 0.3;
const MEAS_SIGMA_BASE = 0.25;
const MEAS_SIGMA_PER_M = 0.01;
const ASSOCIATION_GATE_BASE_M = 3.0;
const ASSOCIATION_GATE_CHI2 = 9.21; // 99% gate for a 2-D Gaussian measurement.
const LOST_AFTER_SEC = 20.0;
const CONFIRM_HITS = 3;
const DELETE_MISSES = 5;
const CONFIRM_EXISTENCE = 0.8;
const COAST_EXISTENCE = 0.6;
const DELETE_EXISTENCE = 0.12;
const MISS_EXISTENCE_SURVIVAL = 0.65;
const VELOCITY_MEASUREMENT_BLEND_MAX = 0.18;

type TrackState = {
  trackId: string;
  filter: KalmanStateCV2D;
  createdAt: number;
  lastUpdateAt: number;
  hits: number;
  misses: number;
  existenceProbability: number;
  confirmed: boolean;
  sourceSonars: Set<string>;
  lastMeasurement: { position: Vector2; time: number };
  reportedVelocity: Vector2;
};

const distance = (a: Vector2, b: Vector2) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

const covarianceMatrix = (p: number[]) => [
  [p[0], p[1], p[2], p[3]],
  [p[4], p[5], p[6], p[7]],
  [p[8], p[9], p[10], p[11]],
  [p[12], p[13], p[14], p[15]],
];

export class Tracker {
  private tracks = new Map<string, TrackState>();
  private nextTrackIndex = 1;

  reset() {
    this.tracks.clear();
    this.nextTrackIndex = 1;
  }

  predict(now: number) {
    for (const track of this.tracks.values()) {
      predictCV2D(track.filter, now, this.sigmaAccel(track, now));
      this.reflectAtPoolBoundary(track.filter);
    }
    this.prune(now);
  }

  update(now: number, detections: Detection[], observedFrames: SonarFrame[] = []) {
    const matchedTracks = new Set<string>();
    const timeGroups: Detection[][] = [];
    for (const detection of [...detections].sort((a, b) => a.time - b.time)) {
      const group = timeGroups[timeGroups.length - 1];
      if (!group || detection.time - group[group.length - 1].time > 0.5) timeGroups.push([detection]);
      else group.push(detection);
    }

    for (const group of timeGroups) {
      const groupTime = Math.max(...group.map(detection => detection.time));
      for (const track of this.tracks.values()) {
        if (groupTime >= track.filter.t) {
          predictCV2D(track.filter, groupTime, this.sigmaAccel(track, groupTime));
          this.reflectAtPoolBoundary(track.filter);
        }
      }

      const pairs: {
        trackId: string;
        detectionIndex: number;
        mahalanobis2: number;
        measurement: Vector2;
      }[] = [];
      for (const [detectionIndex, detection] of group.entries()) {
        for (const track of this.tracks.values()) {
          const effectiveTime = Math.max(groupTime, track.filter.t);
          const delay = Math.max(0, effectiveTime - detection.time);
          const measurement = {
            x: detection.position.x + track.filter.x[2] * delay,
            y: detection.position.y + track.filter.x[3] * delay,
          };
          const pos = getPositionCV2D(track.filter);
          const dx = measurement.x - pos.x;
          const dy = measurement.y - pos.y;
          const euclidean = Math.hypot(dx, dy);
          const elapsedSinceUpdate = Math.max(0, detection.time - track.lastUpdateAt);
          const reachableGate = Math.min(30, ASSOCIATION_GATE_BASE_M + SWIMMER_SPEED_MAX * elapsedSinceUpdate);
          const measSigma = MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * detection.range + (1 - detection.confidence) * 0.8;
          const r = measSigma * measSigma;
          const s00 = track.filter.P[0] + r;
          const s01 = track.filter.P[1];
          const s10 = track.filter.P[4];
          const s11 = track.filter.P[5] + r;
          const determinant = s00 * s11 - s01 * s10;
          if (determinant <= 1e-9) continue;
          const mahalanobis2 = (dx * (s11 * dx - s01 * dy) + dy * (-s10 * dx + s00 * dy)) / determinant;
          if (euclidean <= reachableGate && mahalanobis2 <= ASSOCIATION_GATE_CHI2) {
            pairs.push({ trackId: track.trackId, detectionIndex, mahalanobis2, measurement });
          }
        }
      }

      const trackIds = [...this.tracks.keys()];
      const pairByKey = new Map(pairs.map(pair => [`${pair.detectionIndex}|${pair.trackId}`, pair]));
      const dummyCost = ASSOCIATION_GATE_CHI2 + 0.01;
      const impossibleCost = 1e6;
      const costMatrix = group.map((_, detectionIndex) => [
        ...trackIds.map(trackId => pairByKey.get(`${detectionIndex}|${trackId}`)?.mahalanobis2 ?? impossibleCost),
        ...group.map((__, dummyIndex) => dummyIndex === detectionIndex ? dummyCost : dummyCost + 1),
      ]);
      const assignment = hungarianAssignment(costMatrix);
      const usedDetections = new Set<number>();
      for (const [detectionIndex, column] of assignment.entries()) {
        if (column < 0 || column >= trackIds.length) continue;
        const pair = pairByKey.get(`${detectionIndex}|${trackIds[column]}`);
        if (!pair) continue;
        const track = this.tracks.get(pair.trackId);
        if (!track) continue;
        const detection = group[pair.detectionIndex];
        const sigma = MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * detection.range + (1 - detection.confidence) * 0.8;
        updateCV2D(track.filter, pair.measurement, sigma);
        const measurementDt = detection.time - track.lastMeasurement.time;
        if (measurementDt > 0.2) {
          let measuredVx = (detection.position.x - track.lastMeasurement.position.x) / measurementDt;
          let measuredVy = (detection.position.y - track.lastMeasurement.position.y) / measurementDt;
          const measuredSpeed = Math.hypot(measuredVx, measuredVy);
          const maxPlausibleSpeed = SWIMMER_SPEED_MAX * 1.5;
          if (measuredSpeed > maxPlausibleSpeed) {
            measuredVx *= maxPlausibleSpeed / measuredSpeed;
            measuredVy *= maxPlausibleSpeed / measuredSpeed;
          }
          const confidenceWeight = clamp(0.04 + 0.14 * detection.confidence, 0.04, VELOCITY_MEASUREMENT_BLEND_MAX);
          const intervalWeight = measurementDt < 0.6
            ? clamp(measurementDt / 0.6, 0.2, 1)
            : clamp(6 / measurementDt, 0.35, 1);
          const blend = confidenceWeight * intervalWeight;
          track.filter.x[2] = (1 - blend) * track.filter.x[2] + blend * measuredVx;
          track.filter.x[3] = (1 - blend) * track.filter.x[3] + blend * measuredVy;
          track.lastMeasurement = { position: { ...detection.position }, time: detection.time };
        }
        this.limitVelocity(track.filter);
        this.smoothReportedVelocity(track);
        track.lastUpdateAt = Math.max(track.lastUpdateAt, detection.time);
        track.hits += 1;
        track.misses = 0;
        const multiSonar = detection.sonarId.includes('+');
        const detectionSupport = Math.min(0.85, 0.45 + 0.3 * detection.confidence + (multiSonar ? 0.08 : 0));
        track.existenceProbability += (1 - track.existenceProbability) * detectionSupport;
        for (const sonarId of detection.sonarId.split('+')) track.sourceSonars.add(sonarId);
        if (
          track.hits >= CONFIRM_HITS
          && track.sourceSonars.size >= 2
          && track.existenceProbability >= CONFIRM_EXISTENCE
        ) {
          track.confirmed = true;
        }
        usedDetections.add(pair.detectionIndex);
        matchedTracks.add(pair.trackId);
      }

      for (const [detectionIndex, detection] of group.entries()) {
        if (usedDetections.has(detectionIndex)) continue;
        const posVar = Math.max(4, Math.pow(MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * detection.range, 2) * 9);
        const trackId = `T${String(this.nextTrackIndex++).padStart(4, '0')}`;
        this.tracks.set(trackId, {
          trackId,
          filter: createCV2D({
            x: detection.position.x,
            y: detection.position.y,
            vx: 0,
            vy: 0,
            t: detection.time,
            posVar,
            velVar: 25,
          }),
          createdAt: detection.time,
          lastUpdateAt: detection.time,
          hits: 1,
          misses: 0,
          existenceProbability: Math.min(
            0.75,
            0.32 + 0.2 * detection.confidence + (detection.sonarId.includes('+') ? 0.12 : 0),
          ),
          confirmed: false,
          sourceSonars: new Set(detection.sonarId.split('+')),
          lastMeasurement: { position: { ...detection.position }, time: detection.time },
          reportedVelocity: { x: 0, y: 0 },
        });
        matchedTracks.add(trackId);
      }
    }

    this.mergeDuplicateTracks(now, matchedTracks);

    for (const trackId of this.tracks.keys()) {
      if (matchedTracks.has(trackId)) continue;
      const track = this.tracks.get(trackId);
      if (track && (observedFrames.length === 0 || this.wasObservable(track, observedFrames))) {
        track.misses += 1;
        track.existenceProbability *= MISS_EXISTENCE_SURVIVAL;
      }
    }

    this.prune(now);
    return this.getBeliefs(now);
  }

  getBeliefs(now: number) {
    const beliefs: TrackBelief[] = [];
    for (const track of this.tracks.values()) {
      const predicted: KalmanStateCV2D = {
        x: [...track.filter.x] as KalmanStateCV2D['x'],
        P: [...track.filter.P],
        t: track.filter.t,
      };
      predictCV2D(predicted, now, this.sigmaAccel(track, now));
      this.reflectAtPoolBoundary(predicted);
      const position = getPositionCV2D(predicted);
      const age = Math.max(0, now - track.createdAt);
      const timeSinceUpdate = Math.max(0, now - track.lastUpdateAt);
      const confidence = Math.max(0, Math.min(1, track.existenceProbability));
      const status: TrackBelief['status'] = timeSinceUpdate > LOST_AFTER_SEC
        ? 'lost'
        : track.confirmed
          && confidence >= COAST_EXISTENCE
          ? 'confirmed'
          : 'tentative';

      beliefs.push({
        trackId: track.trackId,
        position,
        velocity: { x: predicted.x[2], y: predicted.x[3] },
        covariance: covarianceMatrix(predicted.P),
        age,
        timeSinceUpdate,
        confidence,
        status,
      });
    }
    return beliefs;
  }

  private prune(now: number) {
    for (const [trackId, track] of this.tracks.entries()) {
      if (
        now - track.lastUpdateAt > LOST_AFTER_SEC * 2
        || track.misses >= DELETE_MISSES
        || (track.misses > 0 && track.existenceProbability < DELETE_EXISTENCE)
      ) {
        this.tracks.delete(trackId);
      }
    }
  }

  private mergeDuplicateTracks(now: number, matchedTracks: Set<string>) {
    const entries = [...this.tracks.entries()];
    const predicted = new Map<string, KalmanStateCV2D>();
    for (const [trackId, track] of entries) {
      const state: KalmanStateCV2D = {
        x: [...track.filter.x] as KalmanStateCV2D['x'],
        P: [...track.filter.P],
        t: track.filter.t,
      };
      predictCV2D(state, now, this.sigmaAccel(track, now));
      this.reflectAtPoolBoundary(state);
      predicted.set(trackId, state);
    }

    for (let i = 0; i < entries.length; i++) {
      const [idA, trackA] = entries[i];
      if (!this.tracks.has(idA)) continue;
      const stateA = predicted.get(idA);
      if (!stateA) continue;
      for (let j = i + 1; j < entries.length; j++) {
        const [idB, trackB] = entries[j];
        if (!this.tracks.has(idB)) continue;
        const stateB = predicted.get(idB);
        if (!stateB) continue;
        const separation = Math.hypot(stateA.x[0] - stateB.x[0], stateA.x[1] - stateB.x[1]);
        const velocityDifference = Math.hypot(stateA.x[2] - stateB.x[2], stateA.x[3] - stateB.x[3]);
        if (separation > 2.0 || velocityDifference > 2.5) continue;

        const [keepId, keep, removeId, remove] = trackA.hits >= trackB.hits
          ? [idA, trackA, idB, trackB]
          : [idB, trackB, idA, trackA];
        keep.hits = Math.max(keep.hits, remove.hits);
        keep.misses = Math.min(keep.misses, remove.misses);
        keep.existenceProbability = Math.max(keep.existenceProbability, remove.existenceProbability);
        keep.confirmed ||= remove.confirmed;
        keep.createdAt = Math.min(keep.createdAt, remove.createdAt);
        keep.lastUpdateAt = Math.max(keep.lastUpdateAt, remove.lastUpdateAt);
        if (remove.lastMeasurement.time > keep.lastMeasurement.time) {
          keep.lastMeasurement = {
            position: { ...remove.lastMeasurement.position },
            time: remove.lastMeasurement.time,
          };
        }
        keep.reportedVelocity = {
          x: (keep.reportedVelocity.x + remove.reportedVelocity.x) / 2,
          y: (keep.reportedVelocity.y + remove.reportedVelocity.y) / 2,
        };
        for (const sonarId of remove.sourceSonars) keep.sourceSonars.add(sonarId);
        this.tracks.delete(removeId);
        if (matchedTracks.has(removeId)) matchedTracks.add(keepId);
        if (removeId === idA) break;
      }
    }
  }

  private wasObservable(track: TrackState, frames: SonarFrame[]) {
    return frames.some(frame => {
      const predicted: KalmanStateCV2D = {
        x: [...track.filter.x] as KalmanStateCV2D['x'],
        P: [...track.filter.P],
        t: track.filter.t,
      };
      predictCV2D(predicted, frame.endTime, this.sigmaAccel(track, frame.endTime));
      this.reflectAtPoolBoundary(predicted);
      const position = getPositionCV2D(predicted);
      const range = distance(position, frame.sonarPosition);
      const bearing = angleToTarget(frame.sonarPosition, position);
      return frame.beams.some(beam => {
        if (range > (beam.range ?? frame.range)) return false;
        const delta = Math.abs(((bearing - beam.angle + 540) % 360) - 180);
        return delta <= IMAGING_FOV_DEG / 2;
      });
    });
  }

  private reflectAtPoolBoundary(state: KalmanStateCV2D) {
    const reflectAxis = (positionIndex: 0 | 1, velocityIndex: 2 | 3, limit: number) => {
      for (let guard = 0; guard < 4; guard++) {
        if (state.x[positionIndex] < 0) {
          state.x[positionIndex] = -state.x[positionIndex];
          state.x[velocityIndex] = -state.x[velocityIndex];
        } else if (state.x[positionIndex] > limit) {
          state.x[positionIndex] = 2 * limit - state.x[positionIndex];
          state.x[velocityIndex] = -state.x[velocityIndex];
        } else {
          break;
        }
      }
    };
    reflectAxis(0, 2, POOL_WIDTH);
    reflectAxis(1, 3, POOL_LENGTH);
  }

  private sigmaAccel(track: TrackState, toTime: number) {
    void track;
    void toTime;
    return TRACK_SIGMA_ACCEL;
  }

  private smoothReportedVelocity(track: TrackState) {
    const current = { x: track.filter.x[2], y: track.filter.x[3] };
    const currentSpeed = Math.hypot(current.x, current.y);
    if (currentSpeed <= 1e-6) return;
    const reportedSpeed = Math.hypot(track.reportedVelocity.x, track.reportedVelocity.y);
    const blend = reportedSpeed <= 0.15 ? 1 : 0.18;
    track.reportedVelocity = {
      x: (1 - blend) * track.reportedVelocity.x + blend * current.x,
      y: (1 - blend) * track.reportedVelocity.y + blend * current.y,
    };
  }

  private limitVelocity(state: KalmanStateCV2D, maxSpeed = SWIMMER_SPEED_MAX * 1.5) {
    const speed = Math.hypot(state.x[2], state.x[3]);
    if (speed <= maxSpeed || speed <= 1e-9) return;
    state.x[2] *= maxSpeed / speed;
    state.x[3] *= maxSpeed / speed;
  }
}
