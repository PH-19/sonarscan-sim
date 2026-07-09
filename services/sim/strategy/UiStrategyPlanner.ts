import { StrategyClient } from '../../StrategyClient';
import { StrategyDecision, StrategySnapshot, StrategyType } from '../../../types';
import { BASELINE_REGISTRY } from '../benchmark/BaselineRegistry';

export const normalizeStrategyId = (strategy: StrategyType) => strategy.toUpperCase();

export const usesPythonStrategyService = (strategy: StrategyType) => {
  const normalized = normalizeStrategyId(strategy);
  return normalized === 'PSO_V1' || normalized.startsWith('BELIEF_PSO_');
};

export const isCliBenchmarkStrategy = (strategy: StrategyType) => {
  const normalized = normalizeStrategyId(strategy);
  return usesPythonStrategyService(normalized) || Boolean(BASELINE_REGISTRY[normalized]);
};

export const planUiStrategyDecision = async (
  strategy: StrategyType,
  snapshot: StrategySnapshot,
  client?: StrategyClient
): Promise<StrategyDecision> => {
  const normalized = normalizeStrategyId(strategy);
  if (normalized === 'OPTIMIZED') {
    throw new Error('OPTIMIZED is ambiguous; use BELIEF_PSO_V3 or a named benchmark strategy');
  }

  const baselinePlanner = BASELINE_REGISTRY[normalized];
  if (baselinePlanner) return baselinePlanner(snapshot, normalized);

  if (usesPythonStrategyService(normalized)) {
    if (!client) throw new Error(`Strategy ${normalized} requires the Python strategy service`);
    return client.plan(normalized, snapshot);
  }

  throw new Error(`Unknown CLI benchmark strategy "${strategy}"`);
};
