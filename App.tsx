import React, { useEffect, useRef, useState } from 'react';
import { SimulationEngine } from './services/SimulationEngine';
import SonarCanvas from './components/SonarCanvas';
import { Dashboard } from './components/Dashboard';
import { SimulationMetrics, Swimmer, Vector2 } from './types';
import { POOL_LENGTH, POOL_WIDTH, SWIMMER_SPEED_MAX, SWIMMER_SPEED_MIN } from './constants';
import { createLCGRng, SeededRng } from './utils/rng';

const EVAL_SEED = 1337;
const EVAL_WINDOW_SEC = 10;
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
  });
  const [strategy, setStrategy] = useState<'NAIVE' | 'OPTIMIZED'>('NAIVE');
  const [swimmerIds, setSwimmerIds] = useState<string[]>([]);

  // Using refs for animation loop
  const requestRef = useRef<number | undefined>(undefined);
  const previousTimeRef = useRef<number | undefined>(undefined);
  const sampleAccumulatorRef = useRef(0);
  const swimmerIdCounterRef = useRef(0);
  const swimmerRngRef = useRef<SeededRng | null>(null);
  if (!swimmerRngRef.current) swimmerRngRef.current = createLCGRng(202503);

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
        const mNaive = engineNaive.getEvalMetrics(EVAL_WINDOW_SEC);
        const mOpt = engineOpt.getEvalMetrics(EVAL_WINDOW_SEC);
        const m: SimulationMetrics = {
          timestamp: engineNaive.time,
          activeSwimmers: engineNaive.swimmers.length,
          avgAoISecNaive: mNaive.avgAoISec,
          avgAoISecOptimized: mOpt.avgAoISec,
          trackingRMSEmNaive: mNaive.trackingRMSEm,
          trackingRMSEmOptimized: mOpt.trackingRMSEm,
          avgScanRateHzNaive: mNaive.avgScanRateHz,
          avgScanRateHzOptimized: mOpt.avgScanRateHz,
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
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4 font-sans text-slate-900">
      
      <header className="mb-4 text-center max-w-3xl">
        <h1 className="text-2xl font-extrabold text-slate-800 mb-1">
          Multi-Beam Sonar Collaborative Scanning
        </h1>
        <p className="text-sm text-slate-600">
          Comparing <span className="text-red-500 font-bold">Naive Full-Sweep</span> vs. 
          <span className="text-green-600 font-bold"> PSO/Optimized</span>. 
          The optimized strategy reduces scan range and slews rapidly over empty space (gray beams) to maximize refresh rate on targets.
        </p>
      </header>

      <div className="flex flex-col lg:flex-row gap-6 w-full max-w-5xl justify-center">
        
        {/* Left: Simulation Canvas */}
        <div className="flex-grow-0 bg-white p-4 rounded-xl shadow-lg border border-slate-200 relative overflow-hidden flex items-center justify-center">
          <div className="relative">
             {/* Physics Overlay Info */}
             <div className="absolute top-2 left-2 z-10 pointer-events-none text-xs font-mono text-slate-400 bg-white/80 p-1 rounded">
                <div>Pool: 20m x 50m</div>
                <div>Sound Speed: 1500m/s</div>
                <div>Mech Slew: 180°/s</div>
             </div>
             <SonarCanvas engine={displayEngine} width={300} height={750} />
             
             {/* Legend */}
             <div className="absolute bottom-2 right-2 bg-white/90 p-2 rounded border border-slate-200 text-xs shadow-sm">
                <div className="flex items-center gap-2 mb-1"><div className="w-3 h-3 rounded-full bg-green-700"></div> Real Position</div>
                <div className="flex items-center gap-2 mb-1"><div className="w-3 h-3 rounded-full bg-red-500"></div> Detected Echo</div>
                <div className="flex items-center gap-2 mb-1"><div className="w-3 h-3 bg-slate-700"></div> Sonar Unit</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 bg-green-200"></div> Active Scan</div>
             </div>
          </div>
        </div>

        {/* Right: Controls & Metrics */}
        <div className="w-full lg:w-96 shrink-0 flex flex-col justify-center">
          <Dashboard 
             metricsHistory={metricsHistory}
             currentMetrics={currentMetrics}
             onAddSwimmer={handleAddSwimmer}
             onRemoveSwimmer={handleRemoveSwimmer}
             strategy={strategy}
             setStrategy={setStrategy}
             swimmerCount={swimmerIds.length}
          />
          
          <div className="mt-4 text-center text-slate-400 text-xs max-w-xs mx-auto">
             <p>
               <strong>Optimization Note:</strong> In Naive strategy, sonar waits for sound to travel the full diagonal (~54m) 
               every step. In Optimized, scan range adapts to target distance, and mechanical head rotates at max speed (Slewing) over empty space.
             </p>
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;
