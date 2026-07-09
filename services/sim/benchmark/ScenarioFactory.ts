import { Swimmer, SwimmerMotionProfile } from '../../../types';
import { POOL_LANE_COUNT, POOL_LENGTH, POOL_WIDTH, SWIMMER_SPEED_MAX, SWIMMER_SPEED_MIN } from '../../../constants';
import { createLCGRng, hashStringToUint32, SeededRng } from '../../../utils/rng';
import { BenchmarkScenarioName, PopulationMovementModel, SonarFailureMode } from './BenchmarkConfig';

const DEG_TO_RAD = Math.PI / 180;

export type ScenarioEvent =
  | { timeSec: number; type: 'add'; swimmer: Swimmer }
  | { timeSec: number; type: 'remove'; swimmerId: string }
  | { timeSec: number; type: 'sonar_availability'; sonarId: string; available: boolean };

export type BenchmarkScenario = {
  name: string;
  seed: number;
  description: string;
  initialSwimmers: Swimmer[];
  events: ScenarioEvent[];
  movementModel?: PopulationMovementModel;
  swimmerCount?: number;
  restingSwimmerCount?: number;
  sonarFailureMode?: SonarFailureMode;
  failedSonarIds?: string[];
  sonarFailureStartSec?: number;
  sonarFailureEndSec?: number;
};

export type PopulationScenarioOptions = {
  sonarCount?: number;
  sonarFailureMode?: SonarFailureMode;
  sonarFailureStartSec?: number;
  sonarFailureDurationSec?: number;
};

const normalize = (x: number, y: number) => {
  const mag = Math.hypot(x, y) || 1;
  return { x: x / mag, y: y / mag };
};

const swimmer = (
  id: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  enteredAt = 0,
  motion?: SwimmerMotionProfile
): Swimmer => ({
  id,
  position: { x, y },
  velocity: { x: vx, y: vy },
  enteredAt,
  motion,
});

const seededSwimmer = (rng: SeededRng, id: string, enteredAt: number): Swimmer => {
  const side = rng.nextInt(4);
  const speed = rng.nextRange(SWIMMER_SPEED_MIN, SWIMMER_SPEED_MAX);
  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = 0;

  if (side === 0) {
    x = rng.nextRange(2, POOL_WIDTH - 2);
    y = 0;
    dx = rng.nextRange(-0.3, 0.3);
    dy = 1;
  } else if (side === 1) {
    x = rng.nextRange(2, POOL_WIDTH - 2);
    y = POOL_LENGTH;
    dx = rng.nextRange(-0.3, 0.3);
    dy = -1;
  } else if (side === 2) {
    x = 0;
    y = rng.nextRange(4, POOL_LENGTH - 4);
    dx = 1;
    dy = rng.nextRange(-0.3, 0.3);
  } else {
    x = POOL_WIDTH;
    y = rng.nextRange(4, POOL_LENGTH - 4);
    dx = -1;
    dy = rng.nextRange(-0.3, 0.3);
  }

  const dir = normalize(dx, dy);
  return swimmer(id, x, y, dir.x * speed, dir.y * speed, enteredAt);
};

const jitter = (rng: SeededRng, value: number, amount: number, lo: number, hi: number) => {
  return Math.max(lo, Math.min(hi, value + rng.nextRange(-amount, amount)));
};

const laneMotion = (
  rng: SeededRng,
  laneX: number,
  speedMps: number,
  longDirection: 1 | -1
): SwimmerMotionProfile => ({
  kind: 'lane_swim',
  laneX,
  speedMps,
  longDirection,
  lateralAmplitudeM: rng.nextRange(0.04, 0.18),
  lateralPeriodSec: rng.nextRange(18, 36),
  phaseSec: rng.nextRange(0, 36),
});

const restMotion = (laneX: number, restY: number): SwimmerMotionProfile => ({
  kind: 'short_end_rest',
  laneX,
  restY,
  speedMps: 0,
});

const laneSwimmer = (
  rng: SeededRng,
  id: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  enteredAt = 0
) => {
  const speed = Math.max(SWIMMER_SPEED_MIN, Math.min(SWIMMER_SPEED_MAX, Math.hypot(vx, vy)));
  const direction = (vy >= 0 ? 1 : -1) as 1 | -1;
  return swimmer(id, x, y, vx, vy, enteredAt, laneMotion(rng, x, speed, direction));
};

const mixedSpeed = (rng: SeededRng, index: number) => {
  const band = rng.nextInt(3);
  const base = band === 0
    ? rng.nextRange(0.8, 1.05)
    : band === 1
      ? rng.nextRange(1.05, 1.45)
      : rng.nextRange(1.45, 1.8);
  return Math.max(SWIMMER_SPEED_MIN, Math.min(SWIMMER_SPEED_MAX, base + (index % 5) * 0.012));
};

const swimmerId = (index: number) => `W${String(index + 1).padStart(3, '0')}`;

const randomReflectInitialHeading = (rng: SeededRng) => {
  const routeKind = rng.next();
  let baseHeading = 0;
  let spreadDeg = 0;

  if (routeKind < 0.58) {
    baseHeading = rng.next() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
    spreadDeg = 24;
  } else if (routeKind < 0.88) {
    const diagonals = [Math.PI / 4, (3 * Math.PI) / 4, -Math.PI / 4, (-3 * Math.PI) / 4];
    baseHeading = diagonals[rng.nextInt(diagonals.length)];
    spreadDeg = 20;
  } else {
    baseHeading = rng.next() < 0.5 ? 0 : Math.PI;
    spreadDeg = 18;
  }

  return baseHeading + rng.nextRange(-spreadDeg, spreadDeg) * DEG_TO_RAD;
};

const makeRandomReflectSwimmers = (rng: SeededRng, swimmerCount: number) => {
  const swimmers: Swimmer[] = [];
  for (let index = 0; index < swimmerCount; index += 1) {
    const speed = mixedSpeed(rng, index);
    const theta = randomReflectInitialHeading(rng);
    swimmers.push(swimmer(
      swimmerId(index),
      rng.nextRange(1, POOL_WIDTH - 1),
      rng.nextRange(1, POOL_LENGTH - 1),
      Math.cos(theta) * speed,
      Math.sin(theta) * speed,
      0,
      { kind: 'free_reflect' },
    ));
  }
  return swimmers;
};

const restingCountFor = (swimmerCount: number, restFraction: number) => {
  if (swimmerCount < 6) return 0;
  return Math.min(swimmerCount, Math.max(1, Math.round(swimmerCount * restFraction)));
};

const makeLapSwimSwimmers = (
  rng: SeededRng,
  swimmerCount: number,
  restFraction: number
) => {
  const restingCount = restingCountFor(swimmerCount, restFraction);
  const activeCount = swimmerCount - restingCount;
  const laneCount = Math.max(1, POOL_LANE_COUNT);
  const laneWidth = POOL_WIDTH / laneCount;
  const swimmers: Swimmer[] = [];

  for (let index = 0; index < activeCount; index += 1) {
    const lane = index % laneCount;
    const laneCycle = Math.floor(index / laneCount);
    const x = jitter(rng, laneWidth * (lane + 0.5), 0.25, 0.75, POOL_WIDTH - 0.75);
    const y = rng.nextRange(4, POOL_LENGTH - 4);
    const speed = mixedSpeed(rng, index);
    const vx = rng.nextRange(-0.04, 0.04);
    const direction = ((laneCycle + lane) % 2 === 0 ? 1 : -1) as 1 | -1;
    const vy = Math.sqrt(Math.max(0, speed * speed - vx * vx)) * direction;
    swimmers.push(swimmer(swimmerId(index), x, y, vx, vy, 0, laneMotion(rng, x, speed, direction)));
  }

  for (let offset = 0; offset < restingCount; offset += 1) {
    const index = activeCount + offset;
    const sideY = offset % 2 === 0
      ? rng.nextRange(0.2, 1.4)
      : POOL_LENGTH - rng.nextRange(0.2, 1.4);
    const lane = index % laneCount;
    const x = jitter(rng, laneWidth * (lane + 0.5), 0.35, 0.75, POOL_WIDTH - 0.75);
    swimmers.push(swimmer(swimmerId(index), x, sideY, 0, 0, 0, restMotion(x, sideY)));
  }

  return { swimmers, restingCount };
};

const makeSensorFailureRobustnessSwimmers = (rng: SeededRng) => {
  const laneWidth = POOL_WIDTH / Math.max(1, POOL_LANE_COUNT);
  return [
    laneSwimmer(rng, 'W001', jitter(rng, laneWidth * 0.5, 0.20, 0.75, POOL_WIDTH - 0.75), 5, 0.02, 1.15),
    laneSwimmer(rng, 'W002', jitter(rng, laneWidth * 1.5, 0.20, 0.75, POOL_WIDTH - 0.75), 12, -0.03, 1.35),
    laneSwimmer(rng, 'W003', jitter(rng, laneWidth * 2.5, 0.20, 0.75, POOL_WIDTH - 0.75), 19, 0.02, 1.05),
    laneSwimmer(rng, 'W004', jitter(rng, laneWidth * 3.5, 0.20, 0.75, POOL_WIDTH - 0.75), 44, -0.02, -1.25),
    laneSwimmer(rng, 'W005', jitter(rng, laneWidth * 1.0, 0.25, 0.75, POOL_WIDTH - 0.75), 37, 0.03, -1.10),
    laneSwimmer(rng, 'W006', jitter(rng, laneWidth * 3.0, 0.25, 0.75, POOL_WIDTH - 0.75), 29, -0.02, -1.45),
  ];
};

const sensorFailureWorkloadRng = (seed: number) => (
  createLCGRng(hashStringToUint32(`sensor_failure_robustness_workload|${seed}`))
);

const sonarFailureWindow = (
  scenarioName: BenchmarkScenarioName,
  seed: number,
  sonarIds: string[],
  baseStartSec: number,
  baseDurationSec: number
): ScenarioEvent[] => {
  const rng = createLCGRng(hashStringToUint32(`${scenarioName}|failure-window|${seed}`));
  const start = Math.round(baseStartSec + rng.nextRange(-5, 6));
  const duration = Math.round(baseDurationSec + rng.nextRange(-8, 9));
  return [
    ...sonarIds.map(sonarId => ({
      timeSec: start,
      type: 'sonar_availability' as const,
      sonarId,
      available: false,
    })),
    ...sonarIds.map(sonarId => ({
      timeSec: start + duration,
      type: 'sonar_availability' as const,
      sonarId,
      available: true,
    })),
  ].sort((a, b) => a.timeSec - b.timeSec || Number(a.available) - Number(b.available));
};

const singleFailureSonarId = (scenarioName: BenchmarkScenarioName, seed: number) => {
  const ids = ['S1', 'S2', 'S3', 'S4'];
  const rng = createLCGRng(hashStringToUint32(`${scenarioName}|single-sonar|${seed}`));
  return ids[rng.nextInt(ids.length)];
};

const segmentFailureSonarIds = (scenarioName: BenchmarkScenarioName, seed: number) => {
  const segments = [
    ['S1', 'S2'], // opposite long-edge center units sharing the main side-link in the default 4-sonar layout
    ['S3', 'S4'], // two short-end units sharing the timing/network segment
  ];
  const rng = createLCGRng(hashStringToUint32(`${scenarioName}|segment-sonars|${seed}`));
  return segments[rng.nextInt(segments.length)];
};

const populationSonarIds = (sonarCount: number | undefined) => {
  const count = Math.max(1, Math.floor(sonarCount ?? 4));
  return Array.from({ length: count }, (_, index) => `S${index + 1}`);
};

const populationFailureLabel = (mode: SonarFailureMode) => {
  if (mode === 'single_transient') return 'single_sonar_outage';
  if (mode === 'segment_transient') return 'segment_outage';
  return 'control';
};

const populationFailureSonarIds = (
  movementModel: PopulationMovementModel,
  swimmerCount: number,
  seed: number,
  mode: SonarFailureMode,
  sonarCount: number | undefined
) => {
  if (mode === 'none') return [];
  const ids = populationSonarIds(sonarCount);
  const rng = createLCGRng(hashStringToUint32(`${movementModel}|${swimmerCount}|${seed}|${mode}|${ids.length}`));
  const start = rng.nextInt(ids.length);
  if (mode === 'single_transient' || ids.length === 1) return [ids[start]];
  return [ids[start], ids[(start + 1) % ids.length]];
};

const populationFailureEvents = (
  failedSonarIds: string[],
  startSec: number,
  durationSec: number
): ScenarioEvent[] => {
  const endSec = startSec + durationSec;
  return [
    ...failedSonarIds.map(sonarId => ({
      timeSec: startSec,
      type: 'sonar_availability' as const,
      sonarId,
      available: false,
    })),
    ...failedSonarIds.map(sonarId => ({
      timeSec: endSec,
      type: 'sonar_availability' as const,
      sonarId,
      available: true,
    })),
  ].sort((a, b) => a.timeSec - b.timeSec || Number(a.available) - Number(b.available));
};

const applyPopulationFailure = (
  base: BenchmarkScenario,
  options: PopulationScenarioOptions
): BenchmarkScenario => {
  if (!options.sonarFailureMode) return base;
  const mode = options.sonarFailureMode;
  const label = populationFailureLabel(mode);
  const startSec = options.sonarFailureStartSec ?? 45;
  const durationSec = options.sonarFailureDurationSec ?? 40;
  const failedSonarIds = populationFailureSonarIds(
    base.movementModel ?? 'random_reflect',
    base.swimmerCount ?? base.initialSwimmers.length,
    base.seed,
    mode,
    options.sonarCount
  );
  const events = mode === 'none'
    ? []
    : populationFailureEvents(failedSonarIds, startSec, durationSec);
  const failureText = mode === 'none'
    ? 'No sonar outage control condition.'
    : `Temporary ${failedSonarIds.length}-sonar outage (${failedSonarIds.join(', ')}) from ${startSec}s to ${startSec + durationSec}s.`;

  return {
    ...base,
    name: `${base.name}_${label}`,
    description: `${base.description} ${failureText}`,
    events: [...base.events, ...events].sort((a, b) => a.timeSec - b.timeSec),
    sonarFailureMode: mode,
    failedSonarIds,
    sonarFailureStartSec: mode === 'none' ? undefined : startSec,
    sonarFailureEndSec: mode === 'none' ? undefined : startSec + durationSec,
  };
};

export const makePopulationBenchmarkScenario = (
  movementModel: PopulationMovementModel,
  swimmerCount: number,
  seed: number,
  restFraction = 0.15,
  options: PopulationScenarioOptions = {}
): BenchmarkScenario => {
  const rng = createLCGRng(hashStringToUint32(`${movementModel}|${swimmerCount}|${seed}`));

  if (movementModel === 'random_reflect') {
    return applyPopulationFailure({
      name: `${movementModel}_${swimmerCount}`,
      seed,
      description: `${swimmerCount} swimmers with route-oriented headings, sparse course changes, and mixed speeds.`,
      initialSwimmers: makeRandomReflectSwimmers(rng, swimmerCount),
      events: [],
      movementModel,
      swimmerCount,
      restingSwimmerCount: 0,
    }, options);
  }

  const { swimmers, restingCount } = makeLapSwimSwimmers(rng, swimmerCount, restFraction);
  return applyPopulationFailure({
    name: `${movementModel}_${swimmerCount}`,
    seed,
    description: `${swimmerCount} lane swimmers with mixed speeds and ${restingCount} short-end resting swimmers.`,
    initialSwimmers: swimmers,
    events: [],
    movementModel,
    swimmerCount,
    restingSwimmerCount: restingCount,
  }, options);
};

export const makeBenchmarkScenario = (
  name: BenchmarkScenarioName,
  seed: number
): BenchmarkScenario => {
  const rng = createLCGRng(hashStringToUint32(`${name}|${seed}`));

  switch (name) {
    case 'empty_pool':
      return {
        name,
        seed,
        description: 'No swimmers; exercises clutter, false alarm, and false track behavior.',
        initialSwimmers: [],
        events: [],
      };

    case 'single_straight': {
      const speed = rng.nextRange(1.0, 1.5);
      const x = jitter(rng, POOL_WIDTH / 2, 1.5, 2, POOL_WIDTH - 2);
      return {
        name,
        seed,
        description: 'One swimmer moving approximately lengthwise through the pool center.',
        initialSwimmers: [
          laneSwimmer(rng, 'W001', x, 2, 0, speed),
        ],
        events: [],
      };
    }

    case 'single_wall': {
      const speed = rng.nextRange(0.9, 1.35);
      const x = jitter(rng, 1.5, 0.4, 0.5, 3);
      return {
        name,
        seed,
        description: 'One swimmer near a side wall where wall echo and grazing-angle geometry matter.',
        initialSwimmers: [
          laneSwimmer(rng, 'W001', x, 4, 0.03, speed),
        ],
        events: [],
      };
    }

    case 'two_swimmers_crossing':
      return {
        name,
        seed,
        description: 'Two swimmers crossing near the pool center from different directions.',
        initialSwimmers: [
          swimmer('W001', 3, jitter(rng, 8, 2, 3, POOL_LENGTH - 3), 1.15, 0.65),
          swimmer('W002', POOL_WIDTH - 3, jitter(rng, 42, 2, 3, POOL_LENGTH - 3), -1.15, -0.65),
        ],
        events: [],
      };

    case 'multi_distributed':
      return {
        name,
        seed,
        description: 'Four swimmers distributed across the pool with varied headings.',
        initialSwimmers: [
          swimmer('W001', 4, 5, 0.8, 0.95),
          swimmer('W002', 16, 8, -0.7, 1.1),
          swimmer('W003', 5, 43, 0.8, -0.9),
          swimmer('W004', 15, 38, -0.9, -0.75),
        ],
        events: [],
      };

    case 'multi_clustered':
      return {
        name,
        seed,
        description: 'Four swimmers initially close together to stress merge and occlusion behavior.',
        initialSwimmers: [
          swimmer('W001', jitter(rng, 9, 0.5, 1, POOL_WIDTH - 1), 23, 0.9, 0.25),
          swimmer('W002', jitter(rng, 10, 0.5, 1, POOL_WIDTH - 1), 24, -0.7, 0.3),
          swimmer('W003', jitter(rng, 11, 0.5, 1, POOL_WIDTH - 1), 25, 0.45, -0.85),
          swimmer('W004', jitter(rng, 10.5, 0.5, 1, POOL_WIDTH - 1), 26, -0.25, -0.95),
        ],
        events: [],
      };

    case 'high_density':
      return {
        name,
        seed,
        description: 'Eight swimmers distributed across lanes to stress assignment capacity and revisit deadlines.',
        initialSwimmers: [
          laneSwimmer(rng, 'W001', 2.5, 4, 0.10, 1.15),
          laneSwimmer(rng, 'W002', 7.5, 7, -0.08, 1.05),
          laneSwimmer(rng, 'W003', 12.5, 10, 0.06, 1.2),
          laneSwimmer(rng, 'W004', 17.5, 13, -0.08, 1.0),
          laneSwimmer(rng, 'W005', 3.5, 44, 0.08, -1.1),
          laneSwimmer(rng, 'W006', 8.5, 41, -0.06, -1.2),
          laneSwimmer(rng, 'W007', 13.5, 38, 0.08, -1.0),
          laneSwimmer(rng, 'W008', 16.5, 35, -0.10, -1.15),
        ],
        events: [],
      };

    case 'sensor_failure':
      return {
        name,
        seed,
        description: 'Two swimmers remain active while S2 fails at 60s and recovers at 120s.',
        initialSwimmers: [
          swimmer('W001', 5, 5, 0.4, 1.1),
          swimmer('W002', 15, 42, -0.35, -1.0),
        ],
        events: [
          { timeSec: 60, type: 'sonar_availability', sonarId: 'S2', available: false },
          { timeSec: 120, type: 'sonar_availability', sonarId: 'S2', available: true },
        ],
      };

    case 'sensor_failure_control':
      return {
        name,
        seed,
        description: 'Six lane swimmers with no sonar outage; control for sensor-failure robustness comparisons.',
        initialSwimmers: makeSensorFailureRobustnessSwimmers(sensorFailureWorkloadRng(seed)),
        events: [],
      };

    case 'sensor_failure_single_transient': {
      const failedSonar = singleFailureSonarId(name, seed);
      return {
        name,
        seed,
        description: `Six lane swimmers while one sonar (${failedSonar}) is temporarily unavailable once.`,
        initialSwimmers: makeSensorFailureRobustnessSwimmers(sensorFailureWorkloadRng(seed)),
        events: sonarFailureWindow(name, seed, [failedSonar], 90, 45),
      };
    }

    case 'sensor_failure_segment_transient': {
      const failedSonars = segmentFailureSonarIds(name, seed);
      return {
        name,
        seed,
        description: `Six lane swimmers while a two-sonar network segment (${failedSonars.join(', ')}) is temporarily unavailable once.`,
        initialSwimmers: makeSensorFailureRobustnessSwimmers(sensorFailureWorkloadRng(seed)),
        events: sonarFailureWindow(name, seed, failedSonars, 95, 50),
      };
    }

    case 'random_entry_exit': {
      const first = seededSwimmer(rng, 'W001', 0);
      const second = seededSwimmer(rng, 'W002', 15);
      const third = seededSwimmer(rng, 'W003', 35);
      return {
        name,
        seed,
        description: 'Swimmers enter and leave over time using deterministic seeded draws.',
        initialSwimmers: [first],
        events: [
          { timeSec: 15, type: 'add', swimmer: second },
          { timeSec: 35, type: 'add', swimmer: third },
          { timeSec: 55, type: 'remove', swimmerId: 'W001' },
        ],
      };
    }
  }
};

export const cloneSwimmer = (input: Swimmer): Swimmer => ({
  id: input.id,
  position: { x: input.position.x, y: input.position.y },
  velocity: { x: input.velocity.x, y: input.velocity.y },
  enteredAt: input.enteredAt,
  motion: input.motion ? { ...input.motion } : undefined,
});
