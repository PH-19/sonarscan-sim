import { Swimmer, SwimmerTruth, Vector2 } from '../../../types';
import { POOL_LENGTH, POOL_WIDTH, SWIMMER_SPEED_MAX, SWIMMER_SPEED_MIN } from '../../../constants';
import { createLCGRng, hashStringToUint32, SeededRng } from '../../../utils/rng';

const DEG_TO_RAD = Math.PI / 180;
const FREE_REFLECT_INITIAL_CRUISE_MIN_SEC = 35;
const FREE_REFLECT_INITIAL_CRUISE_MAX_SEC = 70;
const FREE_REFLECT_CRUISE_MIN_SEC = 18;
const FREE_REFLECT_CRUISE_MAX_SEC = 45;
const FREE_REFLECT_TURN_RATE_MIN_RAD_PER_SEC = 0.35;
const FREE_REFLECT_TURN_RATE_MAX_RAD_PER_SEC = 0.75;
const FREE_REFLECT_EDGE_TURN_RATE_MIN_RAD_PER_SEC = 0.65;
const FREE_REFLECT_EDGE_TURN_RATE_MAX_RAD_PER_SEC = 1.05;
const FREE_REFLECT_WANDER_RATE_MIN_RAD_PER_SEC = 0.0003;
const FREE_REFLECT_WANDER_RATE_MAX_RAD_PER_SEC = 0.0014;
const FREE_REFLECT_EDGE_MARGIN_M = 1.4;

type FreeReflectManeuver = {
  rng: SeededRng;
  targetHeadingRad: number;
  nextEventAt: number;
  turnRateRadPerSec: number;
  wanderOmega: number;
  wanderPhase: number;
  wanderAmpRadPerSec: number;
  edgeAvoidUntil: number;
};

const normalize = (v: Vector2) => {
  const mag = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
  return { x: v.x / mag, y: v.y / mag };
};

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

const normalizeAngleRad = (angle: number) => {
  let result = angle % (Math.PI * 2);
  if (result <= -Math.PI) result += Math.PI * 2;
  if (result > Math.PI) result -= Math.PI * 2;
  return result;
};

const shortestAngleDelta = (from: number, to: number) => normalizeAngleRad(to - from);

const headingOf = (velocity: Vector2) => Math.atan2(velocity.y, velocity.x);

export class WorldState {
  swimmers: SwimmerTruth[] = [];
  private maneuverByTruthId = new Map<string, FreeReflectManeuver>();
  private history: { time: number; swimmers: SwimmerTruth[] }[] = [];

  constructor(private readonly seed: number) {}

  reset() {
    this.swimmers = [];
    this.maneuverByTruthId.clear();
    this.history = [{ time: 0, swimmers: [] }];
  }

  addSwimmer(swimmer: Swimmer, now: number) {
    const truth: SwimmerTruth = {
      ...this.cloneSwimmer(swimmer),
      truthId: swimmer.id,
      enteredAt: swimmer.enteredAt ?? now,
    };
    this.swimmers.push(truth);
    if ((truth.motion?.kind ?? 'free_reflect') === 'free_reflect') this.initManeuver(truth, now);
    this.recordHistory(now);
    return truth;
  }

  addRandomSwimmer(now: number) {
    const rng = createLCGRng(hashStringToUint32(`${this.seed}|randomSwimmer|${this.swimmers.length}|${Math.floor(now * 10)}`));
    const side = rng.nextInt(4);
    const speed = rng.nextRange(SWIMMER_SPEED_MIN, SWIMMER_SPEED_MAX);
    let position: Vector2 = { x: 0, y: 0 };
    let direction: Vector2 = { x: 0, y: 0 };

    switch (side) {
      case 0:
        position = { x: rng.nextRange(0, POOL_WIDTH), y: 0 };
        direction = { x: rng.nextRange(-0.5, 0.5), y: 1 };
        break;
      case 1:
        position = { x: rng.nextRange(0, POOL_WIDTH), y: POOL_LENGTH };
        direction = { x: rng.nextRange(-0.5, 0.5), y: -1 };
        break;
      case 2:
        position = { x: 0, y: rng.nextRange(0, POOL_LENGTH) };
        direction = { x: 1, y: rng.nextRange(-0.5, 0.5) };
        break;
      default:
        position = { x: POOL_WIDTH, y: rng.nextRange(0, POOL_LENGTH) };
        direction = { x: -1, y: rng.nextRange(-0.5, 0.5) };
        break;
    }

    const dir = normalize(direction);
    return this.addSwimmer({
      id: `sw_${hashStringToUint32(`${this.seed}|${rng.next()}`)}`,
      position,
      velocity: { x: dir.x * speed, y: dir.y * speed },
      enteredAt: now,
    }, now);
  }

  removeLast() {
    const removed = this.swimmers.pop();
    if (removed) this.maneuverByTruthId.delete(removed.truthId);
    if (removed) this.recordHistory(this.history.at(-1)?.time ?? 0);
    return removed;
  }

  removeById(id: string) {
    const idx = this.swimmers.findIndex(s => s.truthId === id || s.id === id);
    if (idx < 0) return null;
    const [removed] = this.swimmers.splice(idx, 1);
    this.maneuverByTruthId.delete(removed.truthId);
    this.recordHistory(this.history.at(-1)?.time ?? 0);
    return removed;
  }

  step(dt: number, now: number) {
    for (const swimmer of this.swimmers) {
      if (swimmer.motion?.kind === 'short_end_rest') {
        this.stepRestingSwimmer(swimmer);
        continue;
      }
      if (swimmer.motion?.kind === 'lane_swim') {
        this.stepLaneSwimmer(swimmer, dt, now);
        continue;
      }

      const maneuver = this.maneuverByTruthId.get(swimmer.truthId) ?? this.initManeuver(swimmer, now);
      this.stepFreeReflectSwimmer(swimmer, maneuver, dt, now);

      swimmer.position.x += swimmer.velocity.x * dt;
      swimmer.position.y += swimmer.velocity.y * dt;

      this.reflectFreeSwimmerAtBounds(swimmer, maneuver, now);

      swimmer.position.x = Math.max(0, Math.min(POOL_WIDTH, swimmer.position.x));
      swimmer.position.y = Math.max(0, Math.min(POOL_LENGTH, swimmer.position.y));
    }
    this.recordHistory(now);
  }

  sampleAt(time: number) {
    if (this.history.length === 0) return this.swimmers.map(swimmer => this.cloneTruth(swimmer));
    let hi = this.history.findIndex(item => item.time >= time);
    if (hi < 0) return this.history[this.history.length - 1].swimmers.map(swimmer => this.cloneTruth(swimmer));
    if (hi === 0) return this.history[0].swimmers.map(swimmer => this.cloneTruth(swimmer));
    const before = this.history[hi - 1];
    const after = this.history[hi];
    const span = Math.max(1e-9, after.time - before.time);
    const alpha = Math.max(0, Math.min(1, (time - before.time) / span));
    const afterById = new Map(after.swimmers.map(swimmer => [swimmer.truthId, swimmer]));
    const result: SwimmerTruth[] = [];
    for (const swimmer of before.swimmers) {
      const next = afterById.get(swimmer.truthId);
      if (!next) continue;
      result.push({
        ...this.cloneTruth(swimmer),
        position: {
          x: swimmer.position.x + (next.position.x - swimmer.position.x) * alpha,
          y: swimmer.position.y + (next.position.y - swimmer.position.y) * alpha,
        },
        velocity: {
          x: swimmer.velocity.x + (next.velocity.x - swimmer.velocity.x) * alpha,
          y: swimmer.velocity.y + (next.velocity.y - swimmer.velocity.y) * alpha,
        },
      });
    }
    return result;
  }

  private cloneSwimmer(swimmer: Swimmer): Swimmer {
    return {
      id: swimmer.id,
      enteredAt: swimmer.enteredAt,
      position: { x: swimmer.position.x, y: swimmer.position.y },
      velocity: { x: swimmer.velocity.x, y: swimmer.velocity.y },
      motion: swimmer.motion ? { ...swimmer.motion } : undefined,
    };
  }

  private cloneTruth(swimmer: SwimmerTruth): SwimmerTruth {
    return {
      ...this.cloneSwimmer(swimmer),
      truthId: swimmer.truthId,
    };
  }

  private recordHistory(time: number) {
    const snapshot = { time, swimmers: this.swimmers.map(swimmer => this.cloneTruth(swimmer)) };
    const last = this.history[this.history.length - 1];
    if (last && Math.abs(last.time - time) < 1e-9) this.history[this.history.length - 1] = snapshot;
    else this.history.push(snapshot);
    const cutoff = time - 120;
    while (this.history.length > 2 && this.history[1].time < cutoff) this.history.shift();
  }

  private initManeuver(swimmer: SwimmerTruth, now: number) {
    const rng = createLCGRng(hashStringToUint32(`${this.seed}|maneuver|${swimmer.truthId}|${swimmer.enteredAt}`));
    const heading = headingOf(swimmer.velocity);
    const maneuver: FreeReflectManeuver = {
      rng,
      targetHeadingRad: heading,
      nextEventAt: now + rng.nextRange(FREE_REFLECT_INITIAL_CRUISE_MIN_SEC, FREE_REFLECT_INITIAL_CRUISE_MAX_SEC),
      turnRateRadPerSec: rng.nextRange(
        FREE_REFLECT_TURN_RATE_MIN_RAD_PER_SEC,
        FREE_REFLECT_TURN_RATE_MAX_RAD_PER_SEC
      ),
      wanderOmega: rng.nextRange(0.05, 0.14),
      wanderPhase: rng.nextRange(0, Math.PI * 2),
      wanderAmpRadPerSec: rng.nextRange(
        FREE_REFLECT_WANDER_RATE_MIN_RAD_PER_SEC,
        FREE_REFLECT_WANDER_RATE_MAX_RAD_PER_SEC
      ),
      edgeAvoidUntil: 0,
    };
    this.maneuverByTruthId.set(swimmer.truthId, maneuver);
    return maneuver;
  }

  private stepFreeReflectSwimmer(
    swimmer: SwimmerTruth,
    maneuver: FreeReflectManeuver,
    dt: number,
    now: number
  ) {
    const speed = Math.hypot(swimmer.velocity.x, swimmer.velocity.y);
    if (speed <= 1e-9) return;

    let heading = headingOf(swimmer.velocity);
    this.maybeScheduleEdgeAvoidance(swimmer, maneuver, heading, now);
    if (now >= maneuver.nextEventAt && Math.abs(shortestAngleDelta(heading, maneuver.targetHeadingRad)) < 2 * DEG_TO_RAD) {
      this.scheduleIntentionalCourseEvent(maneuver, heading, now);
    }

    const wander = maneuver.wanderAmpRadPerSec * Math.sin(maneuver.wanderOmega * now + maneuver.wanderPhase);
    const desiredHeading = normalizeAngleRad(maneuver.targetHeadingRad + wander);
    const delta = shortestAngleDelta(heading, desiredHeading);
    const maxStep = maneuver.turnRateRadPerSec * dt;
    heading = normalizeAngleRad(heading + clamp(delta, -maxStep, maxStep));
    swimmer.velocity.x = Math.cos(heading) * speed;
    swimmer.velocity.y = Math.sin(heading) * speed;
  }

  private scheduleIntentionalCourseEvent(
    maneuver: FreeReflectManeuver,
    currentHeading: number,
    now: number
  ) {
    const rng = maneuver.rng;
    const roll = rng.next();
    let turnMagnitude = 0;

    if (roll < 0.48) {
      turnMagnitude = rng.nextRange(0, 6) * DEG_TO_RAD;
    } else if (roll < 0.82) {
      turnMagnitude = rng.nextRange(10, 28) * DEG_TO_RAD;
    } else if (roll < 0.96) {
      turnMagnitude = rng.nextRange(35, 70) * DEG_TO_RAD;
    } else {
      turnMagnitude = rng.nextRange(145, 180) * DEG_TO_RAD;
    }

    const sign = rng.next() < 0.5 ? -1 : 1;
    maneuver.targetHeadingRad = normalizeAngleRad(currentHeading + sign * turnMagnitude);
    maneuver.turnRateRadPerSec = rng.nextRange(
      FREE_REFLECT_TURN_RATE_MIN_RAD_PER_SEC,
      FREE_REFLECT_TURN_RATE_MAX_RAD_PER_SEC
    );
    const turnDuration = turnMagnitude / Math.max(1e-6, maneuver.turnRateRadPerSec);
    maneuver.nextEventAt = now + turnDuration + rng.nextRange(FREE_REFLECT_CRUISE_MIN_SEC, FREE_REFLECT_CRUISE_MAX_SEC);
  }

  private maybeScheduleEdgeAvoidance(
    swimmer: SwimmerTruth,
    maneuver: FreeReflectManeuver,
    heading: number,
    now: number
  ) {
    if (now < maneuver.edgeAvoidUntil) return;

    const vx = Math.cos(heading);
    const vy = Math.sin(heading);
    let inwardHeading: number | null = null;
    const jitter = () => maneuver.rng.nextRange(-28, 28) * DEG_TO_RAD;

    if (swimmer.position.x <= FREE_REFLECT_EDGE_MARGIN_M && vx < -0.15) {
      inwardHeading = 0 + jitter();
    } else if (swimmer.position.x >= POOL_WIDTH - FREE_REFLECT_EDGE_MARGIN_M && vx > 0.15) {
      inwardHeading = Math.PI + jitter();
    } else if (swimmer.position.y <= FREE_REFLECT_EDGE_MARGIN_M && vy < -0.15) {
      inwardHeading = Math.PI / 2 + jitter();
    } else if (swimmer.position.y >= POOL_LENGTH - FREE_REFLECT_EDGE_MARGIN_M && vy > 0.15) {
      inwardHeading = -Math.PI / 2 + jitter();
    }

    if (inwardHeading === null) return;
    maneuver.targetHeadingRad = normalizeAngleRad(inwardHeading);
    maneuver.turnRateRadPerSec = maneuver.rng.nextRange(
      FREE_REFLECT_EDGE_TURN_RATE_MIN_RAD_PER_SEC,
      FREE_REFLECT_EDGE_TURN_RATE_MAX_RAD_PER_SEC
    );
    maneuver.edgeAvoidUntil = now + 4;
    maneuver.nextEventAt = Math.max(
      maneuver.nextEventAt,
      now + maneuver.rng.nextRange(FREE_REFLECT_CRUISE_MIN_SEC, FREE_REFLECT_CRUISE_MAX_SEC)
    );
  }

  private reflectFreeSwimmerAtBounds(
    swimmer: SwimmerTruth,
    maneuver: FreeReflectManeuver,
    now: number
  ) {
    let reflected = false;
    if (swimmer.position.x <= 0 && swimmer.velocity.x < 0) {
      swimmer.velocity.x = Math.abs(swimmer.velocity.x);
      reflected = true;
    } else if (swimmer.position.x >= POOL_WIDTH && swimmer.velocity.x > 0) {
      swimmer.velocity.x = -Math.abs(swimmer.velocity.x);
      reflected = true;
    }
    if (swimmer.position.y <= 0 && swimmer.velocity.y < 0) {
      swimmer.velocity.y = Math.abs(swimmer.velocity.y);
      reflected = true;
    } else if (swimmer.position.y >= POOL_LENGTH && swimmer.velocity.y > 0) {
      swimmer.velocity.y = -Math.abs(swimmer.velocity.y);
      reflected = true;
    }

    if (!reflected) return;
    maneuver.targetHeadingRad = headingOf(swimmer.velocity);
    maneuver.turnRateRadPerSec = maneuver.rng.nextRange(
      FREE_REFLECT_EDGE_TURN_RATE_MIN_RAD_PER_SEC,
      FREE_REFLECT_EDGE_TURN_RATE_MAX_RAD_PER_SEC
    );
    maneuver.edgeAvoidUntil = now + 4;
    maneuver.nextEventAt = Math.max(
      maneuver.nextEventAt,
      now + maneuver.rng.nextRange(FREE_REFLECT_CRUISE_MIN_SEC, FREE_REFLECT_CRUISE_MAX_SEC)
    );
  }

  private stepRestingSwimmer(swimmer: SwimmerTruth) {
    const restY = swimmer.motion?.restY ?? swimmer.position.y;
    const laneX = swimmer.motion?.laneX ?? swimmer.position.x;
    swimmer.position.x = clamp(laneX, 0, POOL_WIDTH);
    swimmer.position.y = clamp(restY, 0, POOL_LENGTH);
    swimmer.velocity.x = 0;
    swimmer.velocity.y = 0;
  }

  private stepLaneSwimmer(swimmer: SwimmerTruth, dt: number, now: number) {
    const motion = swimmer.motion;
    if (!motion) return;

    const speed = clamp(
      motion.speedMps ?? Math.hypot(swimmer.velocity.x, swimmer.velocity.y),
      SWIMMER_SPEED_MIN,
      SWIMMER_SPEED_MAX
    );
    let direction: 1 | -1 = motion.longDirection ?? (swimmer.velocity.y >= 0 ? 1 : -1);
    const laneX = clamp(motion.laneX ?? swimmer.position.x, 0.5, POOL_WIDTH - 0.5);
    const amplitude = clamp(motion.lateralAmplitudeM ?? 0.12, 0, 0.4);
    const period = Math.max(8, motion.lateralPeriodSec ?? 24);
    const phase = motion.phaseSec ?? 0;
    const targetX = clamp(
      laneX + amplitude * Math.sin((2 * Math.PI * (now + phase)) / period),
      0.5,
      POOL_WIDTH - 0.5
    );
    const maxLateralSpeed = Math.min(0.16, speed * 0.12);
    const vx = clamp((targetX - swimmer.position.x) * 0.8, -maxLateralSpeed, maxLateralSpeed);
    const vy = direction * Math.sqrt(Math.max(0, speed * speed - vx * vx));

    swimmer.velocity.x = vx;
    swimmer.velocity.y = vy;
    swimmer.position.x += swimmer.velocity.x * dt;
    swimmer.position.y += swimmer.velocity.y * dt;

    if (swimmer.position.y <= 0) {
      swimmer.position.y = 0;
      direction = 1;
    } else if (swimmer.position.y >= POOL_LENGTH) {
      swimmer.position.y = POOL_LENGTH;
      direction = -1;
    }
    if (swimmer.position.x <= 0 || swimmer.position.x >= POOL_WIDTH) {
      swimmer.position.x = clamp(swimmer.position.x, 0, POOL_WIDTH);
    }

    swimmer.motion = {
      ...motion,
      laneX,
      speedMps: speed,
      longDirection: direction,
    };
    swimmer.velocity.y = Math.sign(direction) * Math.abs(swimmer.velocity.y || speed);
  }
}
