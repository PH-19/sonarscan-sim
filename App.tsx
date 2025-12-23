import React, { useEffect, useRef, useState } from 'react';
import { EngineTuningParams, SimulationEngine } from './services/SimulationEngine';
import SonarCanvas from './components/SonarCanvas';
import { Dashboard } from './components/Dashboard';
import { SimulationMetrics, Swimmer, Vector2 } from './types';
import { POOL_LENGTH, POOL_WIDTH, SLEW_SPEED, SPEED_OF_SOUND, SWIMMER_SPEED_MAX, SWIMMER_SPEED_MIN } from './constants';
import { createLCGRng, SeededRng } from './utils/rng';

const EVAL_SEED = 1337;
const METRICS_SAMPLE_SEC = 0.2;

// Two parallel engines for fair comparison
const engineNaive = new SimulationEngine({ strategy: 'NAIVE', evalSeed: EVAL_SEED });
const engineOpt = new SimulationEngine({ strategy: 'OPTIMIZED', evalSeed: EVAL_SEED });

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
    case 0: // Top
      position = { x: rng.nextRange(0, POOL_WIDTH), y: 0 };
      direction = { x: rng.nextRange(-0.5, 0.5), y: 1 };
      break;
    case 1: // Bottom
      position = { x: rng.nextRange(0, POOL_WIDTH), y: POOL_LENGTH };
      direction = { x: rng.nextRange(-0.5, 0.5), y: -1 };
      break;
    case 2: // Left
      position = { x: 0, y: rng.nextRange(0, POOL_LENGTH) };
      direction = { x: 1, y: rng.nextRange(-0.5, 0.5) };
      break;
    case 3: // Right
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

function App() {
  const [evalWindowSec, setEvalWindowSec] = useState(10);
  const [tuning, setTuning] = useState<EngineTuningParams>({
    noiseScale: 0.85,
    speckleProb: 0.015,
    threshold: 1.05,
    dbscanEpsBins: 2.0,
    dbscanMinPts: 8,
    kernelCap: 11,
  });
  const [metricsHistory, setMetricsHistory] = useState<SimulationMetrics[]>([]);
  const [currentMetrics, setCurrentMetrics] = useState<SimulationMetrics>({
    timestamp: 0,
    activeSwimmers: 0,
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
  const [strategy, setStrategy] = useState<'NAIVE' | 'OPTIMIZED'>('NAIVE');
  const [swimmerIds, setSwimmerIds] = useState<string[]>([]);
  const [showMatchedOnly, setShowMatchedOnly] = useState(false);

  // Using refs for animation loop
  const requestRef = useRef<number | undefined>(undefined);
  const previousTimeRef = useRef<number | undefined>(undefined);
  const sampleAccumulatorRef = useRef(0);
  const swimmerIdCounterRef = useRef(0);
  const swimmerRngRef = useRef<SeededRng | null>(null);
  if (!swimmerRngRef.current) swimmerRngRef.current = createLCGRng(202503);

  useEffect(() => {
    engineNaive.setTuningParams(tuning);
    engineOpt.setTuningParams(tuning);
  }, [tuning]);

  const animate = (time: number) => {
    if (previousTimeRef.current !== undefined) {
      const deltaTime = (time - previousTimeRef.current) / 1000;
      // Cap dt to avoid spirals if tab inactive
      const dt = Math.min(deltaTime, 0.1);

      engineNaive.update(dt);
      engineOpt.update(dt);

      // Fixed cadence metrics sampling
      sampleAccumulatorRef.current += dt;
      if (sampleAccumulatorRef.current >= METRICS_SAMPLE_SEC) {
        sampleAccumulatorRef.current -= METRICS_SAMPLE_SEC;
        const mNaive = engineNaive.getEvalMetrics(evalWindowSec);
        const mOpt = engineOpt.getEvalMetrics(evalWindowSec);
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
      }
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
    setSwimmerIds(prev => [...prev, id]);
  };

  const handleRemoveSwimmer = () => {
    setSwimmerIds(prev => {
      if (prev.length === 0) return prev;
      const id = prev[prev.length - 1];
      engineNaive.removeSwimmerById(id);
      engineOpt.removeSwimmerById(id);
      return prev.slice(0, -1);
    });
  };

  const displayEngine = strategy === 'NAIVE' ? engineNaive : engineOpt;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-8 px-4 font-sans text-slate-900">

      <header className="mb-6 text-center max-w-4xl">
        <h1 className="text-3xl font-extrabold text-slate-800 mb-2 tracking-tight">
          Multi-Beam Sonar Collective Scanning
        </h1>
        <p className="text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Comparing <span className="text-red-500 font-bold">Naive Full-Sweep</span> vs.
          <span className="text-green-600 font-bold"> PSO/Optimized</span> strategies in a simulated 50m x 20m pool.
        </p>
      </header>

      <div className="flex flex-col gap-6 w-full max-w-5xl items-center">

        {/* Visual Simulation Area */}
        <div className="w-full bg-white p-6 rounded-2xl shadow-xl border border-slate-200 relative overflow-hidden flex flex-col items-center">

          {/* Physics Overlay Info */}
          <div className="absolute top-4 left-4 z-10 pointer-events-none text-xs font-mono text-slate-400 bg-white/90 px-2 py-1 rounded shadow-sm border border-slate-100">
            <div>Pool: 50m x 20m</div>
            <div>Sound Speed: {SPEED_OF_SOUND}m/s</div>
            <div>Mech Slew: {SLEW_SPEED}°/s</div>
          </div>

          {/* Legend */}
          <div className="absolute top-4 right-4 bg-white/90 px-3 py-2 rounded shadow-sm border border-slate-200 text-xs flex gap-4 z-10">
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-green-600"></div> Real Position</div>
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-red-500"></div> Detected Echo</div>
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 bg-slate-700 rounded-sm"></div> Sonar Unit</div>
          </div>

          <SonarCanvas engine={displayEngine} width={800} height={320} showMatchedOnly={showMatchedOnly} />


        </div>

        {/* Dashboard Area (Full Width Below) */}
        <div className="w-full">
          <Dashboard
            metricsHistory={metricsHistory}
            currentMetrics={currentMetrics}
            onAddSwimmer={handleAddSwimmer}
            onRemoveSwimmer={handleRemoveSwimmer}
            strategy={strategy}
            setStrategy={setStrategy}
            swimmerCount={swimmerIds.length}
            evalWindowSec={evalWindowSec}
            setEvalWindowSec={setEvalWindowSec}
            tuning={tuning}
            setTuning={setTuning}
            showMatchedOnly={showMatchedOnly}
            setShowMatchedOnly={setShowMatchedOnly}
          />
        </div>

      </div>
    </div>
  );
}

export default App;
