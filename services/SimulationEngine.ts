import {
  EngineEvalMetrics,
  EngineFrameEvent,
  SonarCommand,
  SonarCommandScanWindow,
  SonarMode,
  SonarState,
  SonarStrategyPlan,
  SonarStrategyScanWindow,
  StrategyDecision,
  StrategySnapshot,
  StrategyType,
  Swimmer,
  TrackBelief,
} from '../types';
import {
  AQUASCAN_DBSCAN_EPS_BINS,
  AQUASCAN_DBSCAN_MIN_PTS,
  AQUASCAN_KERNEL_CAP,
  IMAGING_RANGE_BINS,
  IMAGING_SPECKLE_PROB,
  IMAGING_THRESHOLD,
  MAX_RANGE_NAIVE,
  SCAN_STEP_ANGLE,
} from '../constants';
import { SimulationClock } from './sim/core/SimulationClock';
import { makeSonarsByCount, normalizeSonarCount } from './sim/core/Scenario';
import { WorldState } from './sim/core/WorldState';
import { SonarTimingModel } from './sim/sonar/SonarTimingModel';
import { SonarCommandScheduler } from './sim/sonar/SonarCommandScheduler';
import { MeasurementModel } from './sim/sonar/MeasurementModel';
import { Detector } from './sim/perception/Detector';
import { Tracker } from './sim/perception/Tracker';
import { fuseMultiSonarDetections } from './sim/perception/MultiSonarFusion';
import { Evaluator } from './sim/evaluation/Evaluator';
import { StrategySnapshotBuilder } from './sim/strategy/StrategySnapshotBuilder';
import { localToWorldBearing } from './sim/sonar/SonarCoordinates';

export type EngineTuningParams = {
  noiseScale: number;
  speckleProb: number;
  threshold: number;
  dbscanEpsBins: number;
  dbscanMinPts: number;
  kernelCap: number;
};

export type EngineUpdateOptions = {
  autoSchedule?: boolean;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  }) {
    this.strategy = opts?.strategy ?? 'NAIVE';
    this.comparisonRole = opts?.comparisonRole ?? 'BASELINE';
    this.evalSeed = opts?.evalSeed ?? 1337;
    this.tdmaEnabled = opts?.tdmaEnabled ?? false;
    this.sonarCount = normalizeSonarCount(opts?.sonarCount);
    this.tuning = {
      noiseScale: 0.30,
      speckleProb: IMAGING_SPECKLE_PROB,
      threshold: IMAGING_THRESHOLD,
      dbscanEpsBins: AQUASCAN_DBSCAN_EPS_BINS,
      dbscanMinPts: AQUASCAN_DBSCAN_MIN_PTS,
      kernelCap: AQUASCAN_KERNEL_CAP,
    };
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
      kernelCap: this.tuning.kernelCap,
    });
    this.reset();
  }

  setSonarCount(count: number) {
    const nextCount = normalizeSonarCount(count);
    if (nextCount === this.sonarCount) return;
    this.sonarCount = nextCount;
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
    this.measurement.setParams({
      noiseScale: merged.noiseScale,
      speckleProb: merged.speckleProb,
    });
    this.detector.setParams({
      threshold: merged.threshold,
      dbscanEpsBins: merged.dbscanEpsBins,
      dbscanMinPts: merged.dbscanMinPts,
      noiseScale: merged.noiseScale,
      kernelCap: merged.kernelCap,
    });
  }

  reset() {
    this.clock.reset();
    this.time = 0;
    this.sonars = makeSonarsByCount(this.sonarCount);
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
      const fused = fuseMultiSonarDetections(completedFrames.flatMap(item => item.detections), fusionTime);
      this._trackBeliefs = this.tracker.update(
        fusionTime,
        fused,
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
      range: clamp(raw.range ?? plan.range, 1, MAX_RANGE_NAIVE),
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
        range: clamp(raw.range, 1, MAX_RANGE_NAIVE),
        angularStepDeg: Number.isFinite(raw.angularStepDeg) ? clamp(raw.angularStepDeg ?? SCAN_STEP_ANGLE, 0.1, 6.0) : undefined,
        assignedTargetIds: Array.isArray(raw.assignedTargetIds) ? [...raw.assignedTargetIds] : [],
        action: raw.action,
      };
    }

    return {
      sonarId: sonar.id,
      minLocalAngle,
      maxLocalAngle,
      range: clamp(raw.range, 1, MAX_RANGE_NAIVE),
      angularStepDeg: Number.isFinite(raw.angularStepDeg) ? clamp(raw.angularStepDeg ?? SCAN_STEP_ANGLE, 0.1, 6.0) : undefined,
      assignedTargetIds: Array.isArray(raw.assignedTargetIds) ? [...raw.assignedTargetIds] : [],
      action: raw.action,
      scanWindows: Array.isArray(raw.scanWindows)
        ? raw.scanWindows
          .map(window => this.normalizeScanWindow(sonar, {
            sonarId: sonar.id,
            minLocalAngle,
            maxLocalAngle,
            range: clamp(raw.range, 1, MAX_RANGE_NAIVE),
            angularStepDeg: Number.isFinite(raw.angularStepDeg) ? clamp(raw.angularStepDeg ?? SCAN_STEP_ANGLE, 0.1, 6.0) : undefined,
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
      range: MAX_RANGE_NAIVE,
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
