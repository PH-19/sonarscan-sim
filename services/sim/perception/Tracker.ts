import { Detection, SonarFrame, TrackBelief, Vector2 } from '../../../types';
import { IMAGING_FOV_DEG, POOL_LENGTH, POOL_WIDTH, SWIMMER_SPEED_MAX } from '../../../constants';
import { angleToTarget } from '../../../utils/math';
import { hungarianAssignment } from '../../../utils/assignment';
import { createCV2D, getPositionCV2D, KalmanStateCV2D, predictCV2D, updateCV2D } from '../../../utils/kalman';

const TRACK_SIGMA_ACCEL_BASE = 0.35;
const TRACK_SIGMA_ACCEL_STALE = 1.0;
const TRACK_SIGMA_ACCEL_RAMP_SEC = 8.0;
const MEAS_SIGMA_BASE = 0.25;
const MEAS_SIGMA_PER_M = 0.01;
const ASSOCIATION_GATE_BASE_M = 1.2;
const ASSOCIATION_GATE_CHI2 = 25.0;
const ASSOCIATION_ACCEPT_COST = 32.0;
const DUMMY_ASSIGNMENT_COST = 34.0;
const LOST_AFTER_SEC = 20.0;
const CONFIRM_HITS = 3;
const DELETE_MISSES = 8;
const CONFIRM_EXISTENCE = 0.8;
const COAST_EXISTENCE = 0.6;
const DELETE_EXISTENCE = 0.06;
const DEFAULT_MISS_EXISTENCE_SURVIVAL = 0.78;
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

type AssociationCandidate = {
  cost: number;
  measurement: Vector2;
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
  private laneConstraintEnabled = false;
  private laneCount = 1;
  private missExistenceSurvival = DEFAULT_MISS_EXISTENCE_SURVIVAL;

  configureMissExistenceSurvival(survival: number) {
    this.missExistenceSurvival = clamp(survival, 0, 1);
  }

  configureLaneConstraint(enabled: boolean, laneCount: number) {
    this.laneConstraintEnabled = enabled;
    this.laneCount = Math.max(1, Math.floor(laneCount));
  }

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
    const detectionsByFrame = new Map<string, Detection[]>();
    for (const detection of detections) {
      const fallbackFrameId = `${detection.sonarId}|${Math.round(detection.time * 1000)}`;
      const frameId = detection.frameId ?? fallbackFrameId;
      const group = detectionsByFrame.get(frameId) ?? [];
      group.push(detection);
      detectionsByFrame.set(frameId, group);
    }
    const timeGroups = [...detectionsByFrame.values()].sort((left, right) => (
      Math.min(...left.map(detection => detection.time))
        - Math.min(...right.map(detection => detection.time))
    ));

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
        cost: number;
        measurement: Vector2;
      }[] = [];
      for (const [detectionIndex, detection] of group.entries()) {
        for (const track of this.tracks.values()) {
          const candidate = this.buildAssociationCandidate(
            track,
            detection,
            groupTime,
            ASSOCIATION_GATE_BASE_M,
            4,
            0.35,
            14,
            ASSOCIATION_GATE_CHI2,
            ASSOCIATION_ACCEPT_COST
          );
          if (candidate) {
            pairs.push({
              trackId: track.trackId,
              detectionIndex,
              cost: candidate.cost,
              measurement: candidate.measurement,
            });
          }
        }
      }

      const trackIds = [...this.tracks.keys()];
      const pairByKey = new Map(pairs.map(pair => [`${pair.detectionIndex}|${pair.trackId}`, pair]));
      const dummyCost = DUMMY_ASSIGNMENT_COST;
      const impossibleCost = 1e6;
      const costMatrix = group.map((_, detectionIndex) => [
        ...trackIds.map(trackId => pairByKey.get(`${detectionIndex}|${trackId}`)?.cost ?? impossibleCost),
        ...group.map((__, dummyIndex) => dummyIndex === detectionIndex ? dummyCost : dummyCost + 1),
      ]);
      const assignment = hungarianAssignment(costMatrix);
      const usedDetections = new Set<number>();
      for (const [detectionIndex, column] of assignment.entries()) {
        if (column < 0 || column >= trackIds.length) continue;
        const pair = pairByKey.get(`${detectionIndex}|${trackIds[column]}`);
        if (!pair || pair.cost > ASSOCIATION_ACCEPT_COST) continue;
        const track = this.tracks.get(pair.trackId);
        if (!track) continue;
        const detection = group[pair.detectionIndex];
        this.applyDetectionToTrack(track, detection, pair.measurement);
        usedDetections.add(pair.detectionIndex);
        matchedTracks.add(pair.trackId);
      }

      for (const [detectionIndex, detection] of group.entries()) {
        if (usedDetections.has(detectionIndex)) continue;
        const measurementSigma = MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * detection.range;
        const posVar = Math.max(0.16, measurementSigma * measurementSigma * 4);
        const circulationDirection = this.expectedLaneDirection(detection.position);
        const trackId = `T${String(this.nextTrackIndex++).padStart(4, '0')}`;
        this.tracks.set(trackId, {
          trackId,
          filter: createCV2D({
            x: detection.position.x,
            y: detection.position.y,
            vx: 0,
            // Public lap swimming follows a known two-leg circulation path.
            // Initialising the sign of longitudinal motion from the observed
            // side of the lane is a geometry prior, not swimmer identity or
            // ground truth.  It avoids spending several sparse scans learning
            // whether a new track is travelling up or down the pool.
            vy: circulationDirection === undefined ? 0 : circulationDirection * 0.7,
            t: detection.time,
            posVar,
            // Swimmer speed is physically bounded at 1 m/s in this workload;
            // a 5 m/s standard deviation makes nearby counter-flow hypotheses
            // indistinguishable before velocity has even been observed.
            velVar: SWIMMER_SPEED_MAX * SWIMMER_SPEED_MAX,
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

    for (const trackId of this.tracks.keys()) {
      if (matchedTracks.has(trackId)) continue;
      const track = this.tracks.get(trackId);
      if (track && (observedFrames.length === 0 || this.wasObservable(track, observedFrames))) {
        track.misses += 1;
        track.existenceProbability *= this.missExistenceSurvival;
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
      const missLimit = track.confirmed ? DELETE_MISSES * 2 : DELETE_MISSES;
      if (
        now - track.lastUpdateAt > LOST_AFTER_SEC * 2
        || track.misses >= missLimit
        || (track.misses > 0 && track.existenceProbability < DELETE_EXISTENCE)
      ) {
        this.tracks.delete(trackId);
      }
    }
  }

  private buildAssociationCandidate(
    track: TrackState,
    detection: Detection,
    groupTime: number,
    gateBaseM: number,
    maxStaleSec: number,
    posSigmaWeight: number,
    maxGateM: number,
    chi2Gate: number,
    acceptCost: number
  ): AssociationCandidate | null {
    const effectiveTime = Math.max(groupTime, track.filter.t);
    const delay = Math.max(0, effectiveTime - detection.time);
    const measurement = {
      x: detection.position.x + track.filter.x[2] * delay,
      y: detection.position.y + track.filter.x[3] * delay,
    };
    const pos = getPositionCV2D(track.filter);
    if (
      this.laneConstraintEnabled
      && this.laneIndex(pos.x) !== this.laneIndex(measurement.x)
    ) {
      return null;
    }
    const dx = measurement.x - pos.x;
    const dy = measurement.y - pos.y;
    const euclidean = Math.hypot(dx, dy);
    const elapsedSinceUpdate = Math.max(0, detection.time - track.lastUpdateAt);
    const posSigma = Math.sqrt(Math.max(0, track.filter.P[0] + track.filter.P[5]));
    const reachableGate = Math.min(
      maxGateM,
      gateBaseM
        + SWIMMER_SPEED_MAX * Math.min(elapsedSinceUpdate, maxStaleSec)
        + posSigmaWeight * posSigma
    );
    const measSigma = MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * detection.range + (1 - detection.confidence) * 0.8;
    const r = measSigma * measSigma;
    const s00 = track.filter.P[0] + r;
    const s01 = track.filter.P[1];
    const s10 = track.filter.P[4];
    const s11 = track.filter.P[5] + r;
    const determinant = s00 * s11 - s01 * s10;
    if (determinant <= 1e-9) return null;
    const mahalanobis2 = (dx * (s11 * dx - s01 * dy) + dy * (-s10 * dx + s00 * dy)) / determinant;
    if (euclidean > reachableGate || mahalanobis2 > chi2Gate) return null;

    const cost = this.associationCost(track, detection, measurement, mahalanobis2, euclidean, reachableGate);
    if (cost > acceptCost) return null;
    return { cost, measurement };
  }

  private applyDetectionToTrack(track: TrackState, detection: Detection, measurement: Vector2) {
    const sigma = MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * detection.range + (1 - detection.confidence) * 0.8;
    updateCV2D(track.filter, measurement, sigma);
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
  }

  private associationCost(
    track: TrackState,
    detection: Detection,
    measurement: Vector2,
    mahalanobis2: number,
    euclidean: number,
    reachableGate: number
  ) {
    const gateRatio = reachableGate > 1e-6 ? euclidean / reachableGate : 1;
    let cost = 0.62 * mahalanobis2 + 7.0 * gateRatio * gateRatio;

    if (this.laneConstraintEnabled) {
      const expectedDirection = this.expectedLaneDirection(detection.position);
      const trackVy = track.filter.x[3];
      if (
        expectedDirection !== undefined
        && Math.abs(trackVy) > 0.25
        && Math.sign(trackVy) !== expectedDirection
      ) {
        cost += 10;
      }
    }

    const measurementDt = detection.time - track.lastMeasurement.time;
    if (measurementDt > 0.2) {
      const impliedVx = (detection.position.x - track.lastMeasurement.position.x) / measurementDt;
      const impliedVy = (detection.position.y - track.lastMeasurement.position.y) / measurementDt;
      const impliedSpeed = Math.hypot(impliedVx, impliedVy);
      const trackSpeed = Math.hypot(track.filter.x[2], track.filter.x[3]);
      const maxPlausibleSpeed = SWIMMER_SPEED_MAX * 1.7;
      if (impliedSpeed > maxPlausibleSpeed) {
        cost += Math.min(10, 6 * (impliedSpeed / maxPlausibleSpeed - 1));
      }

      if (trackSpeed > 0.45 && impliedSpeed > 0.45 && measurementDt < 6) {
        const dot = track.filter.x[2] * impliedVx + track.filter.x[3] * impliedVy;
        const cosine = dot / Math.max(1e-6, trackSpeed * impliedSpeed);
        const staleSec = Math.max(0, detection.time - track.lastUpdateAt);
        const headingWeight = clamp(1 - staleSec / 8, 0.25, 1);
        cost += 2.4 * headingWeight * (1 - clamp(cosine, -1, 1));
      }
    }

    cost += (1 - detection.confidence) * 2.0;
    if (track.confirmed) cost -= 2.4;
    else if (track.hits >= 2) cost -= 0.8;
    cost += Math.min(3.5, track.misses * 0.8);

    void measurement;
    return cost;
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
    const staleSec = Math.max(0, toTime - track.lastUpdateAt);
    const ramp = clamp(staleSec / TRACK_SIGMA_ACCEL_RAMP_SEC, 0, 1);
    return TRACK_SIGMA_ACCEL_BASE + (TRACK_SIGMA_ACCEL_STALE - TRACK_SIGMA_ACCEL_BASE) * ramp;
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

  private laneIndex(x: number) {
    const laneWidth = POOL_WIDTH / this.laneCount;
    return Math.max(0, Math.min(this.laneCount - 1, Math.floor(x / laneWidth)));
  }

  private expectedLaneDirection(position: Vector2): -1 | 1 | undefined {
    if (!this.laneConstraintEnabled) return undefined;
    // Direction is ambiguous while a swimmer is executing the semicircular
    // turn at either short end, so the prior is deliberately disabled there.
    if (position.y < 1.25 || position.y > POOL_LENGTH - 1.25) return undefined;
    const laneWidth = POOL_WIDTH / this.laneCount;
    const laneCenter = (this.laneIndex(position.x) + 0.5) * laneWidth;
    const lateralOffset = position.x - laneCenter;
    if (Math.abs(lateralOffset) < 0.12) return undefined;
    return lateralOffset < 0 ? 1 : -1;
  }
}
