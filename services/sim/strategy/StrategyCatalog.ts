export type UiStrategyOption = {
  id: string;
  label: string;
  shortLabel: string;
  summary: string;
};

export const E2E_BASELINE_STRATEGY_OPTIONS: UiStrategyOption[] = [
  {
    id: 'FULL_SCAN',
    label: 'FULL_SCAN - full sweep',
    shortLabel: 'FULL_SCAN',
    summary: 'Every sonar sweeps its whole local sector at max range.',
  },
  {
    id: 'ROUND_ROBIN_SECTOR',
    label: 'ROUND_ROBIN_SECTOR - rotating search sectors',
    shortLabel: 'RR_SECTOR',
    summary: 'Each sonar scans a fixed-width search sector that advances over time.',
  },
  {
    id: 'ROUND_ROBIN_ROI',
    label: 'ROUND_ROBIN_ROI - rotating track ownership',
    shortLabel: 'RR_ROI',
    summary: 'Known tracks are assigned to sonars in a time-rotating order, then scanned as ROIs.',
  },
  {
    id: 'NEAREST_ROI',
    label: 'NEAREST_ROI - nearest sonar ROI',
    shortLabel: 'NEAREST',
    summary: 'Known tracks are assigned to their nearest eligible sonar and scanned as compact ROIs.',
  },
  {
    id: 'PID_ROI',
    label: 'PID_ROI - PID-guided ROI controller',
    shortLabel: 'PID_ROI',
    summary: 'A track-only PID controller steers each sonar toward high-priority Kalman tracks.',
  },
];

const CANDIDATE_STRATEGY_OPTIONS: UiStrategyOption[] = [
  {
    id: 'BELIEF_PSO_V3',
    label: 'BELIEF_PSO_V3 - proposed method',
    shortLabel: 'BELIEF_PSO_V3',
    summary: 'Track-belief PSO planner with adaptive ROI, range, uncertainty, and coverage terms.',
  },
  {
    id: 'BELIEF_PSO_V2',
    label: 'BELIEF_PSO_V2 - frozen previous method',
    shortLabel: 'BELIEF_PSO_V2',
    summary: 'Previous frozen belief-PSO method retained for version comparison.',
  },
];

export const UI_COMPARISON_STRATEGY_OPTIONS: UiStrategyOption[] = [
  ...CANDIDATE_STRATEGY_OPTIONS,
  ...E2E_BASELINE_STRATEGY_OPTIONS,
];

export const makeAdHocStrategyOption = (strategy: string): UiStrategyOption => {
  const id = strategy.toUpperCase();
  return {
    id,
    label: id,
    shortLabel: id,
    summary: 'Runtime-configured strategy.',
  };
};

export const withSelectedStrategyOption = (
  options: UiStrategyOption[],
  selectedStrategy: string,
) => {
  const selected = selectedStrategy.toUpperCase();
  if (options.some(option => option.id === selected)) return options;
  return [makeAdHocStrategyOption(selected), ...options];
};

export const strategyLabel = (strategy: string) => {
  const normalized = strategy.toUpperCase();
  return UI_COMPARISON_STRATEGY_OPTIONS.find(option => option.id === normalized)?.shortLabel ?? normalized;
};
