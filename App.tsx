import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EngineTuningParams, SimulationEngine } from './services/SimulationEngine';
import SonarCanvas from './components/SonarCanvas';
import { Dashboard } from './components/Dashboard';
import { SimulationMetrics, Swimmer, Vector2 } from './types';
import { POOL_LENGTH, POOL_WIDTH, SLEW_SPEED, SPEED_OF_SOUND, SWIMMER_SPEED_MAX, SWIMMER_SPEED_MIN } from './constants';
import { createLCGRng, SeededRng } from './utils/rng';
import { StrategyClient } from './services/StrategyClient';
import { resolveUiBenchmarkSetup } from './services/sim/benchmark/UiBenchmarkSetup';
import {
  applyBenchmarkScenarioEvent,
  engineSwimmerIds,
  resetEngineToBenchmarkScenario,
} from './services/sim/benchmark/ScenarioRuntime';
import {
  planUiStrategyDecision,
  usesPythonStrategyService,
} from './services/sim/strategy/UiStrategyPlanner';
import {
  E2E_BASELINE_STRATEGY_OPTIONS,
  UI_COMPARISON_STRATEGY_OPTIONS,
  strategyLabel,
  withSelectedStrategyOption,
} from './services/sim/strategy/StrategyCatalog.ts';

const UI_SETUP = resolveUiBenchmarkSetup(import.meta.env);
const BASELINE_STRATEGY = UI_SETUP.baselineStrategy;
const CANDIDATE_STRATEGY = UI_SETUP.candidateStrategy;
const FIXED_DT_SEC = UI_SETUP.config.dtSec;
const SAMPLE_INTERVAL_SEC = UI_SETUP.config.sampleIntervalSec;
const STRATEGY_UPDATE_INTERVAL_SEC = UI_SETUP.config.strategyUpdateIntervalSec;
const MAX_CATCHUP_STEPS = 5;
const requiresStrategyService = (baselineStrategy: string, candidateStrategy: string) =>
  usesPythonStrategyService(baselineStrategy) || usesPythonStrategyService(candidateStrategy);

// Two parallel engines for visual comparison. They are initialized from the
// same deterministic benchmark scenario used by the headless CLI path.
const engineNaive = new SimulationEngine({
  strategy: BASELINE_STRATEGY,
  comparisonRole: 'BASELINE',
  evalSeed: UI_SETUP.seed,
  sonarCount: UI_SETUP.config.sonarCount,
  tdmaEnabled: UI_SETUP.config.tdmaEnabled,
});
const engineOpt = new SimulationEngine({
  strategy: CANDIDATE_STRATEGY,
  comparisonRole: 'CANDIDATE',
  evalSeed: UI_SETUP.seed,
  sonarCount: UI_SETUP.config.sonarCount,
  tdmaEnabled: UI_SETUP.config.tdmaEnabled,
});
resetEngineToBenchmarkScenario(engineNaive, UI_SETUP.scenario, UI_SETUP.sensorParams);
resetEngineToBenchmarkScenario(engineOpt, UI_SETUP.scenario, UI_SETUP.sensorParams);

const strategyClient = new StrategyClient();

type RuntimeSlotName = 'baseline' | 'candidate';

type RuntimeSlotState = {
  engine: SimulationEngine;
  strategy: string;
  nextStrategyUpdateSec: number;
  nextEventIndex: number;
};

type RuntimeState = {
  slots: Record<RuntimeSlotName, RuntimeSlotState>;
  inFlight: boolean;
  retryNotBeforeMs: number;
  nextSampleSec: number;
};

type PlanRequest = {
  slot: RuntimeSlotName;
  advanceSchedule: boolean;
};

const RUNTIME_SLOTS: RuntimeSlotName[] = ['baseline', 'candidate'];

const createRuntimeState = (
  baselineStrategy = engineNaive.strategy,
  candidateStrategy = engineOpt.strategy
): RuntimeState => ({
  slots: {
    baseline: {
      engine: engineNaive,
      strategy: baselineStrategy,
      nextStrategyUpdateSec: 0,
      nextEventIndex: 0,
    },
    candidate: {
      engine: engineOpt,
      strategy: candidateStrategy,
      nextStrategyUpdateSec: 0,
      nextEventIndex: 0,
    },
  },
  inFlight: false,
  retryNotBeforeMs: 0,
  nextSampleSec: 0,
});

const makeEmptyMetrics = (
  timestamp = 0,
  activeSwimmers = engineNaive.swimmers.length
): SimulationMetrics => ({
  timestamp,
  activeSwimmers,
  avgAoISecNaive: 0,
  avgAoISecOptimized: 0,
  trackingRMSEmNaive: 0,
  trackingRMSEmOptimized: 0,
  avgScanRateHzNaive: 0,
  avgScanRateHzOptimized: 0,
  falseAlarmsPerSecNaive: 0,
  falseAlarmsPerSecOptimized: 0,
  detectionHitRateNaive: 0,
  detectionHitRateOptimized: 0,
  avgLocalizationErrorMNaive: 0,
  avgLocalizationErrorMOptimized: 0,
  p90LocalizationErrorMNaive: 0,
  p90LocalizationErrorMOptimized: 0,
  avgTimeToFirstDetectionSecNaive: 0,
  avgTimeToFirstDetectionSecOptimized: 0,
  p90TimeToFirstDetectionSecNaive: 0,
  p90TimeToFirstDetectionSecOptimized: 0,
  fpsNaive: 0,
  fpsOptimized: 0,
  trackingRateNaive: 0,
  trackingRateOptimized: 0,
  strictTrackAccuracyNaive: 0,
  strictTrackAccuracyOptimized: 0,
  localTrackAccuracyNaive: 0,
  localTrackAccuracyOptimized: 0,
  precisionNaive: 0,
  precisionOptimized: 0,
  recallNaive: 0,
  recallOptimized: 0,
  f1Naive: 0,
  f1Optimized: 0,
  mdrNaive: 0,
  mdrOptimized: 0,
  meanIoUNaive: 0,
  meanIoUOptimized: 0,
});

const normalize = (v: Vector2) => {
  const mag = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
  return { x: v.x / mag, y: v.y / mag };
};

const createSwimmerFromSeededRng = (rng: SeededRng, id: string, enteredAt: number): Swimmer => {
  const side = rng.nextInt(4);
  const speed = rng.nextRange(SWIMMER_SPEED_MIN, SWIMMER_SPEED_MAX);

  let position: Vector2 = { x: 0, y: 0 };
  let direction: Vector2 = { x: 0, y: 0 };

  switch (side) {
    case 0:
      position = { x: rng.nextRange(0, POOL_WIDTH), y: 0 };
      direction = { x: rng.nextRange(-0.5, 0.5), y: 1 };
      break;
    case 1:
      position = { x: rng.nextRange(0, POOL_WIDTH), y: POOL_LENGTH };
      direction = { x: rng.nextRange(-0.5, 0.5), y: -1 };
      break;
    case 2:
      position = { x: 0, y: rng.nextRange(0, POOL_LENGTH) };
      direction = { x: 1, y: rng.nextRange(-0.5, 0.5) };
      break;
    case 3:
      position = { x: POOL_WIDTH, y: rng.nextRange(0, POOL_LENGTH) };
      direction = { x: -1, y: rng.nextRange(-0.5, 0.5) };
      break;
  }

  const dir = normalize(direction);

  return {
    id,
    position,
    velocity: { x: dir.x * speed, y: dir.y * speed },
    enteredAt,
  };
};

const nextManualSwimmerIndex = () => {
  const numericIds = UI_SETUP.scenario.initialSwimmers
    .map(swimmer => /^W(\d+)$/.exec(swimmer.id)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(value => Number(value));
  return Math.max(1, ...numericIds.map(value => value + 1));
};

function App() {
  const [baselineStrategy, setBaselineStrategy] = useState(BASELINE_STRATEGY);
  const [candidateStrategy, setCandidateStrategy] = useState(CANDIDATE_STRATEGY);
  const [evalWindowSec, setEvalWindowSec] = useState(UI_SETUP.config.metricsWindowSec);
  const evalWindowSecRef = useRef(evalWindowSec);
  const [tuning, setTuning] = useState<EngineTuningParams>({ ...UI_SETUP.sensorParams });
  const [metricsHistory, setMetricsHistory] = useState<SimulationMetrics[]>([]);
  const [currentMetrics, setCurrentMetrics] = useState<SimulationMetrics>(
    makeEmptyMetrics(engineNaive.time, engineNaive.swimmers.length)
  );
  const [strategy, setStrategy] = useState<'BASELINE' | 'CANDIDATE'>('BASELINE');
  const [swimmerIds, setSwimmerIds] = useState<string[]>(() => engineSwimmerIds(engineNaive));
  const [showMatchedOnly, setShowMatchedOnly] = useState(false);
  const [strategyServiceOnline, setStrategyServiceOnline] = useState<boolean | null>(
    requiresStrategyService(BASELINE_STRATEGY, CANDIDATE_STRATEGY) ? null : true
  );
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const strategyServiceRequired = requiresStrategyService(baselineStrategy, candidateStrategy);
  const baselineStrategyOptions = useMemo(
    () => withSelectedStrategyOption(E2E_BASELINE_STRATEGY_OPTIONS, baselineStrategy),
    [baselineStrategy]
  );
  const candidateStrategyOptions = useMemo(
    () => withSelectedStrategyOption(UI_COMPARISON_STRATEGY_OPTIONS, candidateStrategy),
    [candidateStrategy]
  );

  const requestRef = useRef<number | undefined>(undefined);
  const previousTimeRef = useRef<number | undefined>(undefined);
  const fixedStepAccumulatorRef = useRef(0);
  const swimmerIdCounterRef = useRef(nextManualSwimmerIndex());
  const swimmerRngRef = useRef<SeededRng | null>(null);
  const runtimeRef = useRef<RuntimeState>(createRuntimeState(BASELINE_STRATEGY, CANDIDATE_STRATEGY));
  const runtimeGenerationRef = useRef(0);
  const strategyErrorRef = useRef<string | null>(null);
  if (!swimmerRngRef.current) swimmerRngRef.current = createLCGRng(202503);

  useEffect(() => {
    evalWindowSecRef.current = evalWindowSec;
  }, [evalWindowSec]);

  useEffect(() => {
    engineNaive.setTuningParams(tuning);
    engineOpt.setTuningParams(tuning);
  }, [tuning]);

  const syncSwimmerIds = () => {
    setSwimmerIds(engineSwimmerIds(engineNaive));
  };

  const sampleMetrics = () => {
    const mNaive = engineNaive.getEvalMetrics(evalWindowSecRef.current);
    const mOpt = engineOpt.getEvalMetrics(evalWindowSecRef.current);
    const m: SimulationMetrics = {
      timestamp: engineNaive.time,
      activeSwimmers: engineNaive.swimmers.length,
      avgAoISecNaive: mNaive.avgAoISec,
      avgAoISecOptimized: mOpt.avgAoISec,
      trackingRMSEmNaive: mNaive.trackingRMSEm,
      trackingRMSEmOptimized: mOpt.trackingRMSEm,
      avgScanRateHzNaive: mNaive.avgScanRateHz,
      avgScanRateHzOptimized: mOpt.avgScanRateHz,
      falseAlarmsPerSecNaive: mNaive.falseAlarmsPerSec,
      falseAlarmsPerSecOptimized: mOpt.falseAlarmsPerSec,
      detectionHitRateNaive: mNaive.detectionHitRate,
      detectionHitRateOptimized: mOpt.detectionHitRate,
      avgLocalizationErrorMNaive: mNaive.avgLocalizationErrorM,
      avgLocalizationErrorMOptimized: mOpt.avgLocalizationErrorM,
      p90LocalizationErrorMNaive: mNaive.p90LocalizationErrorM,
      p90LocalizationErrorMOptimized: mOpt.p90LocalizationErrorM,
      avgTimeToFirstDetectionSecNaive: mNaive.avgTimeToFirstDetectionSec,
      avgTimeToFirstDetectionSecOptimized: mOpt.avgTimeToFirstDetectionSec,
      p90TimeToFirstDetectionSecNaive: mNaive.p90TimeToFirstDetectionSec,
      p90TimeToFirstDetectionSecOptimized: mOpt.p90TimeToFirstDetectionSec,
      fpsNaive: mNaive.fps,
      fpsOptimized: mOpt.fps,
      trackingRateNaive: mNaive.trackingRate,
      trackingRateOptimized: mOpt.trackingRate,
      strictTrackAccuracyNaive: mNaive.strictTrackAccuracy,
      strictTrackAccuracyOptimized: mOpt.strictTrackAccuracy,
      localTrackAccuracyNaive: mNaive.localTrackAccuracy,
      localTrackAccuracyOptimized: mOpt.localTrackAccuracy,
      precisionNaive: mNaive.precision,
      precisionOptimized: mOpt.precision,
      recallNaive: mNaive.recall,
      recallOptimized: mOpt.recall,
      f1Naive: mNaive.f1,
      f1Optimized: mOpt.f1,
      mdrNaive: mNaive.mdr,
      mdrOptimized: mOpt.mdr,
      meanIoUNaive: mNaive.meanIoU,
      meanIoUOptimized: mOpt.meanIoU,
    };
    setCurrentMetrics(m);
    setMetricsHistory(prev => {
      const next = [...prev, m];
      if (next.length > 50) next.shift();
      return next;
    });
    syncSwimmerIds();
  };

  const requestPlans = (requests: PlanRequest[], reason: string) => {
    if (requests.length === 0) return false;

    const runtime = runtimeRef.current;
    if (runtime.inFlight) return true;

    const requestBySlot = new Map<RuntimeSlotName, PlanRequest>();
    for (const request of requests) requestBySlot.set(request.slot, request);

    runtime.inFlight = true;
    fixedStepAccumulatorRef.current = 0;
    const generation = runtimeGenerationRef.current;

    void Promise.all(Array.from(requestBySlot.values()).map(async request => {
      const slot = runtime.slots[request.slot];
      const decision = await planUiStrategyDecision(
        slot.strategy,
        slot.engine.getStrategySnapshot(),
        strategyClient
      );
      if (generation !== runtimeGenerationRef.current) return;
      slot.engine.applyStrategyDecision(decision);
      if (request.advanceSchedule) {
        slot.nextStrategyUpdateSec += STRATEGY_UPDATE_INTERVAL_SEC;
      }
    }))
      .then(() => {
        if (generation !== runtimeGenerationRef.current) return;
        strategyErrorRef.current = null;
        setStrategyError(null);
        setStrategyServiceOnline(true);
      })
      .catch(error => {
        if (generation !== runtimeGenerationRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Strategy planning failed during ${reason}; simulation paused.`, error);
        strategyErrorRef.current = message;
        runtime.retryNotBeforeMs = performance.now() + 1000;
        setStrategyError(message);
        setStrategyServiceOnline(false);
      })
      .finally(() => {
        if (generation === runtimeGenerationRef.current) runtime.inFlight = false;
      });

    return true;
  };

  const applyDueScenarioEvents = (slot: RuntimeSlotState) => {
    let changed = false;
    while (
      slot.nextEventIndex < UI_SETUP.scenario.events.length &&
      UI_SETUP.scenario.events[slot.nextEventIndex].timeSec <= slot.engine.time
    ) {
      applyBenchmarkScenarioEvent(slot.engine, UI_SETUP.scenario.events[slot.nextEventIndex]);
      slot.nextEventIndex += 1;
      changed = true;
    }
    return changed;
  };

  const advanceOneFixedStep = (wallNowMs: number) => {
    const runtime = runtimeRef.current;
    if (runtime.inFlight) return false;

    if (strategyErrorRef.current) {
      if (wallNowMs < runtime.retryNotBeforeMs) return false;
      strategyErrorRef.current = null;
      setStrategyError(null);
    }

    let scenarioChanged = false;
    const scheduledRequests: PlanRequest[] = [];
    for (const slotName of RUNTIME_SLOTS) {
      const slot = runtime.slots[slotName];
      scenarioChanged = applyDueScenarioEvents(slot) || scenarioChanged;
      if (slot.engine.time + 1e-9 >= slot.nextStrategyUpdateSec) {
        scheduledRequests.push({ slot: slotName, advanceSchedule: true });
      }
    }
    if (scenarioChanged) syncSwimmerIds();
    if (requestPlans(scheduledRequests, 'scheduled update')) return false;

    const baselineEvents = engineNaive.update(FIXED_DT_SEC, { autoSchedule: false });
    const candidateEvents = engineOpt.update(FIXED_DT_SEC, { autoSchedule: false });

    const immediateRequests: PlanRequest[] = [];
    if (baselineEvents.length > 0) immediateRequests.push({ slot: 'baseline', advanceSchedule: false });
    if (candidateEvents.length > 0) immediateRequests.push({ slot: 'candidate', advanceSchedule: false });
    if (requestPlans(immediateRequests, 'command completion')) return false;

    while (engineNaive.time + 1e-9 >= runtime.nextSampleSec) {
      sampleMetrics();
      runtime.nextSampleSec += SAMPLE_INTERVAL_SEC;
      if (SAMPLE_INTERVAL_SEC <= 0) break;
    }

    return true;
  };

  const resetBenchmarkRunForStrategies = (
    nextBaselineStrategy: string,
    nextCandidateStrategy: string,
    resetTuningToProfile: boolean
  ) => {
    const sensorParams = resetTuningToProfile ? UI_SETUP.sensorParams : tuning;
    runtimeGenerationRef.current += 1;
    engineNaive.strategy = nextBaselineStrategy;
    engineOpt.strategy = nextCandidateStrategy;
    resetEngineToBenchmarkScenario(engineNaive, UI_SETUP.scenario, sensorParams);
    resetEngineToBenchmarkScenario(engineOpt, UI_SETUP.scenario, sensorParams);
    runtimeRef.current = createRuntimeState(nextBaselineStrategy, nextCandidateStrategy);
    strategyErrorRef.current = null;
    fixedStepAccumulatorRef.current = 0;
    previousTimeRef.current = undefined;
    swimmerIdCounterRef.current = nextManualSwimmerIndex();
    if (resetTuningToProfile) setTuning({ ...UI_SETUP.sensorParams });
    setMetricsHistory([]);
    setCurrentMetrics(makeEmptyMetrics(engineNaive.time, engineNaive.swimmers.length));
    setSwimmerIds(engineSwimmerIds(engineNaive));
    setStrategyError(null);
    setStrategyServiceOnline(requiresStrategyService(nextBaselineStrategy, nextCandidateStrategy) ? null : true);
  };

  const resetBenchmarkRun = () => {
    resetBenchmarkRunForStrategies(baselineStrategy, candidateStrategy, true);
  };

  const handleBaselineStrategyChange = (nextStrategy: string) => {
    const normalized = nextStrategy.toUpperCase();
    setBaselineStrategy(normalized);
    setStrategy('BASELINE');
    resetBenchmarkRunForStrategies(normalized, candidateStrategy, false);
  };

  const handleCandidateStrategyChange = (nextStrategy: string) => {
    const normalized = nextStrategy.toUpperCase();
    setCandidateStrategy(normalized);
    setStrategy('CANDIDATE');
    resetBenchmarkRunForStrategies(baselineStrategy, normalized, false);
  };

  const animate = (time: number) => {
    if (previousTimeRef.current !== undefined) {
      const deltaTime = Math.min((time - previousTimeRef.current) / 1000, 0.5);
      fixedStepAccumulatorRef.current += deltaTime;

      let steps = 0;
      while (fixedStepAccumulatorRef.current + 1e-9 >= FIXED_DT_SEC && steps < MAX_CATCHUP_STEPS) {
        if (!advanceOneFixedStep(time)) break;
        fixedStepAccumulatorRef.current -= FIXED_DT_SEC;
        steps += 1;
      }
      if (steps === MAX_CATCHUP_STEPS) fixedStepAccumulatorRef.current = 0;
    }
    previousTimeRef.current = time;
    requestRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  const handleAddSwimmer = () => {
    const rng = swimmerRngRef.current!;
    const id = `W${(swimmerIdCounterRef.current++).toString().padStart(3, '0')}`;
    const enteredAt = engineNaive.time;
    const swimmer = createSwimmerFromSeededRng(rng, id, enteredAt);
    engineNaive.addSwimmer(swimmer);
    engineOpt.addSwimmer(swimmer);
    syncSwimmerIds();
  };

  const handleRemoveSwimmer = () => {
    const ids = engineSwimmerIds(engineNaive);
    if (ids.length === 0) return;
    const id = ids[ids.length - 1];
    engineNaive.removeSwimmerById(id);
    engineOpt.removeSwimmerById(id);
    syncSwimmerIds();
  };

  const displayEngine = strategy === 'BASELINE' ? engineNaive : engineOpt;
  const serviceText = strategyServiceRequired
    ? strategyServiceOnline === null
      ? 'connecting'
      : strategyServiceOnline
        ? 'connected'
        : 'offline (simulation paused)'
    : 'not required for selected CLI baselines';

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-8 px-4 font-sans text-slate-900">

      <header className="mb-6 text-center max-w-4xl">
        <h1 className="text-3xl font-extrabold text-slate-800 mb-2 tracking-tight">
          Multi-Beam Sonar Collective Scanning
        </h1>
        <p className="text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Comparing <span className="text-red-500 font-bold">{baselineStrategy}</span> vs.
          <span className="text-green-600 font-bold"> {candidateStrategy}</span> strategies in a simulated 50m x 20m pool.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          CLI repro: {UI_SETUP.summary}; sample {SAMPLE_INTERVAL_SEC}s; update {STRATEGY_UPDATE_INTERVAL_SEC}s.
        </p>
        <p className={`mt-1 text-xs ${strategyServiceOnline === false ? 'text-amber-600' : 'text-slate-400'}`}>
          Python strategy service: {serviceText}
        </p>
        {strategyError && (
          <p className="mt-1 text-xs text-amber-700">
            Strategy error: {strategyError}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-6 w-full max-w-5xl items-center">

        <div className="w-full bg-white p-6 rounded-2xl shadow-xl border border-slate-200 relative overflow-hidden flex flex-col items-center">

          <div className="absolute top-4 left-4 z-10 pointer-events-none text-xs font-mono text-slate-400 bg-white/90 px-2 py-1 rounded shadow-sm border border-slate-100">
            <div>Pool: 50m x 20m</div>
            <div>Sound Speed: {SPEED_OF_SOUND}m/s</div>
            <div>Mech Slew: {SLEW_SPEED}°/s</div>
          </div>

          <div className="absolute top-4 right-4 bg-white/90 px-3 py-2 rounded shadow-sm border border-slate-200 text-xs flex gap-4 z-10">
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-green-600"></div> Real Position</div>
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-red-500"></div> Detected Echo</div>
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 bg-slate-700 rounded-sm"></div> Sonar Unit</div>
          </div>

          <SonarCanvas engine={displayEngine} width={800} height={320} showMatchedOnly={showMatchedOnly} />

        </div>

        <div className="w-full">
          <Dashboard
            metricsHistory={metricsHistory}
            currentMetrics={currentMetrics}
            onAddSwimmer={handleAddSwimmer}
            onRemoveSwimmer={handleRemoveSwimmer}
            onResetBenchmarkRun={resetBenchmarkRun}
            strategy={strategy}
            setStrategy={setStrategy}
            baselineStrategyOptions={baselineStrategyOptions}
            candidateStrategyOptions={candidateStrategyOptions}
            onBaselineStrategyChange={handleBaselineStrategyChange}
            onCandidateStrategyChange={handleCandidateStrategyChange}
            swimmerCount={swimmerIds.length}
            evalWindowSec={evalWindowSec}
            setEvalWindowSec={setEvalWindowSec}
            tuning={tuning}
            setTuning={setTuning}
            sensorProfileTuning={UI_SETUP.sensorParams}
            showMatchedOnly={showMatchedOnly}
            setShowMatchedOnly={setShowMatchedOnly}
            baselineStrategyId={baselineStrategy}
            candidateStrategyId={candidateStrategy}
            baselineStrategyName={strategyLabel(baselineStrategy)}
            candidateStrategyName={strategyLabel(candidateStrategy)}
            benchmarkInfo={{
              scenarioName: UI_SETUP.scenario.name,
              scenarioDescription: UI_SETUP.scenario.description,
              seed: UI_SETUP.seed,
              sensorProfile: UI_SETUP.config.sensorProfile,
              dtSec: FIXED_DT_SEC,
              sampleIntervalSec: SAMPLE_INTERVAL_SEC,
              strategyUpdateIntervalSec: STRATEGY_UPDATE_INTERVAL_SEC,
              sonarCount: UI_SETUP.config.sonarCount,
              tdmaEnabled: UI_SETUP.config.tdmaEnabled,
            }}
          />
        </div>

      </div>
    </div>
  );
}

export default App;
