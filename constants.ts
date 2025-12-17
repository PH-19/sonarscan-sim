export const POOL_WIDTH = 20; // meters
export const POOL_LENGTH = 50; // meters

export const SPEED_OF_SOUND = 1500; // m/s in water

// Mechanical limits
export const SLEW_SPEED = 180; // degrees per second (Fast rotation when not scanning)
// Step size per ping; tuned so a 180° full sweep ~10s at max range
export const SCAN_STEP_ANGLE = 0.8; // degrees per step
export const BEAM_WIDTH = 2; // degrees (single-beam narrow FOV)

// PSO (Particle Swarm Optimization) settings for collaborative assignment
export const PSO_SWARM_SIZE = 24;
export const PSO_ITERATIONS = 30;
export const PSO_INERTIA = 0.6;
export const PSO_COGNITIVE = 1.6;
export const PSO_SOCIAL = 1.6;
export const PSO_UPDATE_INTERVAL = 0.8; // seconds between re-optimizations

// Simulation
export const MAX_RANGE_NAIVE = Math.sqrt(POOL_WIDTH**2 + POOL_LENGTH**2); // Full diagonal
export const TARGET_PADDING_ANGLE = 10; // degrees extra to scan around a target
export const TARGET_PADDING_RANGE = 2; // meters extra beyond target

export const SWIMMER_SPEED_MIN = 0.8; // m/s
export const SWIMMER_SPEED_MAX = 1.8; // m/s

export const COLOR_PALETTE = {
  poolWater: '#e0f2fe', // sky-100
  poolBorder: '#0ea5e9', // sky-500
  sonarBody: '#334155', // slate-700
  beamNaive: 'rgba(239, 68, 68, 0.3)', // red-500 low opacity
  beamOptimized: 'rgba(34, 197, 94, 0.3)', // green-500 low opacity
  swimmerReal: '#15803d', // green-700
  swimmerDetected: '#ef4444', // red-500
  slewIndicator: 'rgba(100, 116, 139, 0.2)',
};
