import { StrategySnapshot } from '../../../types';
import { BASELINE_REGISTRY } from '../benchmark/BaselineRegistry';
import { StrategyProvider } from './StrategyProvider';

class TypeScriptStrategyProvider implements StrategyProvider {
  invocationCount = 0;
  readonly metadata;

  constructor(readonly strategyId: string) {
    this.metadata = {
      strategyId,
      implementationLanguage: 'typescript' as const,
      implementation: `BaselineRegistry:${strategyId}`,
      codeVersion: 'public-scan-modes-v1',
      parameters: {},
    };
  }

  async plan(snapshot: StrategySnapshot) {
    this.invocationCount += 1;
    return BASELINE_REGISTRY[this.strategyId](snapshot, this.strategyId);
  }

  async close() {}
}

export const createHeadlessStrategyProvider = (
  strategyId: string,
  _unusedTruthSupplier?: unknown,
): StrategyProvider => {
  const normalized = strategyId.toUpperCase();
  if (BASELINE_REGISTRY[normalized]) return new TypeScriptStrategyProvider(normalized);
  throw new Error(`Unknown built-in scan mode "${strategyId}"`);
};
