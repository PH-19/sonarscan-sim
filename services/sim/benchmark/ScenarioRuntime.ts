import { SimulationEngine, EngineTuningParams } from '../../SimulationEngine';
import { BenchmarkScenario, cloneSwimmer, ScenarioEvent } from './ScenarioFactory';

export const resetEngineToBenchmarkScenario = (
  engine: SimulationEngine,
  scenario: BenchmarkScenario,
  sensorParams: EngineTuningParams
) => {
  engine.setTuningParams(sensorParams);
  engine.reset();
  for (const swimmer of scenario.initialSwimmers) {
    engine.addSwimmer(cloneSwimmer(swimmer));
  }
};

export const applyBenchmarkScenarioEvent = (engine: SimulationEngine, event: ScenarioEvent) => {
  if (event.type === 'add') {
    engine.addSwimmer(cloneSwimmer(event.swimmer));
    return;
  }
  if (event.type === 'remove') {
    engine.removeSwimmerById(event.swimmerId);
    return;
  }
  engine.setSonarAvailable(event.sonarId, event.available);
};

export const engineSwimmerIds = (engine: SimulationEngine) => engine.swimmers.map(swimmer => swimmer.id);
