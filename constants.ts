export const POOL_WIDTH = 20; // meters
export const POOL_LENGTH = 50; // meters

export const SPEED_OF_SOUND = 1500; // m/s in water

// Mechanical limits
// Ping360-like motor: fast rotation when not scanning (no ping emission)
// Reserved for ROI/intermittent scan variants (not enabled yet); keep realistic mechanical speed.
export const SLEW_SPEED = 45; // degrees per second
// Step size per ping (emits one ping per step while scanning)
// Tuned so a (1/1) full scan across a 90° sector is ~6.18s at max range.
export const SCAN_STEP_ANGLE = 1.0; // degrees per step

// Ping360 processing overhead (approx. sensor + host processing per ping).
// Added on top of acoustic round-trip time.
export const PING360_PROCESSING_OVERHEAD_S = 0.002; // seconds

// PSO (Particle Swarm Optimization) settings for collaborative assignment
export const PSO_SWARM_SIZE = 24;
export const PSO_ITERATIONS = 30;
export const PSO_INERTIA = 0.6;
export const PSO_COGNITIVE = 1.6;
export const PSO_SOCIAL = 1.6;
export const PSO_UPDATE_INTERVAL = 0.8; // seconds between re-optimizations

// Simulation
// Ping360 range in the AquaScan pool setup is typically configured to a fixed max range.
// Use 50m so a 90° sector scan hits the paper's ~6.18s/frame (1/1) scale.
export const MAX_RANGE_NAIVE = 50; // meters
export const TARGET_PADDING_ANGLE = 10; // degrees extra to scan around a target
export const TARGET_PADDING_RANGE = 2; // meters extra beyond target
export const OPT_SWEEP_MIN_DEG = 18; // minimum contiguous sweep width for optimized (no intermittent gaps)
export const OPT_SWEEP_REPLAN_DEG = 6; // replan sweep bounds if center shifts by this many degrees
export const OPT_SWEEP_MAX_HOLD_SEC = 1.0; // max time to hold old sweep bounds before refresh

export const SWIMMER_SPEED_MIN = 0.8; // m/s
export const SWIMMER_SPEED_MAX = 1.8; // m/s

// --- Imaging Sonar (simplified intensity-grid model) ---
// Ping360-like approximation: a narrow azimuth beam; each ping is effectively a single bearing.
// Note: I can't fetch Ping360 specs in this sandbox (network restricted); tweak these to match your exact setup.
// Per-ping horizontal beamwidth (paper: 2.22 grads ≈ 2.0°)
export const IMAGING_FOV_DEG = 2.0; // degrees
// Per-frame polar image size (angle bins cover the 90° sector; range bins cover MAX_RANGE_NAIVE)
export const IMAGING_FRAME_ANGLE_BINS = 90;
export const IMAGING_RANGE_BINS = 256;

// Background noise / speckle (tune to see false alarms & localization changes)
export const IMAGING_NOISE_FLOOR = 0.15;
export const IMAGING_NOISE_STD = 0.35;
export const IMAGING_SPECKLE_PROB = 0.015; // probability of an impulsive speckle per cell
export const IMAGING_SPECKLE_STRENGTH = 1.8; // added intensity when speckle happens

// Dynamic noise (surface wave / multipath-like artifacts)
export const IMAGING_WEAK_BAND_PROB = 0.12; // per-ping chance of adding a weak range-band artifact
export const IMAGING_WEAK_BAND_STRENGTH = 0.35;
export const IMAGING_GHOST_REL_STRENGTH = 0.25; // relative to the parent echo
export const IMAGING_GHOST_RANGE_OFFSET_M = 2.8; // typical extra delay converted to meters

// Target echo blob (adds intensity around the target's angle/range bin)
export const IMAGING_ECHO_STRENGTH = 3.2;
export const IMAGING_ECHO_RANGE_ATTENUATION_M = 80; // larger = slower decay with distance (acts like simple TVG)
export const IMAGING_BLOB_RADIUS_BINS = 3; // range smear / object extent
export const IMAGING_BLOB_SIGMA_BINS = 1.4;

// Static background structures (pool walls / lane lines)
export const POOL_LANE_COUNT = 4;
export const IMAGING_STATIC_WALL_ECHO_STRENGTH = 4.5;
export const IMAGING_STATIC_LANE_ECHO_STRENGTH = 2.4;
export const IMAGING_STATIC_ECHO_SIGMA_BINS = 1.0;

// Background scan / subtraction (EMA model)
export const IMAGING_BACKGROUND_WARMUP_FRAMES = 2;
export const IMAGING_BACKGROUND_WARMUP_ALPHA = 0.35;
export const IMAGING_BACKGROUND_EMA_ALPHA = 0.05;
export const IMAGING_BACKGROUND_UPDATE_SLACK = 0.12; // allow slight increases without freezing

// --- AquaScan-like physical-aware detection (simplified, non-ML) ---
export const AQUASCAN_KERNEL_CAP = 11; // paper: kernel > 13 increases misses sharply
export const AQUASCAN_WEAK_ECHO_PERCENTILE = 0.8; // global percentile threshold on background-subtracted intensity
export const AQUASCAN_WEAK_ECHO_MIN = 0.15; // floor for weak-echo elimination threshold (intensity units)

// DBSCAN on polar image (angleBins, rangeBins)
export const AQUASCAN_DBSCAN_EPS_BINS = 2.0;
export const AQUASCAN_DBSCAN_MIN_PTS = 8;

// Physical constraints (approx human blob extents, in meters)
export const AQUASCAN_MIN_CROSS_RANGE_M = 0.18;
export const AQUASCAN_MAX_CROSS_RANGE_M = 1.6;
export const AQUASCAN_MIN_RANGE_EXTENT_M = 0.18;
export const AQUASCAN_MAX_RANGE_EXTENT_M = 1.6;
export const AQUASCAN_MIN_ASPECT = 0.2; // cross-range / range extent
export const AQUASCAN_MAX_ASPECT = 6.0;
export const AQUASCAN_DENOISE_OVERLAP_MIN = 0.12; // fraction of points surviving in denoise branch
export const AQUASCAN_IOU_MATCH_THRESHOLD = 0.1;

// Ground-truth swimmer blob (for IoU metric)
export const SIM_SWIMMER_DIAMETER_M = 0.45;

// Denoise + threshold + clustering
export const IMAGING_THRESHOLD = 1.05; // after denoise filter (median by default)
export const IMAGING_MIN_CLUSTER_CELLS = 3;
export const IMAGING_MAX_CLUSTERS_PER_PING = 16;
export const IMAGING_NOISE_TO_MEAS_SIGMA_M = 0.8; // higher => noisier localization under low threshold/high noise
export const IMAGING_MEAS_JITTER_SCALE = 0.25; // scale applied to reported sigma when jittering candidate positions

// Evaluation matching
export const MATCH_GATE_RADIUS_M = 2.5; // candidate-to-truth gating radius for matching

export const COLOR_PALETTE = {
  poolWater: '#f0f9ff', // Very light sky blue (sky-50)
  poolBorder: '#bae6fd', // sky-200
  sonarBody: '#475569', // slate-600
  beamNaive: 'rgba(239, 68, 68, 0.05)', // red-500 very low opacity fill
  beamNaiveBorder: 'rgba(239, 68, 68, 0.4)', // red-500 distinct border
  beamOptimized: 'rgba(34, 197, 94, 0.08)', // green-500 very low opacity fill
  beamOptimizedBorder: 'rgba(34, 197, 94, 0.4)', // green-500 distinct border
  swimmerReal: '#166534', // green-800
  swimmerDetected: '#dc2626', // red-600
  slewIndicator: 'rgba(148, 163, 184, 0.1)',
};
