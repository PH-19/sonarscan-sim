import { EngineEvalMetrics, SonarMode, SonarState, StrategyType, Swimmer, Vector2 } from '../types';
import {
  POOL_WIDTH, POOL_LENGTH, SPEED_OF_SOUND, SLEW_SPEED, SCAN_STEP_ANGLE,
  PING360_PROCESSING_OVERHEAD_S,
  MAX_RANGE_NAIVE, TARGET_PADDING_ANGLE, TARGET_PADDING_RANGE, SWIMMER_SPEED_MIN, SWIMMER_SPEED_MAX,
  OPT_SWEEP_MIN_DEG, OPT_SWEEP_REPLAN_DEG, OPT_SWEEP_MAX_HOLD_SEC,
  IMAGING_FRAME_ANGLE_BINS, IMAGING_BLOB_RADIUS_BINS, IMAGING_BLOB_SIGMA_BINS, IMAGING_ECHO_RANGE_ATTENUATION_M,
  IMAGING_ECHO_STRENGTH, IMAGING_FOV_DEG, IMAGING_MAX_CLUSTERS_PER_PING, IMAGING_MIN_CLUSTER_CELLS,
  POOL_LANE_COUNT, IMAGING_STATIC_WALL_ECHO_STRENGTH, IMAGING_STATIC_LANE_ECHO_STRENGTH, IMAGING_STATIC_ECHO_SIGMA_BINS,
  IMAGING_BACKGROUND_WARMUP_FRAMES, IMAGING_BACKGROUND_WARMUP_ALPHA, IMAGING_BACKGROUND_EMA_ALPHA, IMAGING_BACKGROUND_UPDATE_SLACK,
  AQUASCAN_KERNEL_CAP, AQUASCAN_WEAK_ECHO_PERCENTILE, AQUASCAN_WEAK_ECHO_MIN,
  AQUASCAN_DBSCAN_EPS_BINS, AQUASCAN_DBSCAN_MIN_PTS,
  AQUASCAN_MIN_CROSS_RANGE_M, AQUASCAN_MAX_CROSS_RANGE_M, AQUASCAN_MIN_RANGE_EXTENT_M, AQUASCAN_MAX_RANGE_EXTENT_M,
  AQUASCAN_MIN_ASPECT, AQUASCAN_MAX_ASPECT, AQUASCAN_DENOISE_OVERLAP_MIN,
  AQUASCAN_IOU_MATCH_THRESHOLD, SIM_SWIMMER_DIAMETER_M,
  IMAGING_NOISE_FLOOR, IMAGING_NOISE_STD, IMAGING_NOISE_TO_MEAS_SIGMA_M, IMAGING_RANGE_BINS, IMAGING_SPECKLE_PROB, IMAGING_SPECKLE_STRENGTH,
  IMAGING_MEAS_JITTER_SCALE,
  IMAGING_WEAK_BAND_PROB, IMAGING_WEAK_BAND_STRENGTH, IMAGING_GHOST_REL_STRENGTH, IMAGING_GHOST_RANGE_OFFSET_M,
  IMAGING_THRESHOLD,
  MATCH_GATE_RADIUS_M,
  PSO_SWARM_SIZE, PSO_ITERATIONS, PSO_INERTIA, PSO_COGNITIVE, PSO_SOCIAL, PSO_UPDATE_INTERVAL
} from '../constants';
import { degToRad, distance, angleToTarget, normalizeAngle, radToDeg } from '../utils/math';
import { createCV2D, getPositionCV2D, KalmanStateCV2D, predictCV2D, updateCV2D } from '../utils/kalman';
import { createLCGRng, hashStringToUint32 } from '../utils/rng';

type CandidatePoint = {
  time: number;
  timeBucketMs: number;
  sonarId: string;
  x: number;
  y: number;
  measSigma: number;
  // Polar-image bbox in (angleBin, rangeBin), inclusive.
  bbox: { aMin: number; aMax: number; rMin: number; rMax: number };
  // Amplitude-weighted centroid in polar bins (continuous).
  centroidAR: { a: number; r: number };
  sumI: number;
};

type MatchEvent = {
  time: number;
  timeBucketMs: number;
  swimmerId: string;
  sonarId: string;
  measX: number;
  measY: number;
  measSigma: number;
  localizationErrorM: number;
};

type SweepBounds = {
  min: number;
  max: number;
  lastUpdate: number;
};

const DEFAULT_EVAL_WINDOW_SEC = 10;
const EVAL_RETENTION_SEC = 20;
const TIME_BUCKET_MS = 1; // used for per-timestamp de-dup

const TRACK_SIGMA_ACCEL = 0.9; // m/s^2 (model mismatch)
const MEAS_SIGMA_BASE = 0.25; // meters
const MEAS_SIGMA_PER_M = 0.01; // meters per meter of range

const TURN_RATE_MAX_RAD_PER_SEC = 0.18; // swimmer "maneuver" (helps make revisit frequency matter)

const quantizeTimeMs = (tSec: number) => Math.round((tSec * 1000) / TIME_BUCKET_MS) * TIME_BUCKET_MS;

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

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

const signedDeltaAngleDeg = (targetDeg: number, centerDeg: number) => {
  const diff = ((targetDeg - centerDeg + 540) % 360) - 180;
  return diff;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type SonarFrameBuffers = {
  frameId: number;
  intensity: Float32Array;
  background: Float32Array;
  subtracted: Float32Array;
  mask: Uint8Array; // reused as raw mask (weak-echo eliminated + thresholded)
  maskSmall: Uint8Array;
  maskLarge: Uint8Array;
  labels: Int32Array;
  visited: Uint8Array;
  observedAngles: Uint8Array;
  warmupFramesLeft: number;
};

export type EngineTuningParams = {
  noiseScale: number; // scales IMAGING_NOISE_STD + clutter strengths
  speckleProb: number;
  threshold: number; // intensity threshold (after background subtraction + weak-echo elimination)
  dbscanEpsBins: number;
  dbscanMinPts: number;
  kernelCap: number; // odd, <= 13
};

export class SimulationEngine {
  sonars: SonarState[] = [];
  swimmers: Swimmer[] = [];
  strategy: StrategyType = 'NAIVE';
  time: number = 0;

  // Eval + tracking state (per-engine, from real detections)
  private evalSeed: number;
  private matchedEvents: MatchEvent[] = [];
  private falseAlarmCounts: { time: number; count: number }[] = [];
  private detectionStats: { time: number; opportunities: number; hits: number }[] = [];
  private paperDetections: { time: number; tp: number; fp: number; fn: number; iouSum: number }[] = [];
  private frameTimesBySonar = new Map<string, number[]>();
  private localizationErrors: { time: number; err: number }[] = [];
  private lastSeenTimeBySwimmer = new Map<string, number>(); // seconds
  private lastUpdateBucketBySwimmer = new Map<string, number>(); // ms bucket
  private updateTimesBySwimmer = new Map<string, number[]>(); // seconds (deduped by ms bucket)
  private tracksBySwimmer = new Map<string, KalmanStateCV2D>();
  private maneuverBySwimmer = new Map<string, { omega: number; phase: number; amp: number }>();
  private firstDetectionTimeBySwimmer = new Map<string, number>(); // seconds
  private frameBuffersBySonar = new Map<string, SonarFrameBuffers>();
  private lastDirBySonar = new Map<string, 1 | -1>();
  private sweepBoundsBySonar = new Map<string, SweepBounds>();

  // PSO optimized assignment of swimmers to sonars
  optimizedAssignments: Record<string, string[]> = {};
  private lastOptimizationTime = 0;
  private lastTargetCount = 0;

  private tuning: EngineTuningParams;

  constructor(opts?: { strategy?: StrategyType; evalSeed?: number }) {
    this.strategy = opts?.strategy ?? 'NAIVE';
    this.evalSeed = opts?.evalSeed ?? 1337;
    this.tuning = {
      noiseScale: 0.85,
      speckleProb: IMAGING_SPECKLE_PROB,
      threshold: IMAGING_THRESHOLD,
      dbscanEpsBins: AQUASCAN_DBSCAN_EPS_BINS,
      dbscanMinPts: AQUASCAN_DBSCAN_MIN_PTS,
      kernelCap: AQUASCAN_KERNEL_CAP,
    };
    this.reset();
  }

  setTuningParams(next: Partial<EngineTuningParams>) {
    const merged: EngineTuningParams = { ...this.tuning, ...next };
    merged.noiseScale = clamp(merged.noiseScale, 0, 5);
    merged.speckleProb = clamp(merged.speckleProb, 0, 0.5);
    merged.threshold = clamp(merged.threshold, 0, 10);
    merged.dbscanEpsBins = clamp(merged.dbscanEpsBins, 0.5, 12);
    merged.dbscanMinPts = clamp(merged.dbscanMinPts, 2, 200);
    const cap = Math.floor(clamp(merged.kernelCap, 3, 13));
    merged.kernelCap = cap % 2 === 0 ? cap - 1 : cap;
    this.tuning = merged;
  }

  reset() {
    this.time = 0;
    this.swimmers = [];
    this.matchedEvents = [];
    this.falseAlarmCounts = [];
    this.detectionStats = [];
    this.paperDetections = [];
    this.localizationErrors = [];
    this.lastSeenTimeBySwimmer.clear();
    this.lastUpdateBucketBySwimmer.clear();
    this.updateTimesBySwimmer.clear();
    this.tracksBySwimmer.clear();
    this.maneuverBySwimmer.clear();
    this.firstDetectionTimeBySwimmer.clear();
    this.frameBuffersBySonar.clear();
    this.frameTimesBySonar.clear();
    this.lastDirBySonar.clear();
    this.sweepBoundsBySonar.clear();

    const makeSonar = (id: string, position: Vector2, mountAngle: number): SonarState => {
      const absMin = mountAngle - 45;
      const absMax = mountAngle + 45;
      return {
        id,
        position,
        angle: mountAngle,
        mountAngle,
        minAngle: 0,
        maxAngle: 90,
        currentAngle: absMin,
        mode: SonarMode.SCANNING,
        targetAngle: absMax,
        scanRange: MAX_RANGE_NAIVE,
        pingAccumulator: 0,
        lastScanTime: 0,
        cycleDuration: 0,
        detectedPoints: [],
        matchedPoints: []
      };
    };

    // Initialize 4 Sonars at corners, each covering an inward 90° sector
    this.sonars = [
      makeSonar('S1', { x: 0, y: 0 }, 45),
      makeSonar('S2', { x: POOL_WIDTH, y: 0 }, 135),
      makeSonar('S3', { x: POOL_WIDTH, y: POOL_LENGTH }, 225),
      makeSonar('S4', { x: 0, y: POOL_LENGTH }, 315),
    ];

    // Start a fresh imaging frame per sonar.
    for (const sonar of this.sonars) {
      this.beginNewFrame(sonar);
      const d = Math.sign(sonar.targetAngle - sonar.currentAngle);
      this.lastDirBySonar.set(sonar.id, (d === 0 ? 1 : d) as 1 | -1);
      const absMin = sonar.mountAngle - 45;
      const absMax = sonar.mountAngle + 45;
      this.sweepBoundsBySonar.set(sonar.id, { min: absMin, max: absMax, lastUpdate: 0 });
    }

    this.optimizedAssignments = {};
    this.lastOptimizationTime = 0;
    this.lastTargetCount = 0;
  }

  addSwimmer(swimmer?: Swimmer) {
    const s = swimmer ? this.cloneSwimmer(swimmer) : this.makeRandomSwimmer();
    this.swimmers.push(s);
    this.initSwimmerState(s);
    return s;
  }

  removeSwimmer() {
    const removed = this.swimmers.pop();
    if (removed) this.cleanupSwimmerState(removed.id);
    return removed;
  }

  removeSwimmerById(id: string) {
    const idx = this.swimmers.findIndex(s => s.id === id);
    if (idx >= 0) {
      this.swimmers.splice(idx, 1);
      this.cleanupSwimmerState(id);
      return true;
    }
    return false;
  }

  private cloneSwimmer(swimmer: Swimmer): Swimmer {
    return {
      id: swimmer.id,
      enteredAt: swimmer.enteredAt,
      position: { x: swimmer.position.x, y: swimmer.position.y },
      velocity: { x: swimmer.velocity.x, y: swimmer.velocity.y },
    };
  }

  private makeRandomSwimmer(): Swimmer {
    const rng = createLCGRng(hashStringToUint32(`${this.evalSeed}|randomSwimmer|${this.swimmers.length}|${Math.floor(this.time * 10)}`));
    const side = rng.nextInt(4);
    let pos: Vector2 = { x: 0, y: 0 };
    let vel: Vector2 = { x: 0, y: 0 };
    const speed = rng.nextRange(SWIMMER_SPEED_MIN, SWIMMER_SPEED_MAX);

    switch (side) {
      case 0: // Top (y=0)
        pos = { x: rng.nextRange(0, POOL_WIDTH), y: 0 };
        vel = { x: rng.nextRange(-0.5, 0.5), y: 1 };
        break;
      case 1: // Bottom (y=POOL_LENGTH)
        pos = { x: rng.nextRange(0, POOL_WIDTH), y: POOL_LENGTH };
        vel = { x: rng.nextRange(-0.5, 0.5), y: -1 };
        break;
      case 2: // Left (x=0)
        pos = { x: 0, y: rng.nextRange(0, POOL_LENGTH) };
        vel = { x: 1, y: rng.nextRange(-0.5, 0.5) };
        break;
      case 3: // Right (x=POOL_WIDTH)
        pos = { x: POOL_WIDTH, y: rng.nextRange(0, POOL_LENGTH) };
        vel = { x: -1, y: rng.nextRange(-0.5, 0.5) };
        break;
    }

    const mag = Math.sqrt(vel.x ** 2 + vel.y ** 2) || 1;
    vel.x = (vel.x / mag) * speed;
    vel.y = (vel.y / mag) * speed;

    return {
      id: `sw_${hashStringToUint32(`${this.evalSeed}|${rng.next()}`)}`,
      position: pos,
      velocity: vel,
      enteredAt: this.time,
    };
  }

  private initSwimmerState(swimmer: Swimmer) {
    this.lastSeenTimeBySwimmer.set(swimmer.id, swimmer.enteredAt);
    this.lastUpdateBucketBySwimmer.delete(swimmer.id);
    this.updateTimesBySwimmer.set(swimmer.id, []);
    this.firstDetectionTimeBySwimmer.delete(swimmer.id);
    // Track is created on first successful match (avoid using truth for planning).
    this.tracksBySwimmer.delete(swimmer.id);

    const rng = createLCGRng(hashStringToUint32(`${this.evalSeed}|maneuver|${swimmer.id}`));
    const omega = rng.nextRange(0.25, 0.9); // rad/s
    const phase = rng.nextRange(0, Math.PI * 2);
    const amp = rng.nextRange(0.04, TURN_RATE_MAX_RAD_PER_SEC);
    this.maneuverBySwimmer.set(swimmer.id, { omega, phase, amp });
  }

  private cleanupSwimmerState(id: string) {
    this.lastSeenTimeBySwimmer.delete(id);
    this.lastUpdateBucketBySwimmer.delete(id);
    this.updateTimesBySwimmer.delete(id);
    this.tracksBySwimmer.delete(id);
    this.maneuverBySwimmer.delete(id);
    this.firstDetectionTimeBySwimmer.delete(id);
  }

  private getSweepDir(sonar: SonarState): 1 | -1 {
    const d = Math.sign(sonar.targetAngle - sonar.currentAngle);
    if (d === 1 || d === -1) return d;
    return this.lastDirBySonar.get(sonar.id) ?? 1;
  }

  private estimateScanningSpeedDegPerSec(range: number) {
    const roundTripTime = (2 * range) / SPEED_OF_SOUND;
    return SCAN_STEP_ANGLE / Math.max(0.01, roundTripTime + PING360_PROCESSING_OVERHEAD_S);
  }

  private estimateCycleDurationNaive(sonar: SonarState) {
    const sweepWidth = 90; // degrees per sonar sector in this demo
    const scanSpeed = this.estimateScanningSpeedDegPerSec(MAX_RANGE_NAIVE);
    const oneWay = sweepWidth / scanSpeed;
    return oneWay * 2;
  }

  private estimateCycleDurationOptimized(
    sonar: SonarState,
    targets: { ang: number; dist: number }[]
  ) {
    if (targets.length === 0) return this.estimateCycleDurationNaive(sonar);

    const sweepStart = sonar.mountAngle - 45;
    const intervals = targets.map(t => {
      const rel = normalizeAngle(t.ang - sweepStart);
      const start = Math.max(0, rel - TARGET_PADDING_ANGLE);
      const end = Math.min(90, rel + TARGET_PADDING_ANGLE);
      const range = Math.min(t.dist + TARGET_PADDING_RANGE, MAX_RANGE_NAIVE);
      return { rel, start, end, range };
    }).filter(i => i.rel <= 90 && i.end > 0 && i.start < 90)
      .sort((a, b) => a.start - b.start);

    if (intervals.length === 0) return this.estimateCycleDurationNaive(sonar);

    // Merge overlapping intervals; take worst-case (max) range within a cluster
    const merged: { start: number; end: number; range: number }[] = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (!last || interval.start > last.end) {
        merged.push({ start: interval.start, end: interval.end, range: interval.range });
      } else {
        last.end = Math.max(last.end, interval.end);
        last.range = Math.max(last.range, interval.range);
      }
    }

    let current = 0;
    let oneWay = 0;
    for (const interval of merged) {
      const gap = Math.max(0, interval.start - current);
      oneWay += gap / SLEW_SPEED;

      const width = Math.max(0, interval.end - Math.max(interval.start, current));
      const scanSpeed = this.estimateScanningSpeedDegPerSec(interval.range);
      oneWay += width / scanSpeed;
      current = Math.max(current, interval.end);
    }

    const tailGap = Math.max(0, 90 - current);
    oneWay += tailGap / SLEW_SPEED;

    return oneWay * 2;
  }

  // PSO to assign each swimmer to a sonar to minimize the slowest sonar's cycle time
  private runPSOAssignments(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    this.sonars.forEach(s => { result[s.id] = []; });

    const targets = Array.from(this.tracksBySwimmer.entries()).map(([id, track]) => {
      const p = getPositionCV2D(track);
      return {
        id,
        position: { x: clamp(p.x, 0, POOL_WIDTH), y: clamp(p.y, 0, POOL_LENGTH) },
      };
    });

    const nTargets = targets.length;
    const mSonars = this.sonars.length;
    if (nTargets === 0 || mSonars === 0) return result;

    const eligibleSonars: number[][] = targets.map(t => {
      const eligible: number[] = [];
      this.sonars.forEach((sonar, idx) => {
        const ang = angleToTarget(sonar.position, t.position);
        const sweepStart = sonar.mountAngle - 45;
        const rel = normalizeAngle(ang - sweepStart);
        if (rel <= 90) eligible.push(idx);
      });

      if (eligible.length === 0) {
        let bestIdx = 0;
        let bestDist = Infinity;
        this.sonars.forEach((sonar, idx) => {
          const d = distance(sonar.position, t.position);
          if (d < bestDist) { bestDist = d; bestIdx = idx; }
        });
        eligible.push(bestIdx);
      }

      return eligible;
    });

    type Particle = {
      pos: number[];
      vel: number[];
      bestPos: number[];
      bestCost: number;
    };

    const psoBucket = Math.floor(this.time / PSO_UPDATE_INTERVAL);
    const rng = createLCGRng(hashStringToUint32(`${this.evalSeed}|pso|${psoBucket}|${nTargets}`));

    const randomEligible = (t: number) => {
      const opts = eligibleSonars[t];
      return opts[rng.nextInt(opts.length)];
    };

    const evaluate = (pos: number[]) => {
      const perSonarTargets: { ang: number; dist: number }[][] =
        Array.from({ length: mSonars }, () => []);
      let invalid = 0;

      for (let j = 0; j < nTargets; j++) {
        let idx = Math.round(pos[j]);
        idx = Math.max(0, Math.min(mSonars - 1, idx));

        const t = targets[j];
        const sonar = this.sonars[idx];
        const ang = angleToTarget(sonar.position, t.position);
        const dist = distance(sonar.position, t.position);
        if (!eligibleSonars[j].includes(idx)) invalid++;

        perSonarTargets[idx].push({ ang, dist });
      }

      const cycles = perSonarTargets.map((targets, i) =>
        this.estimateCycleDurationOptimized(this.sonars[i], targets)
      );
      const maxCycle = Math.max(...cycles);
      return maxCycle + invalid * 5; // penalize impossible assignments
    };

    const particles: Particle[] = [];
    let globalBestPos: number[] = [];
    let globalBestCost = Infinity;

    for (let p = 0; p < PSO_SWARM_SIZE; p++) {
      const pos = Array.from({ length: nTargets }, (_, j) => randomEligible(j));
      const vel = Array.from({ length: nTargets }, () => (rng.next() - 0.5));
      const cost = evaluate(pos);

      particles.push({ pos, vel, bestPos: [...pos], bestCost: cost });
      if (cost < globalBestCost) {
        globalBestCost = cost;
        globalBestPos = [...pos];
      }
    }

    for (let iter = 0; iter < PSO_ITERATIONS; iter++) {
      for (const particle of particles) {
        for (let j = 0; j < nTargets; j++) {
          const r1 = rng.next();
          const r2 = rng.next();
          particle.vel[j] =
            PSO_INERTIA * particle.vel[j] +
            PSO_COGNITIVE * r1 * (particle.bestPos[j] - particle.pos[j]) +
            PSO_SOCIAL * r2 * (globalBestPos[j] - particle.pos[j]);

          particle.pos[j] += particle.vel[j];
          particle.pos[j] = Math.max(0, Math.min(mSonars - 1, particle.pos[j]));
        }

        const cost = evaluate(particle.pos);
        if (cost < particle.bestCost) {
          particle.bestCost = cost;
          particle.bestPos = [...particle.pos];
        }
        if (cost < globalBestCost) {
          globalBestCost = cost;
          globalBestPos = [...particle.pos];
        }
      }
    }

    for (let j = 0; j < nTargets; j++) {
      let idx = Math.round(globalBestPos[j]);
      idx = Math.max(0, Math.min(mSonars - 1, idx));
      const sonarId = this.sonars[idx].id;
      result[sonarId].push(targets[j].id);
    }

    return result;
  }

  // Determine the next target angle and range based on strategy
  private planNextSector(sonar: SonarState): { nextTarget: number, mode: SonarMode, range: number } {
    const absMin = sonar.mountAngle - 45; // Scanning 90 deg sectors for this demo
    const absMax = sonar.mountAngle + 45;
    const isAscending = this.getSweepDir(sonar) > 0;

    // --- NAIVE STRATEGY ---
    // Always sweep min -> max -> min
    if (this.strategy === 'NAIVE') {
      // If we reached the target (roughly), flip direction
      if (Math.abs(sonar.currentAngle - sonar.targetAngle) < 1) {
        return {
          nextTarget: isAscending ? absMin : absMax,
          mode: SonarMode.SCANNING,
          range: MAX_RANGE_NAIVE
        };
      }
      return {
        nextTarget: sonar.targetAngle,
        mode: SonarMode.SCANNING,
        range: MAX_RANGE_NAIVE
      };
    }

    // --- OPTIMIZED (PSO-inspired / Track-driven range adaptation) ---
    // Use predicted tracks (Kalman) to adapt scan range; currently still a full-sector sweep
    // (no intermittent scanning / ROI skipping yet).

    // Use PSO assignment if available, otherwise fall back to local FOV targets
    const assignedIds = this.optimizedAssignments[sonar.id] || [];
    const assignedSet = assignedIds.length > 0 ? new Set(assignedIds) : null;
    const trackedTargets = Array.from(this.tracksBySwimmer.entries()).map(([id, track]) => {
      const p = getPositionCV2D(track);
      return { id, position: { x: clamp(p.x, 0, POOL_WIDTH), y: clamp(p.y, 0, POOL_LENGTH) } };
    });
    const relevantTargets = assignedSet
      ? trackedTargets.filter(t => assignedSet.has(t.id))
      : trackedTargets;

    const sweepStart = sonar.mountAngle - 45;
    let activeTargets = relevantTargets.map(t => {
      const ang = angleToTarget(sonar.position, t.position);
      const dist = distance(sonar.position, t.position);
      return { ang, dist, id: t.id };
    }).filter(t => {
      return normalizeAngle(t.ang - sweepStart) <= 90;
    });

    // If PSO assigned nothing usable (e.g. transient), fall back to all local targets
    if (activeTargets.length === 0 && assignedSet) {
      activeTargets = trackedTargets.map(t => {
        const ang = angleToTarget(sonar.position, t.position);
        const dist = distance(sonar.position, t.position);
        return { ang, dist, id: t.id };
      }).filter(t => {
        return normalizeAngle(t.ang - sweepStart) <= 90;
      });
    }

    // NOTE: Do not apply intermittent scanning here yet (requested).
    // If no tracked targets, fall back to full-sector sweep.
    if (activeTargets.length === 0) {
      this.sweepBoundsBySonar.set(sonar.id, { min: absMin, max: absMax, lastUpdate: this.time });
      if (Math.abs(sonar.currentAngle - sonar.targetAngle) < 1) {
        return { nextTarget: isAscending ? absMin : absMax, mode: SonarMode.SCANNING, range: MAX_RANGE_NAIVE };
      }
      return { nextTarget: sonar.targetAngle, mode: SonarMode.SCANNING, range: MAX_RANGE_NAIVE };
    }

    // Targets exist. Adapt sweep bounds (continuous scan, no intermittent gaps).
    const sectorWidth = 90;
    let desiredMinRel = Infinity;
    let desiredMaxRel = -Infinity;
    for (const t of activeTargets) {
      const rel = normalizeAngle(t.ang - sweepStart);
      if (rel > sectorWidth) continue;
      desiredMinRel = Math.min(desiredMinRel, rel);
      desiredMaxRel = Math.max(desiredMaxRel, rel);
    }

    let desiredMin = absMin;
    let desiredMax = absMax;
    if (Number.isFinite(desiredMinRel) && Number.isFinite(desiredMaxRel)) {
      desiredMin = sweepStart + Math.max(0, desiredMinRel - TARGET_PADDING_ANGLE);
      desiredMax = sweepStart + Math.min(sectorWidth, desiredMaxRel + TARGET_PADDING_ANGLE);

      const minWidth = Math.max(OPT_SWEEP_MIN_DEG, TARGET_PADDING_ANGLE * 2);
      if (desiredMax - desiredMin < minWidth) {
        const center = (desiredMin + desiredMax) * 0.5;
        desiredMin = center - minWidth * 0.5;
        desiredMax = center + minWidth * 0.5;
      }

      if (desiredMin < absMin) {
        desiredMax += absMin - desiredMin;
        desiredMin = absMin;
      }
      if (desiredMax > absMax) {
        desiredMin -= desiredMax - absMax;
        desiredMax = absMax;
      }
      desiredMin = clamp(desiredMin, absMin, absMax);
      desiredMax = clamp(desiredMax, absMin, absMax);
      if (desiredMax - desiredMin < 1) {
        desiredMin = absMin;
        desiredMax = absMax;
      }
    }

    const prev = this.sweepBoundsBySonar.get(sonar.id);
    const now = this.time;
    const drift = prev
      ? Math.max(Math.abs(desiredMin - prev.min), Math.abs(desiredMax - prev.max))
      : Infinity;
    const atBoundary = Math.abs(sonar.currentAngle - sonar.targetAngle) < 1;
    const outside =
      !prev ||
      sonar.currentAngle < prev.min - 0.5 ||
      sonar.currentAngle > prev.max + 0.5;
    const shouldUpdate =
      !prev ||
      atBoundary ||
      outside ||
      (drift >= OPT_SWEEP_REPLAN_DEG && now - prev.lastUpdate >= OPT_SWEEP_MAX_HOLD_SEC);

    const bounds = shouldUpdate
      ? { min: desiredMin, max: desiredMax, lastUpdate: now }
      : prev;
    if (shouldUpdate && bounds) this.sweepBoundsBySonar.set(sonar.id, bounds);

    const minBound = bounds?.min ?? absMin;
    const maxBound = bounds?.max ?? absMax;

    let dir = this.getSweepDir(sonar);
    if (sonar.currentAngle <= minBound + 0.5) dir = 1;
    if (sonar.currentAngle >= maxBound - 0.5) dir = -1;
    const nextTarget = dir > 0 ? maxBound : minBound;

    // Adapt range using track predictions.
    let desiredRange = 0;
    for (const t of activeTargets) desiredRange = Math.max(desiredRange, t.dist + TARGET_PADDING_RANGE);
    const range = clamp(desiredRange, 1, MAX_RANGE_NAIVE);

    if (
      Math.abs(sonar.currentAngle - sonar.targetAngle) < 1 ||
      sonar.targetAngle < minBound ||
      sonar.targetAngle > maxBound
    ) {
      return { nextTarget, mode: SonarMode.SCANNING, range };
    }
    return { nextTarget: sonar.targetAngle, mode: SonarMode.SCANNING, range };
  }

  private getFrameBuffers(sonarId: string) {
    const angleBins = IMAGING_FRAME_ANGLE_BINS;
    const rangeBins = IMAGING_RANGE_BINS;
    const nCells = angleBins * rangeBins;
    const existing = this.frameBuffersBySonar.get(sonarId);
    if (!existing || existing.intensity.length !== nCells) {
      const next: SonarFrameBuffers = {
        frameId: -1,
        intensity: new Float32Array(nCells),
        background: new Float32Array(nCells),
        subtracted: new Float32Array(nCells),
        mask: new Uint8Array(nCells),
        maskSmall: new Uint8Array(nCells),
        maskLarge: new Uint8Array(nCells),
        labels: new Int32Array(nCells),
        visited: new Uint8Array(nCells),
        observedAngles: new Uint8Array(angleBins),
        warmupFramesLeft: IMAGING_BACKGROUND_WARMUP_FRAMES,
      };
      this.frameBuffersBySonar.set(sonarId, next);
      return next;
    }
    return existing;
  }

  private beginNewFrame(sonar: SonarState) {
    const buf = this.getFrameBuffers(sonar.id);
    buf.frameId += 1;
    buf.observedAngles.fill(0);
    // For unobserved angles (e.g., intermittent scanning), carry the background forward so subtraction yields ~0.
    buf.intensity.set(buf.background);
    buf.visited.fill(0);
    buf.mask.fill(0);
    buf.maskSmall.fill(0);
    buf.maskLarge.fill(0);
    buf.labels.fill(0);
  }

  private raycastDistanceToPoolBoundary(origin: Vector2, angleDeg: number): number | null {
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

  private raycastDistanceToVerticalLine(origin: Vector2, angleDeg: number, xLine: number): number | null {
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

  private addGaussianEcho1D(
    buf: SonarFrameBuffers,
    colBase: number,
    rCenter: number,
    rMax: number,
    amp: number,
    sigmaBins: number
  ) {
    if (!(amp > 0) || !(sigmaBins > 0)) return;
    const rangeBins = IMAGING_RANGE_BINS;
    const r0 = Math.floor(rCenter);
    const radius = Math.max(1, Math.ceil(sigmaBins * 3));
    const s2 = sigmaBins * sigmaBins;
    for (let dr = -radius; dr <= radius; dr++) {
      const r = r0 + dr;
      if (r < 0 || r > rMax || r >= rangeBins) continue;
      const w = Math.exp(-(dr * dr) / (2 * s2));
      buf.intensity[colBase + r] += amp * w;
    }
  }

  private writePingToFrame(
    sonar: SonarState,
    pingAngle: number,
    pingTime: number,
    timeBucketMs: number
  ) {
    const buf = this.getFrameBuffers(sonar.id);
    const angleBins = IMAGING_FRAME_ANGLE_BINS;
    const rangeBins = IMAGING_RANGE_BINS;

    const absMin = sonar.mountAngle - 45;
    const sectorWidth = 90;
    const angleStep = sectorWidth / angleBins;
    const rel = clamp(normalizeAngle(pingAngle - absMin), 0, sectorWidth);
    const aIdx = clamp(Math.round(rel / Math.max(1e-6, angleStep)), 0, angleBins - 1);

    buf.observedAngles[aIdx] = 1;
    const colBase = aIdx * rangeBins;

    const rangeStep = MAX_RANGE_NAIVE / rangeBins;
    const rMax = clamp(Math.floor(sonar.scanRange / Math.max(1e-6, rangeStep)), 0, rangeBins - 1);

    const rng = createLCGRng(
      hashStringToUint32(`${this.evalSeed}|ping|${sonar.id}|${buf.frameId}|${timeBucketMs}|${aIdx}`)
    );
    const dynRng = createLCGRng(
      hashStringToUint32(`${this.evalSeed}|dyn|${sonar.id}|${buf.frameId}|${timeBucketMs}|${aIdx}`)
    );

    // Base noise + speckle (heavy-tail)
    for (let r = 0; r <= rMax; r++) {
      let v = IMAGING_NOISE_FLOOR + rng.nextNormal(0, IMAGING_NOISE_STD * this.tuning.noiseScale);
      if (rng.next() < this.tuning.speckleProb) {
        // Pareto-like impulsive speckle
        const u = Math.max(1e-6, rng.next());
        const alpha = 2.2;
        const ht = 1 / Math.pow(1 - u, 1 / alpha) - 1;
        v += IMAGING_SPECKLE_STRENGTH * ht;
      }
      buf.intensity[colBase + r] = v > 0 ? v : 0;
    }

    // Dynamic weak-echo band (surface-wave / multipath-like striping)
    if (dynRng.next() < IMAGING_WEAK_BAND_PROB) {
      const rBand = dynRng.nextInt(Math.max(1, rMax + 1));
      const amp = IMAGING_WEAK_BAND_STRENGTH * this.tuning.noiseScale * (0.7 + 0.8 * dynRng.next());
      const sigma = 1.6;
      this.addGaussianEcho1D(buf, colBase, rBand, rMax, amp, sigma);
    }

    // Static echoes: pool walls + lane lines (deterministic geometry)
    const wallDist = this.raycastDistanceToPoolBoundary(sonar.position, pingAngle);
    if (wallDist !== null && wallDist <= sonar.scanRange) {
      const rCenter = wallDist / rangeStep;
      this.addGaussianEcho1D(buf, colBase, rCenter, rMax, IMAGING_STATIC_WALL_ECHO_STRENGTH, IMAGING_STATIC_ECHO_SIGMA_BINS);

      // Multipath ghost near strong static returns (low intensity, can overlap targets)
      const ghostR = (wallDist + IMAGING_GHOST_RANGE_OFFSET_M * (0.6 + 0.8 * dynRng.next())) / rangeStep;
      if (ghostR <= rMax) {
        this.addGaussianEcho1D(
          buf,
          colBase,
          ghostR,
          rMax,
          IMAGING_STATIC_WALL_ECHO_STRENGTH * IMAGING_GHOST_REL_STRENGTH * this.tuning.noiseScale,
          IMAGING_STATIC_ECHO_SIGMA_BINS * 1.4
        );
      }
    }

    const laneCount = Math.max(1, POOL_LANE_COUNT);
    for (let k = 1; k < laneCount; k++) {
      const xLine = (POOL_WIDTH * k) / laneCount;
      const d = this.raycastDistanceToVerticalLine(sonar.position, pingAngle, xLine);
      if (d === null || d > sonar.scanRange) continue;
      const rCenter = d / rangeStep;
      this.addGaussianEcho1D(buf, colBase, rCenter, rMax, IMAGING_STATIC_LANE_ECHO_STRENGTH, IMAGING_STATIC_ECHO_SIGMA_BINS);
    }

    // Target echoes (swimmers)
    const halfFov = IMAGING_FOV_DEG / 2;
    const sigma2 = IMAGING_BLOB_SIGMA_BINS * IMAGING_BLOB_SIGMA_BINS;
    for (const swimmer of this.swimmers) {
      const dist = distance(sonar.position, swimmer.position);
      if (dist > sonar.scanRange) continue;
      const ang = angleToTarget(sonar.position, swimmer.position);
      const dAng = signedDeltaAngleDeg(ang, pingAngle);
      if (Math.abs(dAng) > halfFov) continue;

      const echo =
        IMAGING_ECHO_STRENGTH * Math.exp(-dist / Math.max(1e-6, IMAGING_ECHO_RANGE_ATTENUATION_M));
      const rCenter = dist / rangeStep;
      const r0 = Math.floor(rCenter);
      for (let dr = -IMAGING_BLOB_RADIUS_BINS; dr <= IMAGING_BLOB_RADIUS_BINS; dr++) {
        const r = r0 + dr;
        if (r < 0 || r > rMax || r >= rangeBins) continue;
        const w = Math.exp(-(dr * dr) / (2 * sigma2));
        buf.intensity[colBase + r] += echo * w;
      }

      // Multipath ghost of the swimmer echo (lower intensity, range-shifted)
      const ghostDist = dist + IMAGING_GHOST_RANGE_OFFSET_M * (0.6 + 0.8 * dynRng.next());
      if (ghostDist <= sonar.scanRange) {
        const gCenter = ghostDist / rangeStep;
        const g0 = Math.floor(gCenter);
        for (let dr = -IMAGING_BLOB_RADIUS_BINS; dr <= IMAGING_BLOB_RADIUS_BINS; dr++) {
          const r = g0 + dr;
          if (r < 0 || r > rMax || r >= rangeBins) continue;
          const w = Math.exp(-(dr * dr) / (2 * sigma2));
          buf.intensity[colBase + r] += echo * IMAGING_GHOST_REL_STRENGTH * this.tuning.noiseScale * w;
        }
      }
    }
  }

  private samplePercentile(values: Float32Array, p: number, stride = 7) {
    if (!(p >= 0 && p <= 1)) return 0;
    const sampled: number[] = [];
    for (let i = 0; i < values.length; i += Math.max(1, stride)) sampled.push(values[i]);
    return percentile(sampled, p);
  }

  private majorityFilter1DRange(
    inMask: Uint8Array,
    outMask: Uint8Array,
    angleBins: number,
    rangeBins: number,
    kernelSize: number
  ) {
    const k = Math.max(1, Math.floor(kernelSize));
    const half = Math.floor(k / 2);

    // Edge-aware majority requirement (window shrinks near edges)
    const needByR = new Uint8Array(rangeBins);
    for (let r = 0; r < rangeBins; r++) {
      const r0 = Math.max(0, r - half);
      const r1 = Math.min(rangeBins - 1, r + half);
      const len = r1 - r0 + 1;
      needByR[r] = (len >> 1) + 1;
    }

    for (let a = 0; a < angleBins; a++) {
      const base = a * rangeBins;
      let sum = 0;
      for (let rr = 0; rr <= half && rr < rangeBins; rr++) sum += inMask[base + rr];

      for (let r = 0; r < rangeBins; r++) {
        outMask[base + r] = sum >= needByR[r] ? 1 : 0;
        const left = r - half;
        if (left >= 0) sum -= inMask[base + left];
        const right = r + half + 1;
        if (right < rangeBins) sum += inMask[base + right];
      }
    }
  }

  private dbscanOnMask(
    mask: Uint8Array,
    labels: Int32Array,
    angleBins: number,
    rangeBins: number,
    epsBins: number,
    minPts: number
  ) {
    labels.fill(0);
    const nCells = angleBins * rangeBins;
    const eps = Math.max(0.5, epsBins);
    const epsI = Math.ceil(eps);
    const eps2 = eps * eps;
    const minNeighbors = Math.max(1, Math.floor(minPts));

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

  private finishFrame(
    sonar: SonarState,
    frameTimeSec: number
  ): { candidates: CandidatePoint[]; swimmersInFov: Swimmer[] } {
    const buf = this.getFrameBuffers(sonar.id);
    const angleBins = IMAGING_FRAME_ANGLE_BINS;
    const rangeBins = IMAGING_RANGE_BINS;
    const nCells = angleBins * rangeBins;

    const timeBucketMs = quantizeTimeMs(frameTimeSec);

    // Background update (warmup) with no detections: treat as "background scan".
    if (buf.warmupFramesLeft > 0 && this.swimmers.length === 0) {
      const alpha = IMAGING_BACKGROUND_WARMUP_ALPHA;
      for (let i = 0; i < nCells; i++) {
        buf.background[i] = buf.background[i] * (1 - alpha) + buf.intensity[i] * alpha;
      }
      buf.warmupFramesLeft -= 1;
      this.beginNewFrame(sonar);
      return { candidates: [], swimmersInFov: [] };
    }

    // Background subtraction
    for (let i = 0; i < nCells; i++) {
      const v = buf.intensity[i] - buf.background[i];
      buf.subtracted[i] = v > 0 ? v : 0;
      buf.visited[i] = 0;
    }

    const absMin = sonar.mountAngle - 45;
    const sectorWidth = 90;
    const angleStep = sectorWidth / angleBins;
    const rangeStep = MAX_RANGE_NAIVE / rangeBins;

    // Weak-echo elimination (global percentile threshold on background-subtracted intensity)
    const weakThr = Math.max(
      AQUASCAN_WEAK_ECHO_MIN,
      this.samplePercentile(buf.subtracted, AQUASCAN_WEAK_ECHO_PERCENTILE, 9)
    );
    const thr = Math.max(this.tuning.threshold, weakThr);

    for (let i = 0; i < nCells; i++) buf.mask[i] = buf.subtracted[i] >= thr ? 1 : 0;

    type ClusterStats = {
      sumI: number;
      sumA: number;
      sumR: number;
      cells: number;
      aMin: number;
      aMax: number;
      rMin: number;
      rMax: number;
      overlapCells: number;
    };

    const cap = Math.max(3, Math.min(13, Math.floor(this.tuning.kernelCap)));
    const capOdd = cap % 2 === 0 ? cap - 1 : cap;

    let selected: ClusterStats[] = [];

    for (let kSmall = 3; kSmall <= capOdd; kSmall += 2) {
      const kLargeRaw = Math.min(capOdd, kSmall + 4);
      const kLarge = kLargeRaw % 2 === 0 ? kLargeRaw - 1 : kLargeRaw;

      // Two-branch median (binary majority) filter along range (Ping360 profile is 1D per bearing).
      this.majorityFilter1DRange(buf.mask, buf.maskSmall, angleBins, rangeBins, kSmall);
      this.majorityFilter1DRange(buf.mask, buf.maskLarge, angleBins, rangeBins, kLarge);

      const clusterCount = this.dbscanOnMask(
        buf.maskSmall,
        buf.labels,
        angleBins,
        rangeBins,
        this.tuning.dbscanEpsBins,
        this.tuning.dbscanMinPts
      );

      if (clusterCount === 0) continue;

      const clusters: ClusterStats[] = Array.from({ length: clusterCount }, () => ({
        sumI: 0,
        sumA: 0,
        sumR: 0,
        cells: 0,
        aMin: Infinity,
        aMax: -Infinity,
        rMin: Infinity,
        rMax: -Infinity,
        overlapCells: 0,
      }));

      for (let idx = 0; idx < nCells; idx++) {
        const label = buf.labels[idx];
        if (label <= 0) continue;
        const c = clusters[label - 1];
        const a = Math.floor(idx / rangeBins);
        const r = idx - a * rangeBins;
        const amp = buf.subtracted[idx];

        c.cells += 1;
        c.sumI += amp;
        c.sumA += amp * (a + 0.5);
        c.sumR += amp * (r + 0.5);
        if (a < c.aMin) c.aMin = a;
        if (a > c.aMax) c.aMax = a;
        if (r < c.rMin) c.rMin = r;
        if (r > c.rMax) c.rMax = r;
        if (buf.maskLarge[idx]) c.overlapCells += 1;
      }

      // Cluster-level fusion + physical constraints.
      const kept: ClusterStats[] = [];
      for (const c of clusters) {
        if (!(c.cells > 0) || !(c.sumI > 0)) continue;

        const overlapFrac = c.overlapCells / c.cells;
        if (overlapFrac < AQUASCAN_DENOISE_OVERLAP_MIN) continue;

        const aSpanBins = c.aMax - c.aMin + 1;
        const rSpanBins = c.rMax - c.rMin + 1;
        const angleSpanDeg = aSpanBins * angleStep;
        const rangeSpanM = rSpanBins * rangeStep;

        const aCent = c.sumA / c.sumI;
        const rCent = c.sumR / c.sumI;
        const rangeAtCentM = rCent * rangeStep;
        const crossRangeM = rangeAtCentM * degToRad(angleSpanDeg);
        const aspect = crossRangeM / Math.max(1e-6, rangeSpanM);

        if (crossRangeM < AQUASCAN_MIN_CROSS_RANGE_M || crossRangeM > AQUASCAN_MAX_CROSS_RANGE_M) continue;
        if (rangeSpanM < AQUASCAN_MIN_RANGE_EXTENT_M || rangeSpanM > AQUASCAN_MAX_RANGE_EXTENT_M) continue;
        if (aspect < AQUASCAN_MIN_ASPECT || aspect > AQUASCAN_MAX_ASPECT) continue;

        kept.push(c);
      }

      if (kept.length > 0) {
        kept.sort((a, b) => b.sumI - a.sumI);
        if (kept.length > IMAGING_MAX_CLUSTERS_PER_PING) kept.length = IMAGING_MAX_CLUSTERS_PER_PING;
        selected = kept;
        break;
      }
    }

    const candidates: CandidatePoint[] = [];
    const rangeStd = rangeStep / Math.sqrt(12);
    const angleStepRad = degToRad(angleStep);

    for (let i = 0; i < selected.length; i++) {
      const c = selected[i];
      const aIdx = c.sumA / c.sumI; // already includes +0.5
      const rIdx = c.sumR / c.sumI;

      const angleDeg = normalizeAngle(absMin + aIdx * angleStep);
      const rangeM = rIdx * rangeStep;

      const angleStd = (rangeM * angleStepRad) / Math.sqrt(12);
      const quantStd = Math.sqrt(rangeStd * rangeStd + angleStd * angleStd);
      const noiseSigma =
        IMAGING_NOISE_TO_MEAS_SIGMA_M *
        ((IMAGING_NOISE_STD * this.tuning.noiseScale) / Math.max(0.05, this.tuning.threshold));
      const measSigma = MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * rangeM + quantStd + noiseSigma;

      const jitterRng = createLCGRng(
        hashStringToUint32(`${this.evalSeed}|meas|${sonar.id}|${buf.frameId}|${timeBucketMs}|${i}`)
      );
      const angRad = degToRad(angleDeg);
      let x = sonar.position.x + Math.cos(angRad) * rangeM;
      let y = sonar.position.y + Math.sin(angRad) * rangeM;
      const jitterSigma = measSigma * IMAGING_MEAS_JITTER_SCALE;
      x += jitterRng.nextNormal(0, jitterSigma);
      y += jitterRng.nextNormal(0, jitterSigma);
      x = clamp(x, 0, POOL_WIDTH);
      y = clamp(y, 0, POOL_LENGTH);

      candidates.push({
        time: frameTimeSec,
        timeBucketMs,
        sonarId: sonar.id,
        x,
        y,
        measSigma,
        bbox: { aMin: c.aMin, aMax: c.aMax, rMin: c.rMin, rMax: c.rMax },
        centroidAR: { a: aIdx, r: rIdx },
        sumI: c.sumI,
      });
    }

    // Background model update (skip large positive deviations so moving targets don't leak into the model).
    const alpha = IMAGING_BACKGROUND_EMA_ALPHA;
    const slack = IMAGING_BACKGROUND_UPDATE_SLACK;
    for (let a = 0; a < angleBins; a++) {
      if (!buf.observedAngles[a]) continue;
      const base = a * rangeBins;
      for (let r = 0; r < rangeBins; r++) {
        const idx = base + r;
        const v = buf.intensity[idx];
        const b = buf.background[idx];
        if (v <= b + slack) buf.background[idx] = b * (1 - alpha) + v * alpha;
      }
    }

    // Frame done; start a new one.
    this.beginNewFrame(sonar);

    // Swimmers in sector for evaluation (at frame time)
    const swimmersInFov = this.swimmers.filter(swimmer => {
      const ang = angleToTarget(sonar.position, swimmer.position);
      const rel = normalizeAngle(ang - absMin);
      if (rel > sectorWidth) return false;
      const dist = distance(sonar.position, swimmer.position);
      return dist <= MAX_RANGE_NAIVE;
    });

    return { candidates, swimmersInFov };
  }

  private bboxIoU(
    a: { aMin: number; aMax: number; rMin: number; rMax: number },
    b: { aMin: number; aMax: number; rMin: number; rMax: number }
  ) {
    const aArea = Math.max(0, a.aMax - a.aMin + 1) * Math.max(0, a.rMax - a.rMin + 1);
    const bArea = Math.max(0, b.aMax - b.aMin + 1) * Math.max(0, b.rMax - b.rMin + 1);
    if (aArea === 0 || bArea === 0) return 0;

    const iaMin = Math.max(a.aMin, b.aMin);
    const iaMax = Math.min(a.aMax, b.aMax);
    const irMin = Math.max(a.rMin, b.rMin);
    const irMax = Math.min(a.rMax, b.rMax);
    const iArea = Math.max(0, iaMax - iaMin + 1) * Math.max(0, irMax - irMin + 1);
    if (iArea === 0) return 0;

    return iArea / (aArea + bArea - iArea);
  }

  private swimmerGtBbox(sonar: SonarState, swimmer: Swimmer) {
    const absMin = sonar.mountAngle - 45;
    const angleBins = IMAGING_FRAME_ANGLE_BINS;
    const rangeBins = IMAGING_RANGE_BINS;
    const angleStep = 90 / angleBins;
    const rangeStep = MAX_RANGE_NAIVE / rangeBins;

    const dist = distance(sonar.position, swimmer.position);
    const ang = angleToTarget(sonar.position, swimmer.position);
    const rel = normalizeAngle(ang - absMin);
    const aCenter = rel / Math.max(1e-6, angleStep);
    const rCenter = dist / Math.max(1e-6, rangeStep);

    const targetHalfDeg = radToDeg(Math.atan((SIM_SWIMMER_DIAMETER_M * 0.5) / Math.max(0.5, dist)));
    const halfDeg = Math.max(IMAGING_FOV_DEG * 0.5, targetHalfDeg);
    const halfABins = Math.max(1, Math.ceil(halfDeg / Math.max(1e-6, angleStep)));
    const halfRBins = Math.max(IMAGING_BLOB_RADIUS_BINS, Math.ceil((SIM_SWIMMER_DIAMETER_M * 0.5) / rangeStep));

    const aMin = clamp(Math.floor(aCenter - halfABins), 0, angleBins - 1);
    const aMax = clamp(Math.ceil(aCenter + halfABins), 0, angleBins - 1);
    const rMin = clamp(Math.floor(rCenter - halfRBins), 0, rangeBins - 1);
    const rMax = clamp(Math.ceil(rCenter + halfRBins), 0, rangeBins - 1);

    return { aMin, aMax, rMin, rMax };
  }

  private matchCandidatesToSwimmersByIoU(candidates: CandidatePoint[], swimmers: Swimmer[], sonar: SonarState) {
    if (candidates.length === 0 || swimmers.length === 0) return [];

    const gt = swimmers.map(swimmer => ({ swimmer, bbox: this.swimmerGtBbox(sonar, swimmer) }));

    type Pair = { ci: number; gi: number; iou: number; dist: number };
    const pairs: Pair[] = [];

    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci];
      for (let gi = 0; gi < gt.length; gi++) {
        const g = gt[gi];
        const iou = this.bboxIoU(c.bbox, g.bbox);
        if (iou < AQUASCAN_IOU_MATCH_THRESHOLD) continue;

        const dx = c.x - g.swimmer.position.x;
        const dy = c.y - g.swimmer.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > MATCH_GATE_RADIUS_M) continue;

        pairs.push({ ci, gi, iou, dist });
      }
    }

    pairs.sort((a, b) => b.iou - a.iou);

    const candUsed = new Uint8Array(candidates.length);
    const gtUsed = new Uint8Array(gt.length);
    const matches: { cand: CandidatePoint; swimmer: Swimmer; iou: number; dist: number }[] = [];

    for (const p of pairs) {
      if (candUsed[p.ci] || gtUsed[p.gi]) continue;
      candUsed[p.ci] = 1;
      gtUsed[p.gi] = 1;
      matches.push({ cand: candidates[p.ci], swimmer: gt[p.gi].swimmer, iou: p.iou, dist: p.dist });
    }

    return matches;
  }

  private matchCandidatesOneToOne(candidates: CandidatePoint[], swimmers: Swimmer[]) {
    if (candidates.length === 0 || swimmers.length === 0) return [];

    type Pair = { ci: number; si: number; dist: number };
    const pairs: Pair[] = [];

    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci];
      for (let si = 0; si < swimmers.length; si++) {
        const s = swimmers[si];
        const dx = c.x - s.position.x;
        const dy = c.y - s.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= MATCH_GATE_RADIUS_M) pairs.push({ ci, si, dist });
      }
    }

    pairs.sort((a, b) => a.dist - b.dist);

    const candUsed = new Uint8Array(candidates.length);
    const swimmerUsed = new Uint8Array(swimmers.length);
    const matches: { cand: CandidatePoint; swimmer: Swimmer; dist: number }[] = [];

    for (const p of pairs) {
      if (candUsed[p.ci] || swimmerUsed[p.si]) continue;
      candUsed[p.ci] = 1;
      swimmerUsed[p.si] = 1;
      matches.push({ cand: candidates[p.ci], swimmer: swimmers[p.si], dist: p.dist });
    }

    return matches;
  }

  update(dt: number) {
    this.time += dt;

    // 1. Move Swimmers
    this.swimmers.forEach(s => {
      const maneuver = this.maneuverBySwimmer.get(s.id);
      if (maneuver) {
        const turnRate = maneuver.amp * Math.sin(maneuver.omega * (this.time + maneuver.phase));
        const dTheta = turnRate * dt;
        const c = Math.cos(dTheta);
        const sn = Math.sin(dTheta);
        const vx = s.velocity.x;
        const vy = s.velocity.y;
        s.velocity.x = vx * c - vy * sn;
        s.velocity.y = vx * sn + vy * c;
      }

      s.position.x += s.velocity.x * dt;
      s.position.y += s.velocity.y * dt;

      // Bounce off walls
      if (s.position.x <= 0 || s.position.x >= POOL_WIDTH) s.velocity.x *= -1;
      if (s.position.y <= 0 || s.position.y >= POOL_LENGTH) s.velocity.y *= -1;

      // Clamp
      s.position.x = Math.max(0, Math.min(POOL_WIDTH, s.position.x));
      s.position.y = Math.max(0, Math.min(POOL_LENGTH, s.position.y));
    });

    // Predict tracks to "now" before planning (optimized strategy must not use truth).
    this.tracksBySwimmer.forEach(track => {
      predictCV2D(track, this.time, TRACK_SIGMA_ACCEL);
    });

    // Re-optimize sonar-target assignments periodically (optimized engine only)
    if (this.strategy === 'OPTIMIZED') {
      const trackedCount = this.tracksBySwimmer.size;
      if (
        this.time - this.lastOptimizationTime > PSO_UPDATE_INTERVAL ||
        trackedCount !== this.lastTargetCount
      ) {
        this.optimizedAssignments = this.runPSOAssignments();
        this.lastOptimizationTime = this.time;
        this.lastTargetCount = trackedCount;
      }
    }

    // 2. Update Sonars
    this.sonars.forEach(sonar => {
      // Plan behavior
      const plan = this.planNextSector(sonar);

      // Frame boundary: finish the accumulated polar image when a scan segment ends.
      // This supports optimized scan/slew patterns where the head may not reach hard limits.
      const shouldFinishFrame =
        sonar.mode === SonarMode.SCANNING &&
        (plan.mode !== SonarMode.SCANNING || plan.nextTarget !== sonar.targetAngle);
      if (shouldFinishFrame) {
        const timeBucketMs = quantizeTimeMs(this.time);
        const timeSec = timeBucketMs / 1000;

        sonar.cycleDuration = sonar.lastScanTime > 0 ? timeSec - sonar.lastScanTime : 0;
        sonar.lastScanTime = timeSec;

        const { candidates, swimmersInFov } = this.finishFrame(sonar, timeSec);

        const ft = this.frameTimesBySonar.get(sonar.id) ?? [];
        ft.push(timeSec);
        this.frameTimesBySonar.set(sonar.id, ft);

        if (candidates.length > 0) {
          candidates.forEach(c => sonar.detectedPoints.push({ x: c.x, y: c.y }));
          if (sonar.detectedPoints.length > 15) {
            sonar.detectedPoints.splice(0, sonar.detectedPoints.length - 15);
          }
        }

        // Paper-aligned: TP/FP/FN via IoU against GT bbox.
        const matchesIoU = this.matchCandidatesToSwimmersByIoU(candidates, swimmersInFov, sonar);
        const tpIoU = matchesIoU.length;
        const fpIoU = Math.max(0, candidates.length - tpIoU);
        const fnIoU = Math.max(0, swimmersInFov.length - tpIoU);
        let iouSum = 0;
        for (const m of matchesIoU) iouSum += m.iou;
        this.paperDetections.push({ time: timeSec, tp: tpIoU, fp: fpIoU, fn: fnIoU, iouSum });

        // Tracking + classic metrics: 1:1 distance gating (less strict than IoU).
        const matchesDist = this.matchCandidatesOneToOne(candidates, swimmersInFov);
        const tpDist = matchesDist.length;
        const fpDist = Math.max(0, candidates.length - tpDist);

        if (swimmersInFov.length > 0) {
          this.detectionStats.push({
            time: timeSec,
            opportunities: swimmersInFov.length,
            hits: tpDist,
          });
        }

        const falseCount = fpDist;
        if (falseCount > 0) this.falseAlarmCounts.push({ time: timeSec, count: falseCount });

        if (matchesDist.length > 0) {
          matchesDist.forEach(m => sonar.matchedPoints.push({ x: m.cand.x, y: m.cand.y }));
          if (sonar.matchedPoints.length > 15) {
            sonar.matchedPoints.splice(0, sonar.matchedPoints.length - 15);
          }
        }

        for (const m of matchesDist) {
          this.localizationErrors.push({ time: timeSec, err: m.dist });
          if (!this.firstDetectionTimeBySwimmer.has(m.swimmer.id)) {
            this.firstDetectionTimeBySwimmer.set(m.swimmer.id, timeSec);
          }

          const e: MatchEvent = {
            time: timeSec,
            timeBucketMs,
            swimmerId: m.swimmer.id,
            sonarId: m.cand.sonarId,
            measX: m.cand.x,
            measY: m.cand.y,
            measSigma: m.cand.measSigma,
            localizationErrorM: m.dist,
          };

          const accepted = this.recordMatchedEvent(e);
          if (accepted) this.updateTrackWithMatch(e);
        }
      }

      // State transition
      if (sonar.mode !== plan.mode) sonar.mode = plan.mode;
      sonar.targetAngle = plan.nextTarget;
      sonar.scanRange = plan.range;
      if (sonar.mode !== SonarMode.SCANNING) sonar.pingAccumulator = 0;

      // Calculate physics constraints (after scanRange update)
      const roundTripTime = (2 * sonar.scanRange) / SPEED_OF_SOUND;

      // Execute Movement
      if (sonar.mode === SonarMode.SCANNING) {
        // Limited by speed of sound + Ping360 per-ping processing overhead
        const pingInterval = Math.max(0.01, roundTripTime + PING360_PROCESSING_OVERHEAD_S);
        const effectiveSpeed = SCAN_STEP_ANGLE / pingInterval; // deg/s

        const startAngle = sonar.currentAngle;
        const diff = sonar.targetAngle - startAngle;
        const dir = Math.sign(diff);
        const maxMove = Math.abs(diff);
        const movePossible = effectiveSpeed * dt;
        const moveActual = Math.min(maxMove, movePossible);
        const endAngle = dir === 0 ? startAngle : startAngle + dir * moveActual;
        const tReach = movePossible > 0 ? (moveActual / movePossible) * dt : 0;

        // Ping-driven detection events
        sonar.pingAccumulator += dt;
        while (sonar.pingAccumulator >= pingInterval) {
          sonar.pingAccumulator -= pingInterval;
          const pingTime = this.time - sonar.pingAccumulator;
          const pingOffset = dt - sonar.pingAccumulator; // seconds since tick start

          let pingAngle = endAngle;
          if (dir === 0) {
            pingAngle = startAngle;
          } else if (pingOffset <= tReach) {
            pingAngle = startAngle + dir * effectiveSpeed * pingOffset;
          }

          const timeBucketMs = quantizeTimeMs(pingTime);
          this.writePingToFrame(sonar, pingAngle, pingTime, timeBucketMs);
        }

        // Apply rotation (smooth)
        sonar.currentAngle = endAngle;
      } else {
        // Slewing - purely mechanical speed (no ping emissions)
        const moveStep = SLEW_SPEED * dt;
        const diff = sonar.targetAngle - sonar.currentAngle;
        const dir = Math.sign(diff);
        if (Math.abs(diff) <= moveStep) sonar.currentAngle = sonar.targetAngle;
        else sonar.currentAngle += dir * moveStep;
      }

      const d = Math.sign(sonar.targetAngle - sonar.currentAngle);
      if (d === 1 || d === -1) this.lastDirBySonar.set(sonar.id, d);
    });

    // Predict all tracks to "now" so RMSE is computed at current time
    this.swimmers.forEach(swimmer => {
      const track = this.tracksBySwimmer.get(swimmer.id);
      if (track) predictCV2D(track, this.time, TRACK_SIGMA_ACCEL);
    });

    // Sliding-window pruning
    const cutoff = this.time - EVAL_RETENTION_SEC;
    this.matchedEvents = this.matchedEvents.filter(d => d.time >= cutoff);
    this.falseAlarmCounts = this.falseAlarmCounts.filter(d => d.time >= cutoff);
    this.detectionStats = this.detectionStats.filter(d => d.time >= cutoff);
    this.paperDetections = this.paperDetections.filter(d => d.time >= cutoff);
    this.localizationErrors = this.localizationErrors.filter(d => d.time >= cutoff);
    for (const arr of this.frameTimesBySonar.values()) {
      while (arr.length > 0 && arr[0] < cutoff) arr.shift();
    }
  }

  getEvalMetrics(windowSec = DEFAULT_EVAL_WINDOW_SEC): EngineEvalMetrics {
    const now = this.time;
    const swimmers = this.swimmers;
    if (swimmers.length === 0) {
      return {
        timestamp: now,
        activeSwimmers: 0,
        avgAoISec: 0,
        p90AoISec: 0,
        avgScanRateHz: 0,
        trackingRMSEm: 0,
        p90TrackingErrorM: 0,
        avgRevisitIntervalSec: 0,
        falseAlarmsPerSec: 0,
        detectionHitRate: 0,
        avgLocalizationErrorM: 0,
        p90LocalizationErrorM: 0,
        avgTimeToFirstDetectionSec: 0,
        p90TimeToFirstDetectionSec: 0,
        precision: 0,
        recall: 0,
        f1: 0,
        mdr: 0,
        meanIoU: 0,
        fps: 0,
        trackingRate: 0,
      };
    }

    const cutoff = now - windowSec;
    const aois: number[] = [];
    const scanRates: number[] = [];
    const revisitMeans: number[] = [];
    const errors: number[] = [];
    const sqErrors: number[] = [];
    const locErrors: number[] = [];
    const ttfValues: number[] = [];
    let trackedInWindow = 0;

    swimmers.forEach(swimmer => {
      const lastSeen = this.lastSeenTimeBySwimmer.get(swimmer.id) ?? swimmer.enteredAt;
      aois.push(Math.max(0, now - lastSeen));

      const times = this.updateTimesBySwimmer.get(swimmer.id) ?? [];
      while (times.length > 0 && times[0] < cutoff) times.shift();

      scanRates.push(windowSec > 0 ? times.length / windowSec : 0);
      if (times.length > 0) trackedInWindow += 1;

      if (times.length >= 2) {
        const meanInterval = (times[times.length - 1] - times[0]) / (times.length - 1);
        revisitMeans.push(meanInterval);
      }

      const track = this.tracksBySwimmer.get(swimmer.id);
      if (track) {
        const est = getPositionCV2D(track);
        const dx = est.x - swimmer.position.x;
        const dy = est.y - swimmer.position.y;
        const e = Math.sqrt(dx * dx + dy * dy);
        errors.push(e);
        sqErrors.push(e * e);
      }
    });

    // Detection stats (system-level, within window): opportunities vs matched hits
    let opportunities = 0;
    let hits = 0;
    for (const s of this.detectionStats) {
      if (s.time < cutoff) continue;
      opportunities += s.opportunities;
      hits += s.hits;
    }

    // False alarms (unmatched candidates per time bucket)
    let falseCount = 0;
    for (const f of this.falseAlarmCounts) {
      if (f.time < cutoff) continue;
      falseCount += f.count;
    }

    // Paper-aligned confusion stats (per-frame, IoU-matched)
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let iouSum = 0;
    for (const d of this.paperDetections) {
      if (d.time < cutoff) continue;
      tp += d.tp;
      fp += d.fp;
      fn += d.fn;
      iouSum += d.iouSum;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const mdr = tp + fn > 0 ? fn / (tp + fn) : 0;
    const meanIoU = tp > 0 ? iouSum / tp : 0;

    // FPS: average per-sonar frame rate within the window
    let framesInWindow = 0;
    for (const sonar of this.sonars) {
      const times = this.frameTimesBySonar.get(sonar.id) ?? [];
      while (times.length > 0 && times[0] < cutoff) times.shift();
      framesInWindow += times.length;
    }
    const fps = windowSec > 0 && this.sonars.length > 0 ? framesInWindow / windowSec / this.sonars.length : 0;
    const trackingRate = swimmers.length > 0 ? trackedInWindow / swimmers.length : 0;

    // Localization error for matched pairs
    for (const e of this.localizationErrors) {
      if (e.time < cutoff) continue;
      locErrors.push(e.err);
    }

    // Time-to-first-detection (TTFD) for swimmers that entered within the eval window.
    // Not-yet-detected swimmers are censored at "now".
    for (const swimmer of swimmers) {
      if (swimmer.enteredAt < cutoff) continue;
      const first = this.firstDetectionTimeBySwimmer.get(swimmer.id);
      const end = first !== undefined ? first : now;
      ttfValues.push(Math.max(0, end - swimmer.enteredAt));
    }

    const trackingRMSEm = sqErrors.length ? Math.sqrt(mean(sqErrors)) : 0;
    const p90TrackingErrorM = percentile(errors, 0.9);

    return {
      timestamp: now,
      activeSwimmers: swimmers.length,
      avgAoISec: mean(aois),
      p90AoISec: percentile(aois, 0.9),
      avgScanRateHz: mean(scanRates),
      trackingRMSEm,
      p90TrackingErrorM,
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
      meanIoU,
      fps,
      trackingRate,
    };
  }

  private recordMatchedEvent(e: MatchEvent) {
    this.matchedEvents.push(e);

    const updateBucket = e.timeBucketMs;
    const lastBucket = this.lastUpdateBucketBySwimmer.get(e.swimmerId);
    if (lastBucket === updateBucket) return false;

    this.lastUpdateBucketBySwimmer.set(e.swimmerId, updateBucket);
    const tSec = updateBucket / 1000;
    this.lastSeenTimeBySwimmer.set(e.swimmerId, tSec);

    const arr = this.updateTimesBySwimmer.get(e.swimmerId) ?? [];
    arr.push(tSec);

    const cutoff = this.time - EVAL_RETENTION_SEC;
    while (arr.length > 0 && arr[0] < cutoff) arr.shift();
    this.updateTimesBySwimmer.set(e.swimmerId, arr);
    return true;
  }

  private updateTrackWithMatch(e: MatchEvent) {
    let track = this.tracksBySwimmer.get(e.swimmerId);
    if (!track) {
      const posVar = Math.max(4, e.measSigma * e.measSigma * 9);
      track = createCV2D({
        x: e.measX,
        y: e.measY,
        vx: 0,
        vy: 0,
        t: e.time,
        posVar,
        velVar: 25,
      });
      this.tracksBySwimmer.set(e.swimmerId, track);
    }
    predictCV2D(track, e.time, TRACK_SIGMA_ACCEL);
    updateCV2D(track, { x: e.measX, y: e.measY }, e.measSigma);
  }
}
