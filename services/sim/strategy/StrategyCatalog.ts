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
    summary: 'Every sonar sweeps its complete local sector.',
  },
  {
    id: 'ROUND_ROBIN_SECTOR',
    label: 'ROUND_ROBIN_SECTOR - rotating sectors',
    shortLabel: 'RR_SECTOR',
    summary: 'Each sonar scans a fixed-width sector that advances over time.',
  },
];

export const UI_COMPARISON_STRATEGY_OPTIONS = E2E_BASELINE_STRATEGY_OPTIONS;

export const makeAdHocStrategyOption = (strategy: string): UiStrategyOption => {
  const id = strategy.toUpperCase();
  return { id, label: id, shortLabel: id, summary: 'Runtime-configured scan mode.' };
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
