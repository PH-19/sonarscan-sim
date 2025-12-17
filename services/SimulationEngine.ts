import { EngineEvalMetrics, SonarMode, SonarState, StrategyType, Swimmer, Vector2 } from '../types';
import { 
  POOL_WIDTH, POOL_LENGTH, SPEED_OF_SOUND, SLEW_SPEED, SCAN_STEP_ANGLE, 
  BEAM_WIDTH,
  MAX_RANGE_NAIVE, TARGET_PADDING_ANGLE, TARGET_PADDING_RANGE, SWIMMER_SPEED_MIN, SWIMMER_SPEED_MAX,
  PSO_SWARM_SIZE, PSO_ITERATIONS, PSO_INERTIA, PSO_COGNITIVE, PSO_SOCIAL, PSO_UPDATE_INTERVAL
} from '../constants';
import { distance, angleToTarget, isPointInSector, normalizeAngle } from '../utils/math';
import { createCV2D, getPositionCV2D, KalmanStateCV2D, predictCV2D, updateCV2D } from '../utils/kalman';
import { createLCGRng, hashStringToUint32, seededNormalFromKey } from '../utils/rng';

type DetectionEvent = {
  time: number;
  timeBucketMs: number;
  swimmerId: string;
  sonarId: string;
  measX: number;
  measY: number;
  measSigma: number;
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

export class SimulationEngine {
  sonars: SonarState[] = [];
  swimmers: Swimmer[] = [];
  strategy: StrategyType = 'NAIVE';
  time: number = 0;

  // Eval + tracking state (per-engine, from real detections)
  private evalSeed: number;
  private detections: DetectionEvent[] = [];
  private lastSeenTimeBySwimmer = new Map<string, number>(); // seconds
  private lastUpdateBucketBySwimmer = new Map<string, number>(); // ms bucket
  private updateTimesBySwimmer = new Map<string, number[]>(); // seconds (deduped by ms bucket)
  private tracksBySwimmer = new Map<string, KalmanStateCV2D>();
  private maneuverBySwimmer = new Map<string, { omega: number; phase: number; amp: number }>();

  // PSO optimized assignment of swimmers to sonars
  optimizedAssignments: Record<string, string[]> = {};
  private lastOptimizationTime = 0;
  private lastSwimmerCount = 0;

  constructor(opts?: { strategy?: StrategyType; evalSeed?: number }) {
    this.strategy = opts?.strategy ?? 'NAIVE';
    this.evalSeed = opts?.evalSeed ?? 1337;
    this.reset();
  }

  reset() {
    this.time = 0;
    this.swimmers = [];
    this.detections = [];
    this.lastSeenTimeBySwimmer.clear();
    this.lastUpdateBucketBySwimmer.clear();
    this.updateTimesBySwimmer.clear();
    this.tracksBySwimmer.clear();
    this.maneuverBySwimmer.clear();
    
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
        detectedPoints: []
      };
    };

    // Initialize 4 Sonars at corners, each covering an inward 90° sector
    this.sonars = [
      makeSonar('S1', { x: 0, y: 0 }, 45),
      makeSonar('S2', { x: POOL_WIDTH, y: 0 }, 135),
      makeSonar('S3', { x: POOL_WIDTH, y: POOL_LENGTH }, 225),
      makeSonar('S4', { x: 0, y: POOL_LENGTH }, 315),
    ];

    this.optimizedAssignments = {};
    this.lastOptimizationTime = 0;
    this.lastSwimmerCount = 0;
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

    // Track init: start near truth with uncertainty; updates + maneuvers make revisit frequency matter
    this.tracksBySwimmer.set(
      swimmer.id,
      createCV2D({
        x: swimmer.position.x,
        y: swimmer.position.y,
        vx: swimmer.velocity.x,
        vy: swimmer.velocity.y,
        t: swimmer.enteredAt,
        posVar: 16,
        velVar: 9,
      })
    );

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
  }

  private estimateScanningSpeedDegPerSec(range: number) {
    const roundTripTime = (2 * range) / SPEED_OF_SOUND;
    return SCAN_STEP_ANGLE / Math.max(0.01, roundTripTime);
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

    const nTargets = this.swimmers.length;
    const mSonars = this.sonars.length;
    if (nTargets === 0 || mSonars === 0) return result;

    const eligibleSonars: number[][] = this.swimmers.map(swimmer => {
      const eligible: number[] = [];
      this.sonars.forEach((sonar, idx) => {
        const ang = angleToTarget(sonar.position, swimmer.position);
        const sweepStart = sonar.mountAngle - 45;
        const rel = normalizeAngle(ang - sweepStart);
        if (rel <= 90) eligible.push(idx);
      });

      if (eligible.length === 0) {
        let bestIdx = 0;
        let bestDist = Infinity;
        this.sonars.forEach((sonar, idx) => {
          const d = distance(sonar.position, swimmer.position);
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

    const randomEligible = (t: number) => {
      const opts = eligibleSonars[t];
      return opts[Math.floor(Math.random() * opts.length)];
    };

    const evaluate = (pos: number[]) => {
      const perSonarTargets: { ang: number; dist: number }[][] =
        Array.from({ length: mSonars }, () => []);
      let invalid = 0;

      for (let j = 0; j < nTargets; j++) {
        let idx = Math.round(pos[j]);
        idx = Math.max(0, Math.min(mSonars - 1, idx));

        const swimmer = this.swimmers[j];
        const sonar = this.sonars[idx];
        const ang = angleToTarget(sonar.position, swimmer.position);
        const dist = distance(sonar.position, swimmer.position);
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
      const vel = Array.from({ length: nTargets }, () => (Math.random() - 0.5));
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
          const r1 = Math.random();
          const r2 = Math.random();
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
      result[sonarId].push(this.swimmers[j].id);
    }

    return result;
  }

  // Determine the next target angle and range based on strategy
  private planNextSector(sonar: SonarState): { nextTarget: number, mode: SonarMode, range: number } {
    const absMin = sonar.mountAngle - 45; // Scanning 90 deg sectors for this demo
    const absMax = sonar.mountAngle + 45;

    // --- NAIVE STRATEGY ---
    // Always sweep min -> max -> min
    if (this.strategy === 'NAIVE') {
      const isAscending = sonar.targetAngle > sonar.currentAngle;
      
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

    // --- OPTIMIZED (PSO-inspired / Adaptive Sectoring) ---
    // 1. Identify "Regions of Interest" based on known swimmer positions (simulating a global tracker)
    // 2. Scan specific sectors, SLEW over empty space
    // 3. Adjust Range to closest target in sector
    
    // Use PSO assignment if available, otherwise fall back to local FOV targets
    const assignedIds = this.optimizedAssignments[sonar.id] || [];
    const assignedSet = assignedIds.length > 0 ? new Set(assignedIds) : null;
    let relevantSwimmers = assignedSet
      ? this.swimmers.filter(s => assignedSet.has(s.id))
      : this.swimmers;

    const sweepStart = sonar.mountAngle - 45;
    let activeTargets = relevantSwimmers.map(s => {
      const ang = angleToTarget(sonar.position, s.position);
      const dist = distance(sonar.position, s.position);
      return { ang, dist, id: s.id };
    }).filter(t => {
      return normalizeAngle(t.ang - sweepStart) <= 90;
    });

    // If PSO assigned nothing usable (e.g. transient), fall back to all local targets
    if (activeTargets.length === 0 && assignedSet) {
      activeTargets = this.swimmers.map(s => {
        const ang = angleToTarget(sonar.position, s.position);
        const dist = distance(sonar.position, s.position);
        return { ang, dist, id: s.id };
      }).filter(t => {
        return normalizeAngle(t.ang - sweepStart) <= 90;
      });
    }

    // If no targets, fallback to a wide "surveillance" scan but faster (maybe reduced range or wider step - simulated here by standard scan)
    if (activeTargets.length === 0) {
      // Similar logic to Naive but we can optimize range if we assume empty pool needs full check
      const isAscending = sonar.targetAngle > sonar.currentAngle;
      if (Math.abs(sonar.currentAngle - sonar.targetAngle) < 1) {
        return {
          nextTarget: isAscending ? absMin : absMax,
          mode: SonarMode.SLEWING, // Fast return? No, need to scan to find new targets. 
          // Actually, in optimized, if we scanned and found nothing, we might SLEW back to start quickly
          range: MAX_RANGE_NAIVE
        };
      }
      return { nextTarget: sonar.targetAngle, mode: SonarMode.SCANNING, range: MAX_RANGE_NAIVE };
    }

    // We have targets. Determine if current angle is "useful" or "empty"
    // Find closest target angle in the direction of travel
    const isAscending = sonar.targetAngle > sonar.currentAngle; // Direction preference
    
    // Check if we are currently "on" a target
    const targetInBeam = activeTargets.find(t => {
      let diff = Math.abs(t.ang - sonar.currentAngle);
      return diff < TARGET_PADDING_ANGLE;
    });

    if (targetInBeam) {
      // We are scanning a target. Optimize Range!
      // Add buffer to range
      const optimalRange = Math.min(targetInBeam.dist + TARGET_PADDING_RANGE, MAX_RANGE_NAIVE);
      
      // Continue scanning in current direction
      return {
        nextTarget: isAscending ? absMax : absMin, // Keep heading towards end
        mode: SonarMode.SCANNING,
        range: optimalRange
      };
    } else {
      // We are in empty space. Should we SCAN or SLEW?
      // Look ahead. Is there a target soon?
      // Find next target angle in our current rotation direction
      let nextTargetAngle: number | null = null;
      let minDistanceToTargetAngle = 999;

      activeTargets.forEach(t => {
         let diff = t.ang - sonar.currentAngle;
         // Adjust for wrapping
         if (diff < -180) diff += 360;
         if (diff > 180) diff -= 360;

         // If direction matches
         if ((isAscending && diff > 0) || (!isAscending && diff < 0)) {
            if (Math.abs(diff) < minDistanceToTargetAngle) {
              minDistanceToTargetAngle = Math.abs(diff);
              nextTargetAngle = t.ang;
            }
         }
      });

      if (nextTargetAngle !== null) {
        // There is a target ahead.
        // If it's far away (> 10 deg), SLEW to it.
        // If it's close, just SCAN to it.
        if (minDistanceToTargetAngle > 10) {
           // SLEW to just before the target
           const buffer = isAscending ? -TARGET_PADDING_ANGLE : TARGET_PADDING_ANGLE;
           return {
             nextTarget: nextTargetAngle + buffer,
             mode: SonarMode.SLEWING,
             range: 1 // Range irrelevant during slew
           };
        } else {
           return {
             nextTarget: isAscending ? absMax : absMin,
             mode: SonarMode.SCANNING,
             range: MAX_RANGE_NAIVE // Scan empty space at max range just in case
           };
        }
      } else {
        // No more targets in this direction. Turn around!
        return {
          nextTarget: isAscending ? absMin : absMax,
          mode: SonarMode.SLEWING, // Fast return to start of cluster
          range: 1
        };
      }
    }
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

    // Re-optimize sonar-target assignments periodically (optimized engine only)
    if (this.strategy === 'OPTIMIZED') {
      if (
        this.time - this.lastOptimizationTime > PSO_UPDATE_INTERVAL ||
        this.swimmers.length !== this.lastSwimmerCount
      ) {
        this.optimizedAssignments = this.runPSOAssignments();
        this.lastOptimizationTime = this.time;
        this.lastSwimmerCount = this.swimmers.length;
      }
    }

    // 2. Update Sonars
    const detectionsThisTick: DetectionEvent[] = [];
    this.sonars.forEach(sonar => {
      // Plan behavior
      const plan = this.planNextSector(sonar);
      
      // State transition
      if (sonar.mode !== plan.mode) sonar.mode = plan.mode;
      sonar.targetAngle = plan.nextTarget;
      sonar.scanRange = plan.range;
      if (sonar.mode !== SonarMode.SCANNING) sonar.pingAccumulator = 0;

      // Calculate physics constraints (after scanRange update)
      const roundTripTime = (2 * sonar.scanRange) / SPEED_OF_SOUND;

      // Execute Movement
      if (sonar.mode === SonarMode.SCANNING) {
        // Limited by speed of sound (ping interval) AND mechanical step
        const pingInterval = Math.max(0.01, roundTripTime);
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
          const detected = this.swimmers.filter(s =>
            isPointInSector(s.position, sonar.position, pingAngle, BEAM_WIDTH, sonar.scanRange)
          );

          detected.forEach(swimmer => {
            const dist = distance(sonar.position, swimmer.position);
            const measSigma = MEAS_SIGMA_BASE + MEAS_SIGMA_PER_M * dist;
            const keyBase = `${this.evalSeed}|${swimmer.id}|${sonar.id}|${timeBucketMs}`;
            const measX = swimmer.position.x + seededNormalFromKey(`${keyBase}|x`, 0, measSigma);
            const measY = swimmer.position.y + seededNormalFromKey(`${keyBase}|y`, 0, measSigma);

            detectionsThisTick.push({
              time: pingTime,
              timeBucketMs,
              swimmerId: swimmer.id,
              sonarId: sonar.id,
              measX,
              measY,
              measSigma,
            });

            // Visual echo points (bounded buffer)
            sonar.detectedPoints.push({ x: measX, y: measY });
            if (sonar.detectedPoints.length > 40) sonar.detectedPoints.splice(0, sonar.detectedPoints.length - 40);
          });
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
      
      // Cycle detection (Direction flip indicates a cycle edge roughly)
      // Simulating "Frame Rate": How often do we cover the area?
      // We'll track when it hits min or max limits relative to mount
      const absMin = sonar.mountAngle - 45;
      const absMax = sonar.mountAngle + 45;
      const isAtLimit =
        Math.abs(sonar.currentAngle - absMin) < 1.5 ||
        Math.abs(sonar.currentAngle - absMax) < 1.5;
      
      // Calculate Cycle Duration metrics
      if (isAtLimit && this.time - sonar.lastScanTime > 1.0) {
         sonar.cycleDuration = this.time - sonar.lastScanTime;
         sonar.lastScanTime = this.time;
      }
    });

    if (detectionsThisTick.length > 0) {
      detectionsThisTick.sort((a, b) => a.time - b.time);
      detectionsThisTick.forEach(e => this.recordDetection(e));
      detectionsThisTick.forEach(e => this.updateTrackWithDetection(e));
    }

    // Predict all tracks to "now" so RMSE is computed at current time
    this.swimmers.forEach(swimmer => {
      const track = this.tracksBySwimmer.get(swimmer.id);
      if (track) predictCV2D(track, this.time, TRACK_SIGMA_ACCEL);
    });

    // Sliding-window pruning
    const cutoff = this.time - EVAL_RETENTION_SEC;
    this.detections = this.detections.filter(d => d.time >= cutoff);
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
      };
    }

    const cutoff = now - windowSec;
    const aois: number[] = [];
    const scanRates: number[] = [];
    const revisitMeans: number[] = [];
    const errors: number[] = [];
    const sqErrors: number[] = [];

    swimmers.forEach(swimmer => {
      const lastSeen = this.lastSeenTimeBySwimmer.get(swimmer.id) ?? swimmer.enteredAt;
      aois.push(Math.max(0, now - lastSeen));

      const times = this.updateTimesBySwimmer.get(swimmer.id) ?? [];
      while (times.length > 0 && times[0] < cutoff) times.shift();

      scanRates.push(windowSec > 0 ? times.length / windowSec : 0);

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
    };
  }

  private recordDetection(e: DetectionEvent) {
    this.detections.push(e);

    const updateBucket = e.timeBucketMs;
    const lastBucket = this.lastUpdateBucketBySwimmer.get(e.swimmerId);
    if (lastBucket !== updateBucket) {
      this.lastUpdateBucketBySwimmer.set(e.swimmerId, updateBucket);
      const tSec = updateBucket / 1000;
      this.lastSeenTimeBySwimmer.set(e.swimmerId, tSec);
      const arr = this.updateTimesBySwimmer.get(e.swimmerId) ?? [];
      arr.push(tSec);

      const cutoff = this.time - EVAL_RETENTION_SEC;
      while (arr.length > 0 && arr[0] < cutoff) arr.shift();
      this.updateTimesBySwimmer.set(e.swimmerId, arr);
    }
  }

  private updateTrackWithDetection(e: DetectionEvent) {
    const track = this.tracksBySwimmer.get(e.swimmerId);
    if (!track) return;
    predictCV2D(track, e.time, TRACK_SIGMA_ACCEL);
    updateCV2D(track, { x: e.measX, y: e.measY }, e.measSigma);
  }
}
