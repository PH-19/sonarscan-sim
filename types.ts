export interface Vector2 {
  x: number;
  y: number;
}

export type SwimmerMotionKind = 'free_reflect' | 'lane_swim' | 'short_end_rest';

export interface SwimmerMotionProfile {
  kind: SwimmerMotionKind;
  laneX?: number;
  speedMps?: number;
  longDirection?: 1 | -1;
  lateralAmplitudeM?: number;
  lateralPeriodSec?: number;
  phaseSec?: number;
  restY?: number;
}

export interface Swimmer {
  id: string;
  position: Vector2;
  velocity: Vector2; // m/s
  enteredAt: number;
  motion?: SwimmerMotionProfile;
}

export interface SwimmerTruth extends Swimmer {
  // Hidden simulator truth. Strategy and tracker snapshots must never receive this id.
  truthId: string;
}

export enum SonarMode {
  IDLE = 'IDLE',
  SCANNING = 'SCANNING', // Emitting sound, waiting for return, slow rotation
  SLEWING = 'SLEWING',   // Rotating quickly to next sector, no emission
}

export interface SonarConfig {
  id: string;
  position: Vector2;
  angle: number; // World bearing of the mechanical sector centre, degrees.
  mountAngle: number; // World bearing of the mechanical sector centre (legacy name).
  mountYaw: number; // World bearing corresponding to local mechanical angle 0°.
  maxLocalAngle: number; // Local mechanical upper bound in degrees, normally 180°.
  minLocalAngle: number; // Local mechanical lower bound in degrees, normally 0°.
}

export interface SonarState extends SonarConfig {
  available: boolean;
  currentAngle: number; // Current world bearing, degrees (for rendering/geometry).
  currentLocalAngle: number; // Current mechanical angle in [minLocalAngle, maxLocalAngle].
  scanDirection: 1 | -1;
  mode: SonarMode;
  targetAngle: number; // Target world bearing.
  targetLocalAngle: number;
  scanRange: number; // Current max range setting (meters)
  pingAccumulator: number; // Time since last ping (sec) while scanning
  
  // Simulation metrics
  lastScanTime: number; // Timestamp of last full cycle
  cycleDuration: number; // Duration of last cycle
  detectedPoints: Vector2[];
  matchedPoints: Vector2[];
  activeCommandId?: string;
  activeCommandStartedAt?: number;
  activeCommandEndsAt?: number;
  commandProgress?: number;
  activeAction?: StrategyAction;
  activeScanMinLocalAngle?: number;
  activeScanMaxLocalAngle?: number;
  assignedTargetIds?: string[];
}

export interface SonarCommand {
  commandId: string;
  sonarId: string;
  startLocalAngle: number; // Mechanical angle when submitted, degrees.
  scanStartLocalAngle: number; // Mechanical angle where transmitting begins after slew.
  endLocalAngle: number; // Mechanical scan endpoint; may be smaller than scanStartLocalAngle.
  scanMinLocalAngle: number;
  scanMaxLocalAngle: number;
  range: number;
  angularStepDeg: number;
  samplesPerBeam: number;
  pingSlotCount: number; // TDMA transmit slots shared by concurrently available sonars.
  transmitDurationUs?: number;
  gain?: number;
  startTime: number;
  action?: StrategyAction;
  assignedTargetIds?: string[];
  scanWindows?: SonarCommandScanWindow[];
}

export interface SonarCommandScanWindow {
  scanStartLocalAngle: number;
  endLocalAngle: number;
  scanMinLocalAngle: number;
  scanMaxLocalAngle: number;
  range: number;
  assignedTargetIds?: string[];
}

export interface BeamReturn {
  beamIndex: number;
  time: number;
  angle: number; // World bearing.
  localAngle: number;
  range?: number;
  intensities: number[];
  /** True when this image row was reconstructed between physical pings. */
  recovered?: boolean;
}

export interface SonarFrame {
  sonarId: string;
  commandId: string;
  sonarPosition: Vector2;
  startTime: number;
  endTime: number;
  beams: BeamReturn[];
  angleBins: number;
  /** Physical ping rows before optional angular recovery. */
  acquiredAngleBins?: number;
  recoveryAngularStepDeg?: number;
  rangeBins: number;
  startAngle: number; // World bearing of first beam, degrees.
  endAngle: number; // World bearing of last beam, degrees.
  startLocalAngle: number;
  endLocalAngle: number;
  minAngle: number; // Numeric min of start/end world bearing; do not use for wrap-aware visibility.
  maxAngle: number; // Numeric max of start/end world bearing; do not use for wrap-aware visibility.
  range: number;
  intensities: Float32Array;
}

export interface Detection {
  id: string;
  /** Source frame identity used for per-frame association. */
  frameId?: string;
  time: number;
  sonarId: string;
  position: Vector2;
  range: number;
  bearing: number;
  confidence: number;
  intensity: number;
  bbox?: { aMin: number; aMax: number; rMin: number; rMax: number };
  source?: 'target' | 'false_alarm';
}

export interface TrackBelief {
  trackId: string;
  position: Vector2;
  velocity: Vector2;
  covariance: number[][];
  age: number;
  timeSinceUpdate: number;
  confidence: number;
  status: 'tentative' | 'confirmed' | 'lost';
}

export interface EngineEvalMetrics {
  timestamp: number;
  activeSwimmers: number;
  avgAoISec: number;
  p90AoISec: number;
  avgScanRateHz: number;
  trackingRMSEm: number;
  p90TrackingErrorM: number;
  avgRevisitIntervalSec: number;
  falseAlarmsPerSec: number;
  detectionHitRate: number; // [0, 1]
  avgLocalizationErrorM: number;
  p90LocalizationErrorM: number;
  avgTimeToFirstDetectionSec: number;
  p90TimeToFirstDetectionSec: number;

  // Paper-aligned metrics (AquaScan / Ping360, per-frame)
  precision: number;
  recall: number;
  f1: number;
  mdr: number; // miss detection rate
  meanIoU: number;
  fps: number;
  trackingRate: number; // TR
  trackTruePositives: number;
  falseTracks: number;
  missedTracks: number;
  idSwitches: number;
  trackFragmentations: number;
  // Scan-level ID accuracy: correct visible-swimmer track IDs / visible-swimmer scan opportunities.
  strictTrackAccuracy: number;
  // Handoff-tolerant scan-level ID accuracy. A one-frame wrong ID is counted wrong,
  // but a repeated new track ID is promoted as the local reference for that swimmer.
  localTrackAccuracy: number;
  // Numerator and denominator for strictTrackAccuracy.
  strictIdentityTracks: number;
  // Numerator and denominator for localTrackAccuracy.
  localIdentityTracks: number;
  identityTrackOpportunities: number;
  gospa: number;
  gospaLocalization: number;
  gospaMissed: number;
  gospaFalse: number;
  trackContinuity: number;
  deadlineDetection3Sec: number;
  deadlineDetection5Sec: number;
  deadlineDetection10Sec: number;
}

export interface SimulationMetrics {
  timestamp: number;
  activeSwimmers: number;
  avgAoISecNaive: number;
  avgAoISecOptimized: number;
  trackingRMSEmNaive: number;
  trackingRMSEmOptimized: number;
  avgScanRateHzNaive: number;
  avgScanRateHzOptimized: number;
  falseAlarmsPerSecNaive: number;
  falseAlarmsPerSecOptimized: number;
  detectionHitRateNaive: number;
  detectionHitRateOptimized: number;
  avgLocalizationErrorMNaive: number;
  avgLocalizationErrorMOptimized: number;
  p90LocalizationErrorMNaive: number;
  p90LocalizationErrorMOptimized: number;
  avgTimeToFirstDetectionSecNaive: number;
  avgTimeToFirstDetectionSecOptimized: number;
  p90TimeToFirstDetectionSecNaive: number;
  p90TimeToFirstDetectionSecOptimized: number;

  // Paper-aligned metrics (per engine)
  fpsNaive: number;
  fpsOptimized: number;
  trackingRateNaive: number;
  trackingRateOptimized: number;
  strictTrackAccuracyNaive: number;
  strictTrackAccuracyOptimized: number;
  localTrackAccuracyNaive: number;
  localTrackAccuracyOptimized: number;
  precisionNaive: number;
  precisionOptimized: number;
  recallNaive: number;
  recallOptimized: number;
  f1Naive: number;
  f1Optimized: number;
  mdrNaive: number;
  mdrOptimized: number;
  meanIoUNaive: number;
  meanIoUOptimized: number;
}

export type StrategyType = string;
export type StrategyAction = 'FULL_SWEEP' | 'TRACK_ROI' | 'SEARCH_SECTOR' | 'SLEW_ONLY' | 'IDLE';

export interface StrategyTrack {
  id: string;
  position: Vector2;
  velocity?: Vector2;
  covariance?: number[][];
  age?: number;
  timeSinceUpdate?: number;
  confidence?: number;
  status?: 'tentative' | 'confirmed' | 'lost';
}

export interface StrategySonar {
  id: string;
  position: Vector2;
  mountAngle: number;
  mountYaw: number;
  currentAngle: number;
  currentLocalAngle: number;
  minLocalAngle: number;
  maxLocalAngle: number;
  scanDirection: 1 | -1;
  mode?: SonarMode;
  activeCommandId?: string;
  activeCommandEndsAt?: number;
  assignedTargetIds?: string[];
  coverageBins: StrategyCoverageBin[];
  available: boolean;
}

export interface StrategyCoverageBin {
  minLocalAngle: number;
  maxLocalAngle: number;
  lastObservedAt: number;
  ageSec: number;
}

export interface StrategySnapshot {
  simulationTime: number;
  seed: number;
  pool: {
    width: number;
    length: number;
  };
  physics: {
    speedOfSound: number;
    slewSpeed: number;
    scanStepAngle: number;
    processingOverheadSec: number;
    scanStepOverheadSec: number;
    receiveGuardFactor: number;
    samplesPerBeam: number;
    samplePeriodSec: number;
    maxRange: number;
    tdmaSlotCount: number;
  };
  sonars: StrategySonar[];
  tracks: StrategyTrack[];
}

export interface SonarStrategyPlan {
  sonarId: string;
  minLocalAngle: number; // Local mechanical scan bound, degrees.
  maxLocalAngle: number; // Local mechanical scan bound, degrees.
  range: number;
  angularStepDeg?: number;
  assignedTargetIds: string[];
  action?: StrategyAction;
  scanWindows?: SonarStrategyScanWindow[];
}

export interface SonarStrategyScanWindow {
  minLocalAngle: number;
  maxLocalAngle: number;
  range?: number;
  assignedTargetIds?: string[];
}

export interface StrategyDecision {
  strategy: StrategyType;
  generatedAt: number;
  plans: SonarStrategyPlan[];
  diagnostics?: StrategyDecisionDiagnostics;
}

export interface StrategyDecisionDiagnostics {
  trackCount?: number;
  sonarCount?: number;
  candidateCost?: number | null;
  fallbackCost?: number | null;
  seedCost?: number | null;
  acceptedCostImprovement?: number | null;
  rejectionReason?: string | null;
  [key: string]: string | number | boolean | null | undefined;
}

export interface EngineFrameEvent {
  time: number;
  sonarId: string;
  command: SonarCommand;
  truthCount: number;
  detectionCount: number;
  matchedDetectionCount: number;
  falseAlarmCount: number;
  trackCount: number;
}
