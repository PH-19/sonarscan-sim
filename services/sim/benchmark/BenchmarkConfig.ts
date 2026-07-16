import type { EngineTuningParams } from '../../SimulationEngine';
import { DEFAULT_SONAR_COUNT, normalizeSonarCount } from '../core/Scenario';

export const BENCHMARK_OUTPUT_LABEL = 'synthetic-uncalibrated' as const;

export type BenchmarkOutputLabel = typeof BENCHMARK_OUTPUT_LABEL;

export type SensorProfileName =
  | 'synthetic_default_v0'
  | 'synthetic_clean_v0'
  | 'synthetic_cluttered_v0';

export type PopulationMovementModel =
  | 'random_reflect'
  | 'lap_swim_with_rest';

export type SonarFailureMode =
  | 'none'
  | 'single_transient'
  | 'segment_transient';

export type BenchmarkScenarioName =
  | 'empty_pool'
  | 'single_straight'
  | 'single_wall'
  | 'two_swimmers_crossing'
  | 'multi_distributed'
  | 'multi_clustered'
  | 'high_density'
  | 'sensor_failure'
  | 'sensor_failure_control'
  | 'sensor_failure_single_transient'
  | 'sensor_failure_segment_transient'
  | 'random_entry_exit';

export type BenchmarkConfig = {
  experimentId?: string;
  configPath?: string;
  benchmarkId: string;
  outputLabel: BenchmarkOutputLabel;
  scenarios?: BenchmarkScenarioName[];
  scenario?: BenchmarkScenarioName;
  movementModels?: PopulationMovementModel[];
  movementModel?: PopulationMovementModel;
  sonarFailureModes?: SonarFailureMode[];
  sonarFailureMode?: SonarFailureMode;
  sonarFailureStartSec?: number;
  sonarFailureDurationSec?: number;
  swimmerCounts?: number[];
  swimmerCount?: number;
  restFraction?: number;
  experimentOutputRoot?: string;
  durationSec: number;
  seeds?: number[];
  seed?: number;
  strategies?: string[];
  strategy?: string;
  sensorProfile: SensorProfileName;
  dtSec?: number;
  sampleIntervalSec?: number;
  strategyUpdateIntervalSec?: number;
  metricsWindowSec?: number;
  warmupSec?: number;
  sonarCount?: number;
  tdmaEnabled?: boolean;
  outputDir?: string;
};

export type ResolvedBenchmarkConfig = Required<
  Pick<
    BenchmarkConfig,
    | 'experimentId'
    | 'configPath'
    | 'benchmarkId'
    | 'outputLabel'
    | 'durationSec'
    | 'sensorProfile'
    | 'dtSec'
    | 'sampleIntervalSec'
    | 'strategyUpdateIntervalSec'
    | 'metricsWindowSec'
    | 'warmupSec'
    | 'sonarCount'
    | 'tdmaEnabled'
  >
> & {
  scenarios: BenchmarkScenarioName[];
  movementModels: PopulationMovementModel[];
  sonarFailureModes: SonarFailureMode[];
  sonarFailureStartSec?: number;
  sonarFailureDurationSec?: number;
  swimmerCounts: number[];
  restFraction: number;
  seeds: number[];
  strategies: string[];
  outputDir?: string;
  experimentOutputRoot?: string;
};

export const SENSOR_PROFILES: Record<SensorProfileName, EngineTuningParams> = {
  synthetic_default_v0: {
    noiseScale: 0.30,
    speckleProb: 0.001,
    threshold: 1.5,
    dbscanEpsBins: 2.5,
    dbscanMinPts: 4,
    detectorMinClusterCells: 0,
    detectorMedianKernel: 1,
    detectorBoxBlurRadius: 0,
    detectorRobustNormalize: false,
    detectorResolutionAware: false,
    detectorPhysicalFilter: false,
    trackerMissExistenceSurvival: 0.78,
  },
  synthetic_clean_v0: {
    noiseScale: 0.15,
    speckleProb: 0.0005,
    threshold: 1.0,
    dbscanEpsBins: 2.0,
    dbscanMinPts: 3,
    detectorMinClusterCells: 0,
    detectorMedianKernel: 1,
    detectorBoxBlurRadius: 0,
    detectorRobustNormalize: false,
    detectorResolutionAware: false,
    detectorPhysicalFilter: false,
    trackerMissExistenceSurvival: 0.78,
  },
  synthetic_cluttered_v0: {
    noiseScale: 0.60,
    speckleProb: 0.005,
    threshold: 2.0,
    dbscanEpsBins: 2.5,
    dbscanMinPts: 5,
    detectorMinClusterCells: 0,
    detectorMedianKernel: 1,
    detectorBoxBlurRadius: 0,
    detectorRobustNormalize: false,
    detectorResolutionAware: false,
    detectorPhysicalFilter: false,
    trackerMissExistenceSurvival: 0.78,
  },
};

const asArray = <T>(plural: T[] | undefined, singular: T | undefined, field: string): T[] => {
  const values = plural ?? (singular === undefined ? [] : [singular]);
  if (!values.length) throw new Error(`Benchmark config must include ${field}`);
  return values;
};

const optionalArray = <T>(plural: T[] | undefined, singular: T | undefined): T[] => {
  return plural ?? (singular === undefined ? [] : [singular]);
};

const isPopulationMovementModel = (value: string): value is PopulationMovementModel => {
  return value === 'random_reflect' || value === 'lap_swim_with_rest';
};

const isSonarFailureMode = (value: string): value is SonarFailureMode => {
  return value === 'none' || value === 'single_transient' || value === 'segment_transient';
};

export const resolveBenchmarkConfig = (raw: BenchmarkConfig): ResolvedBenchmarkConfig => {
  if (raw.outputLabel !== BENCHMARK_OUTPUT_LABEL) {
    throw new Error(`Stage 5A benchmark outputLabel must be "${BENCHMARK_OUTPUT_LABEL}"`);
  }
  if (!raw.sensorProfile.startsWith('synthetic_')) {
    throw new Error('Stage 5A only accepts synthetic sensor profiles; calibrated profiles belong to stage 5B');
  }
  if (!SENSOR_PROFILES[raw.sensorProfile]) {
    throw new Error(`Unknown sensorProfile: ${raw.sensorProfile}`);
  }
  if (!Number.isFinite(raw.durationSec) || raw.durationSec <= 0) {
    throw new Error('durationSec must be a positive number');
  }
  const strategies = asArray(raw.strategies, raw.strategy, 'strategy or strategies').map(s => s.toUpperCase());
  if (strategies.includes('OPTIMIZED')) {
    throw new Error('OPTIMIZED is ambiguous; use a named built-in scan mode');
  }

  const scenarios = optionalArray(raw.scenarios, raw.scenario);
  const movementModels = optionalArray(raw.movementModels, raw.movementModel);
  const sonarFailureModes = [...new Set(optionalArray(raw.sonarFailureModes, raw.sonarFailureMode))];
  const swimmerCounts = optionalArray(raw.swimmerCounts, raw.swimmerCount);
  const hasPopulationSweep = movementModels.length > 0 || swimmerCounts.length > 0;
  if (!scenarios.length && !hasPopulationSweep) {
    throw new Error('Benchmark config must include scenario/scenarios or movementModels + swimmerCounts');
  }
  if (hasPopulationSweep) {
    if (!movementModels.length) throw new Error('Population sweep configs must include movementModels');
    if (!swimmerCounts.length) throw new Error('Population sweep configs must include swimmerCounts');
  }
  for (const model of movementModels) {
    if (!isPopulationMovementModel(model)) throw new Error(`Unknown movementModel: ${model}`);
  }
  for (const mode of sonarFailureModes) {
    if (!isSonarFailureMode(mode)) throw new Error(`Unknown sonarFailureMode: ${mode}`);
  }
  if (sonarFailureModes.length > 0 && !hasPopulationSweep) {
    throw new Error('sonarFailureModes are only supported for population sweep configs');
  }
  for (const count of swimmerCounts) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`swimmerCounts must contain non-negative integers; received ${count}`);
    }
  }
  const restFraction = raw.restFraction ?? 0.15;
  if (!Number.isFinite(restFraction) || restFraction < 0 || restFraction > 1) {
    throw new Error('restFraction must be a finite number in [0, 1]');
  }
  if (raw.sonarFailureStartSec !== undefined && (!Number.isFinite(raw.sonarFailureStartSec) || raw.sonarFailureStartSec < 0)) {
    throw new Error('sonarFailureStartSec must be a finite non-negative number');
  }
  if (raw.sonarFailureDurationSec !== undefined && (!Number.isFinite(raw.sonarFailureDurationSec) || raw.sonarFailureDurationSec <= 0)) {
    throw new Error('sonarFailureDurationSec must be a finite positive number');
  }
  if (
    raw.sonarFailureStartSec !== undefined &&
    raw.sonarFailureDurationSec !== undefined &&
    raw.sonarFailureStartSec + raw.sonarFailureDurationSec >= raw.durationSec
  ) {
    throw new Error('sonarFailureStartSec + sonarFailureDurationSec must be less than durationSec');
  }

  return {
    experimentId: raw.experimentId ?? raw.benchmarkId,
    configPath: raw.configPath,
    benchmarkId: raw.benchmarkId,
    outputLabel: raw.outputLabel,
    scenarios,
    movementModels,
    sonarFailureModes,
    sonarFailureStartSec: raw.sonarFailureStartSec,
    sonarFailureDurationSec: raw.sonarFailureDurationSec,
    swimmerCounts,
    restFraction,
    durationSec: raw.durationSec,
    seeds: asArray(raw.seeds, raw.seed, 'seed or seeds'),
    strategies,
    sensorProfile: raw.sensorProfile,
    dtSec: raw.dtSec ?? 0.1,
    sampleIntervalSec: raw.sampleIntervalSec ?? 1,
    strategyUpdateIntervalSec: raw.strategyUpdateIntervalSec ?? 0.8,
    metricsWindowSec: raw.metricsWindowSec ?? 10,
    warmupSec: raw.warmupSec ?? Math.min(30, raw.durationSec * 0.1),
    sonarCount: normalizeSonarCount(raw.sonarCount ?? DEFAULT_SONAR_COUNT),
    tdmaEnabled: raw.tdmaEnabled ?? false,
    outputDir: raw.outputDir,
    experimentOutputRoot: raw.experimentOutputRoot,
  };
};
