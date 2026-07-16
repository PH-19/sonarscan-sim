import {
  SonarStrategyPlan,
  StrategyDecision,
  StrategySnapshot,
  StrategySonar,
} from '../../../types';

export type HeadlessStrategyPlanner = (
  snapshot: StrategySnapshot,
  strategyName: string,
) => StrategyDecision;

const fullScanPlan = (sonar: StrategySonar, maxRange: number): SonarStrategyPlan => ({
  sonarId: sonar.id,
  minLocalAngle: sonar.minLocalAngle,
  maxLocalAngle: sonar.maxLocalAngle,
  range: maxRange,
  assignedTargetIds: [],
  action: sonar.available ? 'FULL_SWEEP' : 'IDLE',
});

const decision = (
  strategyName: string,
  snapshot: StrategySnapshot,
  plans: SonarStrategyPlan[],
): StrategyDecision => ({
  strategy: strategyName,
  generatedAt: snapshot.simulationTime,
  plans,
});

const planFullScan: HeadlessStrategyPlanner = (snapshot, strategyName) => (
  decision(
    strategyName,
    snapshot,
    snapshot.sonars.map(sonar => fullScanPlan(sonar, snapshot.physics.maxRange)),
  )
);

const planRoundRobinSector: HeadlessStrategyPlanner = (snapshot, strategyName) => {
  const sectorWidth = 30;
  const sectorCount = 6;
  const bucket = Math.floor(snapshot.simulationTime / 2.5);
  return decision(strategyName, snapshot, snapshot.sonars.map((sonar, index) => {
    if (!sonar.available) {
      return {
        sonarId: sonar.id,
        minLocalAngle: sonar.currentLocalAngle,
        maxLocalAngle: Math.min(sonar.maxLocalAngle, sonar.currentLocalAngle + 1),
        range: 1,
        assignedTargetIds: [],
        action: 'IDLE' as const,
      };
    }
    const sector = (bucket + index * 2) % sectorCount;
    const minLocalAngle = sonar.minLocalAngle + sector * sectorWidth;
    return {
      sonarId: sonar.id,
      minLocalAngle,
      maxLocalAngle: Math.min(sonar.maxLocalAngle, minLocalAngle + sectorWidth),
      range: snapshot.physics.maxRange,
      assignedTargetIds: [],
      action: 'SEARCH_SECTOR' as const,
    };
  }));
};

export const BASELINE_REGISTRY: Record<string, HeadlessStrategyPlanner> = {
  FULL_SCAN: planFullScan,
  NAIVE: planFullScan,
  ROUND_ROBIN_SECTOR: planRoundRobinSector,
};

export const makeStrategyDecision = (
  strategyName: string,
  snapshot: StrategySnapshot,
): StrategyDecision => {
  const normalized = strategyName.toUpperCase();
  const planner = BASELINE_REGISTRY[normalized];
  if (!planner) throw new Error(`Unknown built-in scan mode "${strategyName}"`);
  return planner(snapshot, normalized);
};
