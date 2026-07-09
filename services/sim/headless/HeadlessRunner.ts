import path from 'node:path';
import { EngineEvalMetrics, EngineFrameEvent, StrategyDecision } from '../../../types';
import { SimulationEngine } from '../../SimulationEngine';
import {
  BenchmarkConfig,
  resolveBenchmarkConfig,
  SENSOR_PROFILES,
} from '../benchmark/BenchmarkConfig';
import {
  BenchmarkScenario,
  makeBenchmarkScenario,
  makePopulationBenchmarkScenario,
} from '../benchmark/ScenarioFactory';
import {
  applyBenchmarkScenarioEvent,
  resetEngineToBenchmarkScenario,
} from '../benchmark/ScenarioRuntime';
import {
  BenchmarkRunMetadata,
  MetricsRecorder,
  SimulatorState,
} from '../benchmark/MetricsRecorder';
import { createHeadlessStrategyProvider } from '../strategy/HeadlessStrategyProviderRegistry';
import { StrategyImplementation } from '../strategy/StrategyProvider';
import { SonarTimingModel } from '../sonar/SonarTimingModel';

export type HeadlessBenchmarkResult = {
  outputDir: string;
  samplePath: string;
  runSummaryPath: string;
  manifestPath: string;
  runCount: number;
};

const defaultOutputDir = (benchmarkId: string, root = path.join('output', 'benchmarks')) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), root, `${benchmarkId}-${stamp}`);
};

const cloneCommandEvents = (events: EngineFrameEvent[]) => events.map(event => ({
  ...event,
  command: { ...event.command },
}));

const averageMetrics = (
  samples: EngineEvalMetrics[],
  fallback: EngineEvalMetrics,
  exactPostWarmup: EngineEvalMetrics,
): EngineEvalMetrics => {
  if (samples.length === 0) return fallback;
  const result = { ...fallback } as Record<string, number>;
  const timeStateMetrics: (keyof EngineEvalMetrics)[] = [
    'avgAoISec',
    'p90AoISec',
    'avgScanRateHz',
    'avgRevisitIntervalSec',
  ];
  for (const key of timeStateMetrics) {
    const validSamples = key === 'trackingRMSEm' || key === 'p90TrackingErrorM' || key === 'trackContinuity'
      ? samples.filter(sample => sample.trackTruePositives > 0)
      : samples;
    if (validSamples.length > 0) {
      result[key] = validSamples.reduce((sum, sample) => sum + sample[key], 0) / validSamples.length;
    }
  }
  const exactTrackingMetrics: (keyof EngineEvalMetrics)[] = [
    'trackingRMSEm',
    'p90TrackingErrorM',
    'trackingRate',
    'trackTruePositives',
    'falseTracks',
    'missedTracks',
    'idSwitches',
    'trackFragmentations',
    'strictTrackAccuracy',
    'localTrackAccuracy',
    'strictIdentityTracks',
    'localIdentityTracks',
    'identityTrackOpportunities',
    'gospa',
    'gospaLocalization',
    'gospaMissed',
    'gospaFalse',
    'trackContinuity',
  ];
  for (const key of exactTrackingMetrics) result[key] = exactPostWarmup[key];
  result.timestamp = fallback.timestamp;
  return result as unknown as EngineEvalMetrics;
};

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
};

export class HeadlessRunner {
  async run(rawConfig: BenchmarkConfig, simulatorState: SimulatorState): Promise<HeadlessBenchmarkResult> {
    const config = resolveBenchmarkConfig(rawConfig);
    const outputDir = path.resolve(
      config.outputDir ?? defaultOutputDir(config.benchmarkId, config.experimentOutputRoot)
    );
    const recorder = new MetricsRecorder(outputDir);
    const sensorParams = SENSOR_PROFILES[config.sensorProfile];
    let runCount = 0;

    const strategyImplementations = new Map<string, StrategyImplementation>();

    const runScenario = async (scenario: BenchmarkScenario, seed: number) => {
      for (const strategy of config.strategies) {
        const implementation = await this.runOne({
          config,
          scenario,
          strategy,
          seed,
          simulatorState,
          recorder,
        });
        strategyImplementations.set(strategy, implementation);
        runCount += 1;
      }
    };

    for (const scenarioName of config.scenarios) {
      for (const seed of config.seeds) {
        await runScenario(makeBenchmarkScenario(scenarioName, seed), seed);
      }
    }

    for (const movementModel of config.movementModels) {
      for (const swimmerCount of config.swimmerCounts) {
        for (const seed of config.seeds) {
          if (config.sonarFailureModes.length === 0) {
            await runScenario(
              makePopulationBenchmarkScenario(movementModel, swimmerCount, seed, config.restFraction),
              seed
            );
          } else {
            for (const sonarFailureMode of config.sonarFailureModes) {
              await runScenario(
                makePopulationBenchmarkScenario(movementModel, swimmerCount, seed, config.restFraction, {
                  sonarCount: config.sonarCount,
                  sonarFailureMode,
                  sonarFailureStartSec: config.sonarFailureStartSec,
                  sonarFailureDurationSec: config.sonarFailureDurationSec,
                }),
                seed
              );
            }
          }
        }
      }
    }

    recorder.writeManifest({
      config,
      outputLabel: config.outputLabel,
      simulatorState,
      sensorProfile: config.sensorProfile,
      sensorParams,
      strategyImplementations: Object.fromEntries(strategyImplementations),
      generatedAt: new Date().toISOString(),
      note: 'Stage 5A synthetic benchmark output only; not calibrated against real sonar data.',
    });

    return {
      outputDir,
      samplePath: recorder.samplePath,
      runSummaryPath: recorder.runSummaryPath,
      manifestPath: recorder.manifestPath,
      runCount,
    };
  }

  private async runOne(opts: {
    config: ReturnType<typeof resolveBenchmarkConfig>;
    scenario: BenchmarkScenario;
    strategy: string;
    seed: number;
    simulatorState: SimulatorState;
    recorder: MetricsRecorder;
  }): Promise<StrategyImplementation> {
    const { config, scenario, strategy, seed, simulatorState, recorder } = opts;
    const sensorParams = SENSOR_PROFILES[config.sensorProfile];
    const engine = new SimulationEngine({
      strategy,
      comparisonRole: 'CANDIDATE',
      evalSeed: seed,
      sonarCount: config.sonarCount,
      tdmaEnabled: config.tdmaEnabled,
    });
    resetEngineToBenchmarkScenario(engine, scenario, sensorParams);

    const provider = createHeadlessStrategyProvider(strategy, () => engine.swimmers.map(swimmer => ({
      truthId: swimmer.id,
      position: { ...swimmer.position },
      velocity: { ...swimmer.velocity },
    })));
    const metadata: BenchmarkRunMetadata = {
      experimentId: config.experimentId,
      benchmarkId: config.benchmarkId,
      outputLabel: config.outputLabel,
      scenario: scenario.name,
      movementModel: scenario.movementModel,
      swimmerCount: scenario.swimmerCount,
      restingSwimmerCount: scenario.restingSwimmerCount,
      sonarFailureMode: scenario.sonarFailureMode,
      failedSonarIds: scenario.failedSonarIds,
      sonarFailureStartSec: scenario.sonarFailureStartSec,
      sonarFailureEndSec: scenario.sonarFailureEndSec,
      strategy,
      seed,
      durationSec: config.durationSec,
      sonarCount: config.sonarCount,
      tdmaEnabled: config.tdmaEnabled,
      sensorProfile: config.sensorProfile,
      sensorParams,
      simulatorState,
      strategyImplementation: provider.metadata,
    };

    let nextStrategyUpdate = 0;
    let nextSample = 0;
    let nextEventIndex = 0;
    let sampleEvents: EngineFrameEvent[] = [];
    let sampleDecisions: StrategyDecision[] = [];
    const decisionLatenciesMs: number[] = [];
    let totalScanCommands = 0;
    let totalDetections = 0;
    let totalMatchedDetections = 0;
    let totalFalseAlarms = 0;
    let totalBeams = 0;
    let totalBusySonarSec = 0;
    let totalScanWidthDeg = 0;
    let searchCoverageWidthDeg = 0;
    let fullScanCommands = 0;
    let trackRoiCommands = 0;
    let searchCommands = 0;
    let strategyActivationTimeSec: number | null = null;
    const postWarmupMetricSamples: EngineEvalMetrics[] = [];
    const timing = new SonarTimingModel();

    try {
      while (engine.time < config.durationSec) {
        while (
          nextEventIndex < scenario.events.length &&
          scenario.events[nextEventIndex].timeSec <= engine.time
        ) {
          applyBenchmarkScenarioEvent(engine, scenario.events[nextEventIndex]);
          nextEventIndex += 1;
        }

        if (engine.time >= nextStrategyUpdate) {
          const startedAt = performance.now();
          const decision = await provider.plan(engine.getStrategySnapshot());
          decisionLatenciesMs.push(performance.now() - startedAt);
          sampleDecisions.push(decision);
          engine.applyStrategyDecision(decision);
          nextStrategyUpdate += config.strategyUpdateIntervalSec;
        }

        const dt = Math.min(config.dtSec, config.durationSec - engine.time);
        const events = engine.update(dt, { autoSchedule: false });
        sampleEvents.push(...events);
        totalScanCommands += events.length;
        totalDetections += events.reduce((sum, event) => sum + event.detectionCount, 0);
        totalMatchedDetections += events.reduce((sum, event) => sum + event.matchedDetectionCount, 0);
        totalFalseAlarms += events.reduce((sum, event) => sum + event.falseAlarmCount, 0);
        for (const event of events) {
          totalBeams += timing.beamCount(event.command);
          totalBusySonarSec += timing.durationSec(event.command);
          const scanWidthDeg = timing.scanWindows(event.command).reduce(
            (sum, window) => sum + Math.abs(window.endLocalAngle - window.scanStartLocalAngle),
            0,
          );
          totalScanWidthDeg += scanWidthDeg;
          if (event.command.action === 'TRACK_ROI') {
            trackRoiCommands += 1;
            strategyActivationTimeSec ??= event.command.startTime;
          } else if (event.command.action === 'SEARCH_SECTOR') {
            searchCommands += 1;
            searchCoverageWidthDeg += scanWidthDeg;
          } else {
            fullScanCommands += 1;
            searchCoverageWidthDeg += scanWidthDeg;
          }
        }

        if (events.length > 0) {
          const startedAt = performance.now();
          const decision = await provider.plan(engine.getStrategySnapshot());
          decisionLatenciesMs.push(performance.now() - startedAt);
          sampleDecisions.push(decision);
          engine.applyStrategyDecision(decision);
        }

        if (engine.time >= nextSample) {
          const snapshot = engine.getStrategySnapshot();
          const sampleMetrics = engine.getEvalMetrics(config.metricsWindowSec);
          const warmup = engine.time < config.warmupSec;
          if (!warmup) postWarmupMetricSamples.push(sampleMetrics);
          recorder.recordSample({
            ...metadata,
            simTime: engine.time,
            truthCount: engine.swimmers.length,
            detectionCount: sampleEvents.reduce((sum, event) => sum + event.detectionCount, 0),
            falseAlarmCount: sampleEvents.reduce((sum, event) => sum + event.falseAlarmCount, 0),
            matchedDetectionCount: sampleEvents.reduce((sum, event) => sum + event.matchedDetectionCount, 0),
            trackCount: snapshot.tracks.length,
            scanCommands: cloneCommandEvents(sampleEvents).map(event => event.command),
            metrics: sampleMetrics,
            warmup,
            strategyActivated: strategyActivationTimeSec !== null,
            truth: engine.swimmers.map(swimmer => ({
              id: swimmer.id,
              position: { ...swimmer.position },
              velocity: { ...swimmer.velocity },
              enteredAt: swimmer.enteredAt,
            })),
            strategySnapshot: snapshot,
            strategyDecisions: sampleDecisions.map(decision => ({
              ...decision,
              plans: decision.plans.map(plan => ({ ...plan, assignedTargetIds: [...plan.assignedTargetIds] })),
            })),
          });
          sampleEvents = [];
          sampleDecisions = [];
          nextSample += config.sampleIntervalSec;
        }
      }

      const finalSnapshot = engine.getStrategySnapshot();
      const finalMetrics = engine.getEvalMetrics(config.durationSec);
      const exactPostWarmupMetrics = engine.getEvalMetrics(Math.max(config.dtSec, config.durationSec - config.warmupSec));
      const aggregateMetrics = averageMetrics(postWarmupMetricSamples, finalMetrics, exactPostWarmupMetrics);
      const commandDenominator = Math.max(1, totalScanCommands);
      recorder.recordRunSummary({
        ...metadata,
        finalMetrics,
        aggregateMetrics,
        totalScanCommands,
        totalDetections,
        totalMatchedDetections,
        totalFalseAlarms,
        finalTruthCount: engine.swimmers.length,
        finalTrackCount: finalSnapshot.tracks.length,
        strategyProviderInvocationCount: provider.invocationCount,
        commandMetrics: {
          strategyActivationTimeSec,
          commandRateHz: totalScanCommands / config.durationSec,
          frameRateHz: totalScanCommands / config.durationSec,
          beamRateHz: totalBeams / config.durationSec,
          sonarBusyRatio: Math.min(1, totalBusySonarSec / (config.durationSec * engine.sonars.length)),
          targetUpdateRateHz: finalMetrics.avgScanRateHz,
          fullScanCommandRatio: fullScanCommands / commandDenominator,
          trackRoiCommandRatio: trackRoiCommands / commandDenominator,
          searchCommandRatio: searchCommands / commandDenominator,
          searchCoverageRatio: totalScanWidthDeg > 0 ? searchCoverageWidthDeg / totalScanWidthDeg : 0,
          searchCoverageWidthDeg,
          totalScanWidthDeg,
          decisionLatencyMeanMs: decisionLatenciesMs.length
            ? decisionLatenciesMs.reduce((sum, value) => sum + value, 0) / decisionLatenciesMs.length
            : 0,
          decisionLatencyP95Ms: percentile(decisionLatenciesMs, 0.95),
        },
      });
      return provider.metadata;
    } finally {
      await provider.close();
    }
  }
}
