import type { EngineTuningParams } from '../../SimulationEngine';
import {
  BenchmarkConfig,
  BenchmarkScenarioName,
  PopulationMovementModel,
  ResolvedBenchmarkConfig,
  resolveBenchmarkConfig,
  SensorProfileName,
  SENSOR_PROFILES,
} from './BenchmarkConfig';
import {
  BenchmarkScenario,
  makeBenchmarkScenario,
  makePopulationBenchmarkScenario,
} from './ScenarioFactory';
import { DEFAULT_SONAR_COUNT } from '../core/Scenario';

type RuntimeSource = Record<string, unknown>;

export type UiBenchmarkSetup = {
  config: ResolvedBenchmarkConfig;
  scenario: BenchmarkScenario;
  scenarioKind: 'named' | 'population';
  baselineStrategy: string;
  candidateStrategy: string;
  seed: number;
  sensorParams: EngineTuningParams;
  summary: string;
};

const nonEmpty = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
};

const readQuery = (query: URLSearchParams | RuntimeSource | undefined, names: string[]) => {
  if (!query) return undefined;
  for (const name of names) {
    const value = query instanceof URLSearchParams ? query.get(name) : query[name];
    const text = nonEmpty(value);
    if (text !== undefined) return text;
  }
  return undefined;
};

const readEnv = (env: RuntimeSource | undefined, names: string[]) => {
  if (!env) return undefined;
  for (const name of names) {
    const text = nonEmpty(env[name]);
    if (text !== undefined) return text;
  }
  return undefined;
};

const readValue = (
  query: URLSearchParams | RuntimeSource | undefined,
  env: RuntimeSource | undefined,
  queryNames: string[],
  envNames: string[]
) => readQuery(query, queryNames) ?? readEnv(env, envNames);

const numberOrUndefined = (value: string | undefined) => value === undefined ? undefined : Number(value);

const booleanOrUndefined = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
};

const splitStrategies = (value: string | undefined) => value
  ?.split(',')
  .map(item => item.trim().toUpperCase())
  .filter(Boolean);

const defaultSearchParams = () => {
  if (typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search);
};

export const resolveUiBenchmarkSetup = (
  env?: RuntimeSource,
  query: URLSearchParams | RuntimeSource | undefined = defaultSearchParams()
): UiBenchmarkSetup => {
  const strategyList = splitStrategies(readValue(
    query,
    env,
    ['strategies'],
    ['VITE_BENCHMARK_STRATEGIES']
  ));
  const singleStrategy = readValue(query, env, ['strategy'], ['VITE_BENCHMARK_STRATEGY'])?.toUpperCase();
  const baselineStrategy = (
    readValue(query, env, ['baselineStrategy', 'baseline'], ['VITE_BASELINE_STRATEGY'])
    ?? strategyList?.[0]
    ?? 'FULL_SCAN'
  ).toUpperCase();
  const candidateStrategy = (
    readValue(query, env, ['candidateStrategy', 'candidate'], ['VITE_CANDIDATE_STRATEGY'])
    ?? strategyList?.[1]
    ?? singleStrategy
    ?? 'ROUND_ROBIN_SECTOR'
  ).toUpperCase();

  const movementModelRaw = readValue(
    query,
    env,
    ['movementModel', 'movement'],
    ['VITE_BENCHMARK_MOVEMENT_MODEL']
  );
  const swimmerCountRaw = readValue(
    query,
    env,
    ['swimmerCount', 'swimmers'],
    ['VITE_BENCHMARK_SWIMMER_COUNT']
  );
  const hasPopulationScenario = movementModelRaw !== undefined || swimmerCountRaw !== undefined;
  const scenarioName = hasPopulationScenario
    ? undefined
    : readValue(query, env, ['scenario'], ['VITE_BENCHMARK_SCENARIO']) ?? 'two_swimmers_crossing';
  const movementModel = hasPopulationScenario ? movementModelRaw ?? 'random_reflect' : undefined;
  const swimmerCount = hasPopulationScenario ? numberOrUndefined(swimmerCountRaw) ?? 4 : undefined;

  const rawConfig: BenchmarkConfig = {
    benchmarkId: readValue(query, env, ['benchmarkId'], ['VITE_BENCHMARK_ID']) ?? 'ui_benchmark_repro',
    outputLabel: 'synthetic-uncalibrated',
    scenario: scenarioName as BenchmarkScenarioName | undefined,
    movementModel: movementModel as PopulationMovementModel | undefined,
    swimmerCount,
    restFraction: numberOrUndefined(readValue(query, env, ['restFraction'], ['VITE_BENCHMARK_REST_FRACTION'])),
    durationSec: numberOrUndefined(readValue(query, env, ['durationSec'], ['VITE_BENCHMARK_DURATION_SEC'])) ?? 300,
    seed: numberOrUndefined(readValue(query, env, ['seed'], ['VITE_BENCHMARK_SEED'])) ?? 1,
    strategies: [baselineStrategy, candidateStrategy],
    sensorProfile: (
      readValue(query, env, ['sensorProfile'], ['VITE_SENSOR_PROFILE', 'VITE_BENCHMARK_SENSOR_PROFILE'])
      ?? 'synthetic_default_v0'
    ) as SensorProfileName,
    dtSec: numberOrUndefined(readValue(query, env, ['dtSec'], ['VITE_DT_SEC', 'VITE_BENCHMARK_DT_SEC'])),
    sampleIntervalSec: numberOrUndefined(readValue(
      query,
      env,
      ['sampleIntervalSec'],
      ['VITE_SAMPLE_INTERVAL_SEC', 'VITE_BENCHMARK_SAMPLE_INTERVAL_SEC']
    )),
    strategyUpdateIntervalSec: numberOrUndefined(readValue(
      query,
      env,
      ['strategyUpdateIntervalSec'],
      ['VITE_STRATEGY_UPDATE_INTERVAL_SEC', 'VITE_BENCHMARK_STRATEGY_UPDATE_INTERVAL_SEC']
    )),
    metricsWindowSec: numberOrUndefined(readValue(
      query,
      env,
      ['metricsWindowSec'],
      ['VITE_METRICS_WINDOW_SEC', 'VITE_BENCHMARK_METRICS_WINDOW_SEC']
    )),
    warmupSec: numberOrUndefined(readValue(query, env, ['warmupSec'], ['VITE_BENCHMARK_WARMUP_SEC'])),
    sonarCount: numberOrUndefined(readValue(query, env, ['sonarCount'], ['VITE_SONAR_COUNT'])) ?? DEFAULT_SONAR_COUNT,
    tdmaEnabled: booleanOrUndefined(readValue(query, env, ['tdmaEnabled', 'tdma'], ['VITE_TDMA_ENABLED'])),
    configPath: 'ui-runtime',
  };

  const config = resolveBenchmarkConfig(rawConfig);
  const seed = config.seeds[0];
  const scenarioKind = config.movementModels.length > 0 ? 'population' : 'named';
  const scenario = scenarioKind === 'population'
    ? makePopulationBenchmarkScenario(
      config.movementModels[0],
      config.swimmerCounts[0],
      seed,
      config.restFraction
    )
    : makeBenchmarkScenario(config.scenarios[0], seed);

  const sensorParams = SENSOR_PROFILES[config.sensorProfile];
  return {
    config,
    scenario,
    scenarioKind,
    baselineStrategy: config.strategies[0],
    candidateStrategy: config.strategies[1],
    seed,
    sensorParams,
    summary: `${scenario.name} · seed ${seed} · ${config.sensorProfile} · dt ${config.dtSec}s · TDMA ${config.tdmaEnabled ? 'on' : 'off'}`,
  };
};
