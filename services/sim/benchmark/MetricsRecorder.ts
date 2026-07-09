import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EngineEvalMetrics, EngineFrameEvent, StrategyDecision, StrategySnapshot, Swimmer } from '../../../types';
import { EngineTuningParams } from '../../SimulationEngine';
import { BenchmarkOutputLabel, PopulationMovementModel, SensorProfileName, SonarFailureMode } from './BenchmarkConfig';
import { StrategyImplementation } from '../strategy/StrategyProvider';

export type SimulatorState = {
  gitCommit: string;
  gitDirty: boolean;
  gitStatusShort: string;
};

export type BenchmarkRunMetadata = {
  experimentId?: string;
  benchmarkId: string;
  outputLabel: BenchmarkOutputLabel;
  scenario: string;
  movementModel?: PopulationMovementModel;
  swimmerCount?: number;
  restingSwimmerCount?: number;
  sonarFailureMode?: SonarFailureMode;
  failedSonarIds?: string[];
  sonarFailureStartSec?: number;
  sonarFailureEndSec?: number;
  strategy: string;
  seed: number;
  durationSec: number;
  sonarCount: number;
  tdmaEnabled: boolean;
  sensorProfile: SensorProfileName;
  sensorParams: EngineTuningParams;
  simulatorState: SimulatorState;
  strategyImplementation: StrategyImplementation;
};

export type BenchmarkSampleRow = BenchmarkRunMetadata & {
  simTime: number;
  truthCount: number;
  detectionCount: number;
  falseAlarmCount: number;
  matchedDetectionCount: number;
  trackCount: number;
  scanCommands: EngineFrameEvent['command'][];
  metrics: EngineEvalMetrics;
  warmup: boolean;
  strategyActivated: boolean;
  truth: Swimmer[];
  strategySnapshot: StrategySnapshot;
  strategyDecisions: StrategyDecision[];
};

export type CommandMetrics = {
  strategyActivationTimeSec: number | null;
  commandRateHz: number;
  frameRateHz: number;
  beamRateHz: number;
  sonarBusyRatio: number;
  targetUpdateRateHz: number;
  fullScanCommandRatio: number;
  trackRoiCommandRatio: number;
  searchCommandRatio: number;
  searchCoverageRatio: number;
  searchCoverageWidthDeg: number;
  totalScanWidthDeg: number;
  decisionLatencyMeanMs: number;
  decisionLatencyP95Ms: number;
};

export type BenchmarkRunSummary = BenchmarkRunMetadata & {
  finalMetrics: EngineEvalMetrics;
  aggregateMetrics: EngineEvalMetrics;
  totalScanCommands: number;
  totalDetections: number;
  totalMatchedDetections: number;
  totalFalseAlarms: number;
  finalTruthCount: number;
  finalTrackCount: number;
  strategyProviderInvocationCount: number;
  commandMetrics: CommandMetrics;
};

export class MetricsRecorder {
  readonly samplePath: string;
  readonly runSummaryPath: string;
  readonly manifestPath: string;

  constructor(readonly outputDir: string) {
    mkdirSync(outputDir, { recursive: true });
    this.samplePath = path.join(outputDir, 'samples.jsonl');
    this.runSummaryPath = path.join(outputDir, 'runs.jsonl');
    this.manifestPath = path.join(outputDir, 'manifest.json');
    writeFileSync(this.samplePath, '');
    writeFileSync(this.runSummaryPath, '');
  }

  writeManifest(manifest: unknown) {
    writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  recordSample(row: BenchmarkSampleRow) {
    appendFileSync(this.samplePath, `${JSON.stringify(row)}\n`);
  }

  recordRunSummary(row: BenchmarkRunSummary) {
    appendFileSync(this.runSummaryPath, `${JSON.stringify(row)}\n`);
  }
}
