export interface Vector2 {
  x: number;
  y: number;
}

export interface Swimmer {
  id: string;
  position: Vector2;
  velocity: Vector2; // m/s
  enteredAt: number;
}

export enum SonarMode {
  IDLE = 'IDLE',
  SCANNING = 'SCANNING', // Emitting sound, waiting for return, slow rotation
  SLEWING = 'SLEWING',   // Rotating quickly to next sector, no emission
}

export interface SonarConfig {
  id: string;
  position: Vector2;
  angle: number; // Degrees
  mountAngle: number; // Base angle (e.g., 45 for corner)
  maxAngle: number; // Relative max sweep
  minAngle: number; // Relative min sweep
}

export interface SonarState extends SonarConfig {
  currentAngle: number; // Degrees
  mode: SonarMode;
  targetAngle: number; // Where we are trying to go
  scanRange: number; // Current max range setting (meters)
  pingAccumulator: number; // Time since last ping (sec) while scanning
  
  // Simulation metrics
  lastScanTime: number; // Timestamp of last full cycle
  cycleDuration: number; // Duration of last cycle
  detectedPoints: Vector2[];
  matchedPoints: Vector2[];
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

export type StrategyType = 'NAIVE' | 'OPTIMIZED';
