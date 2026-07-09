import { StrategySnapshot } from '../../../types';
import { BASELINE_REGISTRY } from '../benchmark/BaselineRegistry';
import { PythonWorkerStrategyProvider } from './PythonWorkerStrategyProvider';
import { StrategyProvider } from './StrategyProvider';
import { BenchmarkTruthOracleProvider, OracleTruthTarget } from './BenchmarkTruthOracleProvider';
import { PidRoiStrategyProvider } from './PidRoiStrategyProvider';

class TypeScriptStrategyProvider implements StrategyProvider {
  invocationCount = 0;
  readonly metadata;

  constructor(readonly strategyId: string) {
    this.metadata = {
      strategyId,
      implementationLanguage: 'typescript' as const,
      implementation: `BaselineRegistry:${strategyId}`,
      codeVersion: 'baseline-registry-v1',
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
  benchmarkTruthSupplier?: () => OracleTruthTarget[],
): StrategyProvider => {
  const normalized = strategyId.toUpperCase();
  if (normalized === 'OPTIMIZED') {
    throw new Error('OPTIMIZED is ambiguous and is not a benchmark strategy id; use BELIEF_PSO_V3 or a named baseline');
  }
  if (normalized === 'PID_ROI') return new PidRoiStrategyProvider();
  if (normalized === 'PSO_V1' || normalized.startsWith('BELIEF_PSO_')) return new PythonWorkerStrategyProvider(normalized);
  if (normalized === 'TRUTH_LOOKAHEAD_ORACLE') {
    if (!benchmarkTruthSupplier) throw new Error('TRUTH_LOOKAHEAD_ORACLE requires an isolated benchmark truth supplier');
    return new BenchmarkTruthOracleProvider(benchmarkTruthSupplier);
  }
  if (BASELINE_REGISTRY[normalized]) return new TypeScriptStrategyProvider(normalized);
  throw new Error(`Unknown headless benchmark strategy "${strategyId}"`);
};
