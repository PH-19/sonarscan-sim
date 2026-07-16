export const POOL_WIDTH = 20; // meters
export const POOL_LENGTH = 50; // meters

export const SPEED_OF_SOUND = 1500; // m/s in water

// Mechanical limits
export const SLEW_SPEED = 45; // degrees per second
export const SONAR_LOCAL_MIN_ANGLE = 0;
export const SONAR_LOCAL_MAX_ANGLE = 180;
export const SCAN_STEP_ANGLE = 0.9; // Ping360 mechanical step, degrees

export const PING360_PROCESSING_OVERHEAD_S = 0.002; // seconds
export const PING360_SCAN_STEP_OVERHEAD_S = 0.005; // motor/communication overhead per 0.9° step
export const PING360_RECEIVE_GUARD_FACTOR = 1.1; // firmware/receive guard beyond nominal two-way travel
export const SONAR_SAMPLE_PERIOD_S = 0.000005; // seconds per range sample

// Blue Robotics specifies a configurable Ping360 range of 0.75-50 m. This is
// the hardware command envelope, not the range that every scan should use.
// Strategies should request the shortest range that covers their current ROI,
// because receive time grows with acoustic round-trip distance.
export const PING360_MIN_RANGE_M = 0.75;
export const PING360_MAX_RANGE_M = 50;
// Backward-compatible name used by the unchanged strategy snapshot layer.
export const MAX_RANGE_NAIVE = PING360_MAX_RANGE_M;
export const OPT_SWEEP_REPLAN_DEG = 6;

export const SWIMMER_SPEED_MIN = 0.5; // m/s
export const SWIMMER_SPEED_MAX = 1.0; // m/s

// --- Imaging Sonar ---
export const IMAGING_FOV_DEG = 2.0; // degrees
export const IMAGING_FRAME_ANGLE_BINS = 181;
export const IMAGING_RANGE_BINS = 256;

// Background noise — extremely low for clean detection
export const IMAGING_NOISE_FLOOR = 0.02;
export const IMAGING_NOISE_STD = 0.04;
export const IMAGING_SPECKLE_PROB = 0.0003;
export const IMAGING_SPECKLE_STRENGTH = 0.15;

// Dynamic noise — negligible
export const IMAGING_WEAK_BAND_PROB = 0.005;
export const IMAGING_WEAK_BAND_STRENGTH = 0.06;
export const IMAGING_GHOST_REL_STRENGTH = 0.005;
export const IMAGING_GHOST_RANGE_OFFSET_M = 2.8;

// Target echo — very strong so detection is 99%+ reliable
export const IMAGING_ECHO_STRENGTH = 20.0;
export const IMAGING_ECHO_RANGE_ATTENUATION_M = 150;
export const IMAGING_BLOB_RADIUS_BINS = 5;
export const IMAGING_BLOB_SIGMA_BINS = 1.8;

// Static structures — all below detection threshold so they never produce false alarms
export const POOL_LANE_COUNT = 4;
export const IMAGING_STATIC_WALL_ECHO_STRENGTH = 0.12;
export const IMAGING_STATIC_LANE_ECHO_STRENGTH = 0.08;
export const IMAGING_STATIC_ECHO_SIGMA_BINS = 1.0;

// Background EMA model
export const IMAGING_BACKGROUND_WARMUP_FRAMES = 2;
export const IMAGING_BACKGROUND_WARMUP_ALPHA = 0.35;
export const IMAGING_BACKGROUND_EMA_ALPHA = 0.05;
export const IMAGING_BACKGROUND_UPDATE_SLACK = 0.12;

// --- Detection parameters ---

export const AQUASCAN_DBSCAN_EPS_BINS = 2.5;
export const AQUASCAN_DBSCAN_MIN_PTS = 4;

export const AQUASCAN_MIN_CROSS_RANGE_M = 0.08;
export const AQUASCAN_MAX_CROSS_RANGE_M = 4.0;
export const AQUASCAN_MIN_RANGE_EXTENT_M = 0.10;
export const AQUASCAN_MAX_RANGE_EXTENT_M = 2.5;
export const AQUASCAN_MIN_ASPECT = 0.2;
export const AQUASCAN_MAX_ASPECT = 6.0;
export const AQUASCAN_DENOISE_OVERLAP_MIN = 0.12;
export const AQUASCAN_IOU_MATCH_THRESHOLD = 0.1;

export const SIM_SWIMMER_DIAMETER_M = 0.45;
export const SIM_SWIMMER_LENGTH_M = 1.7;

export const IMAGING_THRESHOLD = 1.5;
export const IMAGING_MIN_CLUSTER_CELLS = 3;
export const IMAGING_MAX_CLUSTERS_PER_PING = 16;
export const IMAGING_NOISE_TO_MEAS_SIGMA_M = 0.4;
export const IMAGING_MEAS_JITTER_SCALE = 0.25;

export const MATCH_GATE_RADIUS_M = 4.0;

export const COLOR_PALETTE = {
  poolWater: '#f0f9ff',
  poolBorder: '#bae6fd',
  sonarBody: '#475569',
  beamNaive: 'rgba(239, 68, 68, 0.05)',
  beamNaiveBorder: 'rgba(239, 68, 68, 0.4)',
  beamOptimized: 'rgba(34, 197, 94, 0.08)',
  beamOptimizedBorder: 'rgba(34, 197, 94, 0.4)',
  swimmerReal: '#166534',
  swimmerDetected: '#dc2626',
  slewIndicator: 'rgba(148, 163, 184, 0.1)',
};
