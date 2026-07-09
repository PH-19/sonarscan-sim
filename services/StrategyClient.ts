import { StrategyDecision, StrategySnapshot, StrategyType } from '../types';

const DEFAULT_STRATEGY_URL = '/api/strategy/plan';

export class StrategyClient {
  constructor(private readonly endpoint = DEFAULT_STRATEGY_URL) {}

  async plan(strategy: StrategyType, snapshot: StrategySnapshot): Promise<StrategyDecision> {
    if (strategy.toUpperCase() === 'OPTIMIZED') {
      throw new Error('OPTIMIZED is ambiguous; configure BELIEF_PSO_V3 or a named baseline explicitly');
    }
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy, snapshot }),
    });

    if (!response.ok) {
      throw new Error(`Strategy service returned ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<StrategyDecision>;
  }
}
