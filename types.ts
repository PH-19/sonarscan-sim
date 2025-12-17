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
}

export type StrategyType = 'NAIVE' | 'OPTIMIZED';
