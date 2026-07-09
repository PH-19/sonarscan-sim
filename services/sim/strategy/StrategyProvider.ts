import { StrategyDecision, StrategySnapshot } from '../../../types';

export type StrategyImplementation = {
  strategyId: string;
  implementationLanguage: 'typescript' | 'python';
  implementation: string;
  codeVersion: string;
  parameters: Record<string, number | string | boolean>;
};

export interface StrategyProvider {
  readonly metadata: StrategyImplementation;
  readonly invocationCount: number;
  plan(snapshot: StrategySnapshot): Promise<StrategyDecision>;
  close(): Promise<void>;
}
