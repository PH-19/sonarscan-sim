import { StrategyDecision, StrategySnapshot, StrategyType } from '../../../types';
import { BASELINE_REGISTRY } from '../benchmark/BaselineRegistry';

export const normalizeStrategyId = (strategy: StrategyType) => strategy.toUpperCase();

// The public simulator contains only self-contained scan modes.
export const usesPythonStrategyService = (_strategy: StrategyType) => false;

export const isCliBenchmarkStrategy = (strategy: StrategyType) => (
  Boolean(BASELINE_REGISTRY[normalizeStrategyId(strategy)])
);

export const planUiStrategyDecision = async (
  strategy: StrategyType,
  snapshot: StrategySnapshot,
): Promise<StrategyDecision> => {
  const normalized = normalizeStrategyId(strategy);
  const planner = BASELINE_REGISTRY[normalized];
  if (!planner) throw new Error(`Unknown built-in scan mode "${strategy}"`);
  return planner(snapshot, normalized);
};
