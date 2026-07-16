import {
  EngineEvalMetrics,
  EngineFrameEvent,
  SonarCommand,
  SonarCommandScanWindow,
  SonarFrame,
  SonarMode,
  SonarState,
  SonarStrategyPlan,
  SonarStrategyScanWindow,
  StrategyDecision,
  StrategySnapshot,
  StrategyType,
  Swimmer,
  TrackBelief,
  Detection,
  SwimmerTruth,
} from '../types';
import {
  AQUASCAN_DBSCAN_EPS_BINS,
  AQUASCAN_DBSCAN_MIN_PTS,
  IMAGING_RANGE_BINS,
  IMAGING_SPECKLE_PROB,
  IMAGING_THRESHOLD,
  PING360_MAX_RANGE_M,
  PING360_MIN_RANGE_M,
  POOL_LANE_COUNT,
  SCAN_STEP_ANGLE,
} from '../constants';
import { SimulationClock } from './sim/core/SimulationClock';
import {
  DEFAULT_SONAR_LAYOUT,
  makeSonarsByCount,
  normalizeSonarCount,
  normalizeSonarLayout,
  SonarLayoutName,
} from './sim/core/Scenario';
import { WorldState } from './sim/core/WorldState';
import { SonarTimingModel } from './sim/sonar/SonarTimingModel';
import { SonarCommandScheduler } from './sim/sonar/SonarCommandScheduler';
import { MeasurementModel, MeasurementParams } from './sim/sonar/MeasurementModel';
import { Detector } from './sim/perception/Detector';
import { Tracker } from './sim/perception/Tracker';
import { Evaluator } from './sim/evaluation/Evaluator';
import { StrategySnapshotBuilder } from './sim/strategy/StrategySnapshotBuilder';
import { localToWorldBearing } from './sim/sonar/SonarCoordinates';

export type EngineTuningParams = Omit<
  MeasurementParams,
  'rangeBins' | 'recoveryAngularStepDeg'
> & {
  threshold: number;
  dbscanEpsBins: number;
  dbscanMinPts: number;
  detectorMinClusterCells?: number;
  detectorMedianKernel?: number;
  detectorBoxBlurRadius?: number;
  detectorRobustNormalize?: boolean;
  detectorResolutionAware?: boolean;
  detectorNarrowSectorThreshold?: number;
  detectorPhysicalFilter?: boolean;
  trackerMissExistenceSurvival?: number;
};

export type EngineUpdateOptions = {
  autoSchedule?: boolean;
  /** Optional audit hook for exporting the exact simulated sonar frame. */
  onFrame?: (capture: {
    frame: SonarFrame;
    detections: Detection[];
    tracks: TrackBelief[];
    truthAtFrameEnd: SwimmerTruth[];
  }) => void;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const DEFAULT_ENGINE_TUNING: EngineTuningParams = {
  noiseScale: 0.30,
  speckleProb: IMAGING_SPECKLE_PROB,
  threshold: IMAGING_THRESHOLD,
  dbscanEpsBins: AQUASCAN_DBSCAN_EPS_BINS,
  dbscanMinPts: AQUASCAN_DBSCAN_MIN_PTS,
  detectorMinClusterCells: 0,
  detectorMedianKernel: 1,
  detectorBoxBlurRadius: 0,
  detectorRobustNormalize: false,
  detectorResolutionAware: false,
  detectorNarrowSectorThreshold: undefined,
  detectorPhysicalFilter: false,
  trackerMissExistenceSurvival: 0.78,
};

export class SimulationEngine {
  sonars: SonarState[] = [];
  swimmers: Swimmer[] = [];
  strategy: StrategyType = 'NAIVE';
  comparisonRole: 'BASELINE' | 'CANDIDATE' = 'BASELINE';
  time = 0;
  optimizedAssignments: Record<string, string[]> = {};

  private readonly evalSeed: number;
  private readonly tdmaEnabled: boolean;
  private sonarCount: number;
  private sonarLayout: SonarLayoutName;
  private poolLaneCount = POOL_LANE_COUNT;
  private readonly clock = new SimulationClock();
  private readonly timing = new SonarTimingModel();
  private readonly scheduler = new SonarCommandScheduler(this.timing);
  private readonly world: WorldState;
  private readonly measurement: MeasurementModel;
  private readonly detector: Detector;
  private readonly tracker = new Tracker();
  private readonly evaluator = new Evaluator();
  private readonly snapshotBuilder = new StrategySnapshotBuilder();

  private tuning: EngineTuningParams;
  private latestPlansBySonar = new Map<string, SonarStrategyPlan>();
  private commandCounter = 0;
  private _trackBeliefs: TrackBelief[] = [];
  private readonly coverageLastSeenBySonar = new Map<string, number[]>();

  constructor(opts?: {
    strategy?: StrategyType;
    comparisonRole?: 'BASELINE' | 'CANDIDATE';
    evalSeed?: number;
    tdmaEnabled?: boolean;
    sonarCount?: number;
    sonarLayout?: SonarLayoutName;
  }) {
    this.strategy = opts?.strategy ?? 'NAIVE';
    this.comparisonRole = opts?.comparisonRole ?? 'BASELINE';
    this.evalSeed = opts?.evalSeed ?? 1337;
    this.tdmaEnabled = opts?.tdmaEnabled ?? false;
    this.sonarCount = normalizeSonarCount(opts?.sonarCount);
    this.sonarLayout = normalizeSonarLayout(opts?.sonarLayout ?? DEFAULT_SONAR_LAYOUT);
    this.tuning = { ...DEFAULT_ENGINE_TUNING };
    this.world = new WorldState(this.evalSeed);
    this.measurement = new MeasurementModel(this.timing, this.evalSeed, {
      noiseScale: this.tuning.noiseScale,
      speckleProb: this.tuning.speckleProb,
    });
    this.detector = new Detector(this.evalSeed, {
      threshold: this.tuning.threshold,
      dbscanEpsBins: this.tuning.dbscanEpsBins,
      dbscanMinPts: this.tuning.dbscanMinPts,
      noiseScale: this.tuning.noiseScale,
      minClusterCells: this.tuning.detectorMinClusterCells,
      medianKernel: this.tuning.detectorMedianKernel,
      boxBlurRadius: this.tuning.detectorBoxBlurRadius,
      robustNormalize: this.tuning.detectorRobustNormalize,
      resolutionAware: this.tuning.detectorResolutionAware,
      narrowSectorThreshold: this.tuning.detectorNarrowSectorThreshold,
      physicalFilter: this.tuning.detectorPhysicalFilter,
    });
    this.tracker.configureMissExistenceSurvival(this.tuning.trackerMissExistenceSurvival ?? 0.78);
    this.reset();
  }

  setSonarCount(count: number) {
    const nextCount = normalizeSonarCount(count);
    if (nextCount === this.sonarCount) return;
    this.sonarCount = nextCount;
    this.reset();
  }

  setSonarLayout(layout: SonarLayoutName) {
    const nextLayout = normalizeSonarLayout(layout);
    if (nextLayout === this.sonarLayout) return;
    this.sonarLayout = nextLayout;
    this.reset();
  }

  setPoolLaneCount(count: number) {
    this.poolLaneCount = Number.isFinite(count)
      ? Math.max(1, Math.min(20, Math.floor(count)))
      : POOL_LANE_COUNT;
    this.measurement.setLaneCount(this.poolLaneCount);
  }

  setLaneConstrainedTracking(enabled: boolean) {
    this.tracker.configureLaneConstraint(enabled, this.poolLaneCount);
  }

  getPoolLaneCount() {
    return this.poolLaneCount;
  }

  setTuningProfile(next: EngineTuningParams) {
    this.tuning = { ...DEFAULT_ENGINE_TUNING, ...next };
    this.normalizeTuning();
    this.applyTuning();
  }

  setTuningParams(next: Partial<EngineTuningParams>) {
    this.tuning = { ...this.tuning, ...next };
    this.normalizeTuning();
    this.applyTuning();
  }

  private normalizeTuning() {
    this.tuning.noiseScale = clamp(this.tuning.noiseScale, 0, 5);
    this.tuning.speckleProb = clamp(this.tuning.speckleProb, 0, 0.5);
    this.tuning.threshold = clamp(this.tuning.threshold, 0, 10);
    this.tuning.dbscanEpsBins = clamp(this.tuning.dbscanEpsBins, 0.5, 12);
    this.tuning.dbscanMinPts = clamp(this.tuning.dbscanMinPts, 2, 200);
    this.tuning.detectorMinClusterCells = Math.floor(clamp(this.tuning.detectorMinClusterCells ?? 0, 0, 5000));
    const medianKernel = Math.floor(clamp(this.tuning.detectorMedianKernel ?? 1, 1, 7));
    this.tuning.detectorMedianKernel = medianKernel % 2 === 0 ? Math.max(1, medianKernel - 1) : medianKernel;
    this.tuning.detectorBoxBlurRadius = Math.floor(clamp(this.tuning.detectorBoxBlurRadius ?? 0, 0, 4));
    this.tuning.detectorRobustNormalize = Boolean(this.tuning.detectorRobustNormalize);
    this.tuning.detectorResolutionAware = Boolean(this.tuning.detectorResolutionAware);
    this.tuning.detectorNarrowSectorThreshold = this.tuning.detectorNarrowSectorThreshold === undefined
      ? undefined
      : clamp(this.tuning.detectorNarrowSectorThreshold, 0, 10);
    this.tuning.detectorPhysicalFilter = Boolean(this.tuning.detectorPhysicalFilter);
    this.tuning.trackerMissExistenceSurvival = clamp(
      this.tuning.trackerMissExistenceSurvival ?? 0.78,
      0,
      1
    );
  }

  private applyTuning() {
    this.measurement.replaceParams(this.tuning);
    this.detector.setParams({
      threshold: this.tuning.threshold,
      dbscanEpsBins: this.tuning.dbscanEpsBins,
      dbscanMinPts: this.tuning.dbscanMinPts,
      noiseScale: this.tuning.noiseScale,
      minClusterCells: this.tuning.detectorMinClusterCells,
      medianKernel: this.tuning.detectorMedianKernel,
      boxBlurRadius: this.tuning.detectorBoxBlurRadius,
      robustNormalize: this.tuning.detectorRobustNormalize,
      resolutionAware: this.tuning.detectorResolutionAware,
      narrowSectorThreshold: this.tuning.detectorNarrowSectorThreshold,
      physicalFilter: this.tuning.detectorPhysicalFilter,
    });
    this.tracker.configureMissExistenceSurvival(this.tuning.trackerMissExistenceSurvival ?? 0.78);
  }

  reset() {
    this.clock.reset();
    this.time = 0;
    this.sonars = makeSonarsByCount(this.sonarCount, this.sonarLayout);
    this.world.reset();
    this.swimmers = this.world.swimmers;
    this.scheduler.reset();
    this.tracker.reset();
    this.evaluator.reset();
    this.latestPlansBySonar.clear();
    this._trackBeliefs = [];
    this.optimizedAssignments = {};
    this.commandCounter = 0;
    this.coverageLastSeenBySonar.clear();
    for (const sonar of this.sonars) {
      this.coverageLastSeenBySonar.set(sonar.id, Array.from({ length: 18 }, () => 0));
    }
    this.syncSonarRuntimeStates();
  }

  addSwimmer(swimmer?: Swimmer) {
    const truth = swimmer
      ? this.world.addSwimmer(swimmer, this.time)
      : this.world.addRandomSwimmer(this.time);
    this.swimmers = this.world.swimmers;
    this.evaluator.registerTruth(truth);
    return truth;
  }

  removeSwimmer() {
    const removed = this.world.removeLast();
    if (removed) this.evaluator.removeTruth(removed.truthId);
    this.swimmers = this.world.swimmers;
    return removed;
  }

  removeSwimmerById(id: string) {
    const removed = this.world.removeById(id);
    if (!removed) return false;
    this.evaluator.removeTruth(removed.truthId);
    this.swimmers = this.world.swimmers;
    return true;
  }

  setSonarAvailable(sonarId: string, available: boolean) {
    const sonar = this.sonars.find(item => item.id === sonarId);
    if (!sonar) return false;
    sonar.available = available;
    if (!available) {
      this.scheduler.cancel(sonarId);
      sonar.mode = SonarMode.IDLE;
      sonar.activeCommandId = undefined;
    }
    this.syncSonarRuntimeStates();
    return true;
  }

  getStrategySnapshot(): StrategySnapshot {
    return this.snapshotBuilder.build({
      time: this.time,
      seed: this.evalSeed,
      sonars: this.sonars,
      tracks: this._trackBeliefs,
      coverageLastSeenBySonar: this.coverageLastSeenBySonar,
      tdmaSlotCount: this.tdmaEnabled ? Math.max(1, this.sonars.filter(sonar => sonar.available).length) : 1,
    });
  }

  applyStrategyDecision(decision: StrategyDecision) {
    if (decision.strategy !== this.strategy) return;

    const nextAssignments: Record<string, string[]> = {};
    for (const sonar of this.sonars) {
      const raw = decision.plans.find(plan => plan.sonarId === sonar.id);
      const plan = raw ? this.normalizePlan(sonar, raw) : this.fullScanPlan(sonar);
      this.latestPlansBySonar.set(sonar.id, plan);
      nextAssignments[sonar.id] = [...plan.assignedTargetIds];
    }
    this.optimizedAssignments = nextAssignments;
    this.ensureCommands();
    this.syncSonarRuntimeStates();
  }

  update(dt: number, opts: EngineUpdateOptions = {}): EngineFrameEvent[] {
    const autoSchedule = opts.autoSchedule ?? true;
    this.time = this.clock.step(dt);
    this.world.step(dt, this.time);
    this.swimmers = this.world.swimmers;

    if (autoSchedule) this.ensureCommands();
    const completed = this.scheduler.advance(this.time);
    const frameEvents: EngineFrameEvent[] = [];
    const completedFrames: {
      command: SonarCommand;
      sonar: SonarState;
      frame: ReturnType<MeasurementModel['buildFrame']>;
      detections: ReturnType<Detector['detect']>;
    }[] = [];

    for (const command of completed) {
      const sonar = this.sonars.find(s => s.id === command.sonarId);
      if (!sonar) continue;

      // Commit the exact mechanical endpoint before the scheduler forgets the
      // command. This is required for deterministic 0->180->0 and ROI bouncing,
      // especially when a headless dt crosses the completion timestamp.
      sonar.currentLocalAngle = command.endLocalAngle;
      sonar.currentAngle = localToWorldBearing(sonar, command.endLocalAngle);
      sonar.targetLocalAngle = command.endLocalAngle;
      sonar.targetAngle = sonar.currentAngle;
      sonar.scanDirection = command.endLocalAngle >= command.scanStartLocalAngle ? -1 : 1;
      sonar.activeScanMinLocalAngle = command.scanMinLocalAngle;
      sonar.activeScanMaxLocalAngle = command.scanMaxLocalAngle;

      const frame = this.measurement.buildFrame(sonar, command, time => this.world.sampleAt(time));
      const detections = this.detector.detect(frame, sonar);
      this.recordCoverage(frame.sonarId, frame.beams.map(beam => beam.localAngle), frame.endTime);
      completedFrames.push({ command, sonar, frame, detections });
    }

    if (completedFrames.length > 0) {
      const fusionTime = Math.max(...completedFrames.map(item => item.frame.endTime));
      this._trackBeliefs = this.tracker.update(
        fusionTime,
        // Associate raw per-frame detections first. The Tracker may then
        // sequentially absorb observations from different sonars into the
        // same belief without ever averaging two nearby swimmers together.
        completedFrames.flatMap(item => item.detections),
        completedFrames.map(item => item.frame)
      );
    }

    for (const { command, sonar, frame, detections } of completedFrames) {
      const truthAtFrameEnd = this.world.sampleAt(frame.endTime);
      const evalResult = this.evaluator.recordFrame(
        frame,
        detections,
        truthAtFrameEnd,
        this._trackBeliefs,
        time => this.world.sampleAt(time)
      );
      opts.onFrame?.({
        frame,
        detections,
        tracks: this._trackBeliefs,
        truthAtFrameEnd,
      });

      sonar.lastScanTime = frame.endTime;
      sonar.cycleDuration = frame.endTime - frame.startTime;
      sonar.detectedPoints.push(...detections.map(d => d.position));
      if (sonar.detectedPoints.length > 15) sonar.detectedPoints.splice(0, sonar.detectedPoints.length - 15);
      sonar.matchedPoints.push(...evalResult.matchedDetections.map(d => d.position));
      if (sonar.matchedPoints.length > 15) sonar.matchedPoints.splice(0, sonar.matchedPoints.length - 15);

      frameEvents.push({
        time: frame.endTime,
        sonarId: command.sonarId,
        command: { ...command },
        truthCount: this.world.swimmers.length,
        detectionCount: detections.length,
        matchedDetectionCount: evalResult.matchedDetections.length,
        falseAlarmCount: evalResult.annotatedDetections.filter(d => d.source === 'false_alarm').length,
        trackCount: this._trackBeliefs.filter(track => track.status !== 'lost').length,
      });
    }

    this._trackBeliefs = this.tracker.getBeliefs(this.time);
    this.evaluator.recordTrackState(this.time, this.world.sampleAt(this.time), this._trackBeliefs);
    this.syncSonarRuntimeStates();
    return frameEvents;
  }

  getEvalMetrics(windowSec = 10): EngineEvalMetrics {
    return this.evaluator.metrics(this.time, this.world.swimmers, this.sonars.length, windowSec);
  }

  get trackBeliefs(): TrackBelief[] {
    return this._trackBeliefs;
  }

  ensureCommands() {
    for (const sonar of this.sonars) {
      if (!sonar.available) continue;
      if (this.scheduler.isBusy(sonar.id)) continue;
      const plan = this.latestPlansBySonar.get(sonar.id) ?? this.fullScanPlan(sonar);
      this.scheduler.submit(this.commandFromPlan(sonar, plan));
    }
  }

  private commandFromPlan(sonar: SonarState, plan: SonarStrategyPlan): SonarCommand {
    const sectorMin = clamp(plan.minLocalAngle, sonar.minLocalAngle, sonar.maxLocalAngle);
    const sectorMax = clamp(plan.maxLocalAngle, sonar.minLocalAngle, sonar.maxLocalAngle);

    const currentLocalAngle = sonar.currentLocalAngle;
    const angularStepDeg = clamp(plan.angularStepDeg ?? SCAN_STEP_ANGLE, 0.1, 6.0);
    const scanWindows = this.commandWindowsFromPlan(sonar, plan, currentLocalAngle);
    if (scanWindows.length > 0) {
      const firstWindow = scanWindows[0];
      const lastWindow = scanWindows[scanWindows.length - 1];
      return {
        commandId: `${this.comparisonRole}:${sonar.id}:${++this.commandCounter}`,
        sonarId: sonar.id,
        startLocalAngle: currentLocalAngle,
        scanStartLocalAngle: firstWindow.scanStartLocalAngle,
        endLocalAngle: lastWindow.endLocalAngle,
        scanMinLocalAngle: Math.min(...scanWindows.map(window => window.scanMinLocalAngle)),
        scanMaxLocalAngle: Math.max(...scanWindows.map(window => window.scanMaxLocalAngle)),
        range: Math.max(...scanWindows.map(window => window.range)),
        angularStepDeg,
        samplesPerBeam: IMAGING_RANGE_BINS,
        pingSlotCount: this.tdmaEnabled ? Math.max(1, this.sonars.filter(item => item.available).length) : 1,
        startTime: this.time,
        action: plan.action,
        assignedTargetIds: plan.assignedTargetIds,
        scanWindows,
      };
    }

    let scanStartLocalAngle: number;
    let endLocalAngle: number;

    if (currentLocalAngle < sectorMin || currentLocalAngle > sectorMax) {
      const distMin = Math.abs(currentLocalAngle - sectorMin);
      const distMax = Math.abs(currentLocalAngle - sectorMax);
      if (distMin <= distMax) {
        scanStartLocalAngle = sectorMin;
        endLocalAngle = sectorMax;
      } else {
        scanStartLocalAngle = sectorMax;
        endLocalAngle = sectorMin;
      }
    } else {
      scanStartLocalAngle = currentLocalAngle;
      if (sonar.scanDirection >= 0) {
        endLocalAngle = sectorMax;
      } else {
        endLocalAngle = sectorMin;
      }
    }

    if (Math.abs(endLocalAngle - scanStartLocalAngle) < 1) {
      endLocalAngle = clamp(scanStartLocalAngle + sonar.scanDirection * 10, sectorMin, sectorMax);
      if (Math.abs(endLocalAngle - scanStartLocalAngle) < 1) {
        scanStartLocalAngle = sectorMin;
        endLocalAngle = sectorMax;
      }
    }

    return {
      commandId: `${this.comparisonRole}:${sonar.id}:${++this.commandCounter}`,
      sonarId: sonar.id,
      startLocalAngle: currentLocalAngle,
      scanStartLocalAngle,
      endLocalAngle,
      scanMinLocalAngle: Math.min(scanStartLocalAngle, endLocalAngle),
      scanMaxLocalAngle: Math.max(scanStartLocalAngle, endLocalAngle),
      range: plan.range,
      angularStepDeg,
      samplesPerBeam: IMAGING_RANGE_BINS,
      pingSlotCount: this.tdmaEnabled ? Math.max(1, this.sonars.filter(item => item.available).length) : 1,
      startTime: this.time,
      action: plan.action,
      assignedTargetIds: plan.assignedTargetIds,
    };
  }

  private commandWindowsFromPlan(
    sonar: SonarState,
    plan: SonarStrategyPlan,
    currentLocalAngle: number
  ): SonarCommandScanWindow[] {
    const rawWindows = plan.scanWindows ?? [];
    const normalized = rawWindows
      .map(window => this.normalizeScanWindow(sonar, plan, window))
      .filter((window): window is Required<SonarStrategyScanWindow> => window !== null);
    if (normalized.length === 0) return [];

    const ascending = [...normalized]
      .sort((a, b) => a.minLocalAngle - b.minLocalAngle)
      .map(window => ({
        scanStartLocalAngle: window.minLocalAngle,
        endLocalAngle: window.maxLocalAngle,
        scanMinLocalAngle: window.minLocalAngle,
        scanMaxLocalAngle: window.maxLocalAngle,
        range: window.range,
        assignedTargetIds: window.assignedTargetIds,
      }));
    const descending = [...normalized]
      .sort((a, b) => b.maxLocalAngle - a.maxLocalAngle)
      .map(window => ({
        scanStartLocalAngle: window.maxLocalAngle,
        endLocalAngle: window.minLocalAngle,
        scanMinLocalAngle: window.minLocalAngle,
        scanMaxLocalAngle: window.maxLocalAngle,
        range: window.range,
        assignedTargetIds: window.assignedTargetIds,
      }));

    if (currentLocalAngle >= plan.minLocalAngle && currentLocalAngle <= plan.maxLocalAngle) {
      return sonar.scanDirection >= 0 ? ascending : descending;
    }
    const ascendingSlew = Math.abs(currentLocalAngle - ascending[0].scanStartLocalAngle);
    const descendingSlew = Math.abs(currentLocalAngle - descending[0].scanStartLocalAngle);
    return ascendingSlew <= descendingSlew ? ascending : descending;
  }

  private normalizeScanWindow(
    sonar: SonarState,
    plan: SonarStrategyPlan,
    raw: SonarStrategyScanWindow
  ): Required<SonarStrategyScanWindow> | null {
    const minLocalAngle = clamp(raw.minLocalAngle, sonar.minLocalAngle, sonar.maxLocalAngle);
    const maxLocalAngle = clamp(raw.maxLocalAngle, sonar.minLocalAngle, sonar.maxLocalAngle);
    if (Math.abs(maxLocalAngle - minLocalAngle) < 1) return null;
    const lo = Math.min(minLocalAngle, maxLocalAngle);
    const hi = Math.max(minLocalAngle, maxLocalAngle);
    return {
      minLocalAngle: lo,
      maxLocalAngle: hi,
      range: clamp(raw.range ?? plan.range, PING360_MIN_RANGE_M, PING360_MAX_RANGE_M),
      assignedTargetIds: Array.isArray(raw.assignedTargetIds) ? [...raw.assignedTargetIds] : [],
    };
  }

  private normalizePlan(sonar: SonarState, raw: SonarStrategyPlan): SonarStrategyPlan {
    const minLocalAngle = clamp(raw.minLocalAngle, sonar.minLocalAngle, sonar.maxLocalAngle);
    const maxLocalAngle = clamp(raw.maxLocalAngle, sonar.minLocalAngle, sonar.maxLocalAngle);
    const width = Math.abs(maxLocalAngle - minLocalAngle);
    if (width < 1) {
      return {
        sonarId: sonar.id,
        minLocalAngle: sonar.minLocalAngle,
        maxLocalAngle: sonar.maxLocalAngle,
        range: clamp(raw.range, PING360_MIN_RANGE_M, PING360_MAX_RANGE_M),
        angularStepDeg: Number.isFinite(raw.angularStepDeg)
          ? clamp(raw.angularStepDeg ?? SCAN_STEP_ANGLE, 0.1, 6.0)
          : undefined,
        assignedTargetIds: Array.isArray(raw.assignedTargetIds) ? [...raw.assignedTargetIds] : [],
        action: raw.action,
      };
    }

    return {
      sonarId: sonar.id,
      minLocalAngle,
      maxLocalAngle,
      range: clamp(raw.range, PING360_MIN_RANGE_M, PING360_MAX_RANGE_M),
      angularStepDeg: Number.isFinite(raw.angularStepDeg)
        ? clamp(raw.angularStepDeg ?? SCAN_STEP_ANGLE, 0.1, 6.0)
        : undefined,
      assignedTargetIds: Array.isArray(raw.assignedTargetIds) ? [...raw.assignedTargetIds] : [],
      action: raw.action,
      scanWindows: Array.isArray(raw.scanWindows)
        ? raw.scanWindows
          .map(window => this.normalizeScanWindow(sonar, {
            sonarId: sonar.id,
            minLocalAngle,
            maxLocalAngle,
            range: clamp(raw.range, PING360_MIN_RANGE_M, PING360_MAX_RANGE_M),
            angularStepDeg: Number.isFinite(raw.angularStepDeg)
              ? clamp(raw.angularStepDeg ?? SCAN_STEP_ANGLE, 0.1, 6.0)
              : undefined,
            assignedTargetIds: [],
            action: raw.action,
          }, window))
          .filter((window): window is Required<SonarStrategyScanWindow> => window !== null)
        : undefined,
    };
  }

  private fullScanPlan(sonar: SonarState): SonarStrategyPlan {
    return {
      sonarId: sonar.id,
      minLocalAngle: sonar.minLocalAngle,
      maxLocalAngle: sonar.maxLocalAngle,
      range: PING360_MAX_RANGE_M,
      assignedTargetIds: [],
      action: 'FULL_SWEEP',
    };
  }

  private syncSonarRuntimeStates() {
    const active = new Map(this.scheduler.snapshot(this.time).map(item => [item.command.sonarId, item]));
    for (const sonar of this.sonars) {
      const item = active.get(sonar.id);
      if (!item) {
        sonar.mode = SonarMode.IDLE;
        sonar.activeCommandId = undefined;
        sonar.activeCommandStartedAt = undefined;
        sonar.activeCommandEndsAt = undefined;
        sonar.commandProgress = 0;

        const scanMin = sonar.activeScanMinLocalAngle ?? sonar.minLocalAngle;
        const scanMax = sonar.activeScanMaxLocalAngle ?? sonar.maxLocalAngle;
        if (Math.abs(sonar.currentLocalAngle - scanMax) < 1) {
          sonar.scanDirection = -1;
        } else if (Math.abs(sonar.currentLocalAngle - scanMin) < 1) {
          sonar.scanDirection = 1;
        }
        continue;
      }

      const { command, endTime, progress } = item;
      const mechanicalState = this.timing.mechanicalState(command, this.time);
      sonar.currentLocalAngle = mechanicalState.localAngle;

      sonar.currentAngle = localToWorldBearing(sonar, sonar.currentLocalAngle);
      sonar.mode = mechanicalState.scanning ? SonarMode.SCANNING : SonarMode.SLEWING;
      sonar.scanRange = command.range;
      sonar.targetLocalAngle = command.endLocalAngle;
      sonar.targetAngle = localToWorldBearing(sonar, command.endLocalAngle);
      sonar.scanDirection = command.endLocalAngle >= command.scanStartLocalAngle ? 1 : -1;
      sonar.activeCommandId = command.commandId;
      sonar.activeCommandStartedAt = command.startTime;
      sonar.activeCommandEndsAt = endTime;
      sonar.commandProgress = progress;
      sonar.activeAction = command.action;
      sonar.activeScanMinLocalAngle = command.scanMinLocalAngle;
      sonar.activeScanMaxLocalAngle = command.scanMaxLocalAngle;
      sonar.assignedTargetIds = command.assignedTargetIds ?? [];
    }
  }

  private recordCoverage(sonarId: string, localAngles: number[], observedAt: number) {
    const bins = this.coverageLastSeenBySonar.get(sonarId);
    const sonar = this.sonars.find(item => item.id === sonarId);
    if (!bins || !sonar || bins.length === 0) return;
    const span = Math.max(1e-6, sonar.maxLocalAngle - sonar.minLocalAngle);
    for (const localAngle of localAngles) {
      const fraction = (localAngle - sonar.minLocalAngle) / span;
      const index = Math.max(0, Math.min(bins.length - 1, Math.floor(fraction * bins.length)));
      bins[index] = Math.max(bins[index], observedAt);
    }
  }
}
