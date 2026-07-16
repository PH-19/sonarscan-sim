import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { EngineTuningParams } from '../services/SimulationEngine';
import { SimulationMetrics } from '../types';
import type { UiStrategyOption } from '../services/sim/strategy/StrategyCatalog.ts';

interface DashboardProps {
  metricsHistory: SimulationMetrics[];
  currentMetrics: SimulationMetrics;
  onAddSwimmer: () => void;
  onRemoveSwimmer: () => void;
  onResetBenchmarkRun: () => void;
  strategy: 'BASELINE' | 'CANDIDATE';
  setStrategy: (s: 'BASELINE' | 'CANDIDATE') => void;
  baselineStrategyOptions: UiStrategyOption[];
  candidateStrategyOptions: UiStrategyOption[];
  onBaselineStrategyChange: (strategy: string) => void;
  onCandidateStrategyChange: (strategy: string) => void;
  swimmerCount: number;
  evalWindowSec: number;
  setEvalWindowSec: (s: number) => void;
  tuning: EngineTuningParams;
  setTuning: React.Dispatch<React.SetStateAction<EngineTuningParams>>;
  sensorProfileTuning: EngineTuningParams;
  showMatchedOnly: boolean;
  setShowMatchedOnly: (v: boolean) => void;
  baselineStrategyId: string;
  candidateStrategyId: string;
  baselineStrategyName: string;
  candidateStrategyName: string;
  benchmarkInfo: {
    scenarioName: string;
    scenarioDescription: string;
    seed: number;
    sensorProfile: string;
    dtSec: number;
    sampleIntervalSec: number;
    strategyUpdateIntervalSec: number;
    sonarCount: number;
    tdmaEnabled: boolean;
  };
}

const MetricCard: React.FC<{
  title: string;
  naive: number;
  opt: number;
  unit?: string;
  naiveColor?: string;
  optColor?: string;
  direction?: 'higherBetter' | 'lowerBetter';
  formatter?: (v: number) => string;
}> = ({ title, naive, opt, unit = '', naiveColor = 'text-red-500', optColor = 'text-green-600', direction = 'higherBetter', formatter = (v) => v.toFixed(2) }) => {
  const diff = opt - naive;
  const pct = naive !== 0 ? ((opt - naive) / Math.abs(naive)) * 100 : 0;
  const improved = direction === 'higherBetter' ? diff > 0 : diff < 0;
  const diffColor = improved ? 'text-green-600' : 'text-red-400';

  return (
    <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">{title}</div>
      <div className="flex items-baseline gap-2">
        <div className={`text-lg font-mono font-bold ${naiveColor}`}>
          {formatter(naive)}
        </div>
        <span className="text-slate-300">→</span>
        <div className={`text-lg font-mono font-bold ${optColor}`}>
          {formatter(opt)}
        </div>
        <span className="text-xs text-slate-400 font-medium">{unit}</span>
      </div>
      {naive !== 0 && (
        <div className={`text-xs mt-1 font-medium ${diffColor}`}>
          {pct > 0 ? '+' : ''}{pct.toFixed(0)}%
        </div>
      )}
    </div>
  );
};

export const Dashboard: React.FC<DashboardProps> = ({
  metricsHistory,
  currentMetrics,
  onAddSwimmer,
  onRemoveSwimmer,
  onResetBenchmarkRun,
  strategy,
  setStrategy,
  baselineStrategyOptions,
  candidateStrategyOptions,
  onBaselineStrategyChange,
  onCandidateStrategyChange,
  swimmerCount,
  evalWindowSec,
  setEvalWindowSec,
  tuning,
  setTuning,
  sensorProfileTuning,
  showMatchedOnly,
  setShowMatchedOnly,
  baselineStrategyId,
  candidateStrategyId,
  baselineStrategyName,
  candidateStrategyName,
  benchmarkInfo
}) => {
  const updateTuning = (patch: Partial<EngineTuningParams>) => {
    setTuning(prev => ({ ...prev, ...patch }));
  };

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* 1. Top Controls Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

        {/* Strategy Selection */}
        <div className="lg:col-span-4 bg-white p-1 rounded-xl shadow-sm border border-slate-200 flex">
          <button
            onClick={() => setStrategy('BASELINE')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${strategy === 'BASELINE'
              ? 'bg-red-50 text-red-600 shadow-sm ring-1 ring-red-200'
              : 'text-slate-400 hover:text-slate-600'
              }`}
          >
            {baselineStrategyName}
          </button>
          <button
            onClick={() => setStrategy('CANDIDATE')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${strategy === 'CANDIDATE'
              ? 'bg-green-50 text-green-600 shadow-sm ring-1 ring-green-200'
              : 'text-slate-400 hover:text-slate-600'
              }`}
          >
            {candidateStrategyName}
          </button>
        </div>

        {/* Strategy Pair Controls */}
        <div className="lg:col-span-8 bg-white p-3 rounded-xl shadow-sm border border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="min-w-0">
            <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">
              Baseline Strategy
            </span>
            <select
              value={baselineStrategyId}
              onChange={event => onBaselineStrategyChange(event.target.value)}
              className="w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs font-mono font-semibold text-slate-700 outline-none focus:border-red-300 focus:ring-2 focus:ring-red-100"
            >
              {baselineStrategyOptions.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">
              Candidate Strategy
            </span>
            <select
              value={candidateStrategyId}
              onChange={event => onCandidateStrategyChange(event.target.value)}
              className="w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs font-mono font-semibold text-slate-700 outline-none focus:border-green-300 focus:ring-2 focus:ring-green-100"
            >
              {candidateStrategyOptions.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        {/* Swimmer Controls */}
        <div className="lg:col-span-3 bg-white p-2 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between px-4">
          <span className="text-xs font-bold text-slate-500 uppercase">Swimmers: {swimmerCount}</span>
          <div className="flex gap-2">
            <button onClick={onRemoveSwimmer} className="w-8 h-8 flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-bold">-</button>
            <button onClick={onAddSwimmer} className="w-8 h-8 flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold">+</button>
          </div>
        </div>

        {/* Global toggles */}
        <div className="lg:col-span-9 bg-white p-2 rounded-xl shadow-sm border border-slate-200 flex items-center px-4 gap-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showMatchedOnly}
              onChange={e => setShowMatchedOnly(e.target.checked)}
              className="w-4 h-4 accent-blue-600 rounded"
            />
            <span className="text-sm font-medium text-slate-600">Matched Detections Only</span>
          </label>

          <div className="h-6 w-px bg-slate-200 mx-2"></div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-400 uppercase">Window:</span>
            <button
              onClick={() => setEvalWindowSec(10)}
              className={`text-xs px-2 py-1 rounded ${evalWindowSec === 10 ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >10s</button>
            <button
              onClick={() => setEvalWindowSec(30)}
              className={`text-xs px-2 py-1 rounded ${evalWindowSec === 30 ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >30s</button>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 text-slate-100 rounded-xl shadow-sm border border-slate-800 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-400">CLI Benchmark Repro</div>
          <div className="text-sm font-semibold">
            {benchmarkInfo.scenarioName} · seed {benchmarkInfo.seed} · {benchmarkInfo.sensorProfile}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {benchmarkInfo.scenarioDescription}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            sonarCount={benchmarkInfo.sonarCount}, tdma={benchmarkInfo.tdmaEnabled ? 'on' : 'off'}, dt={benchmarkInfo.dtSec}s, sample={benchmarkInfo.sampleIntervalSec}s, strategyUpdate={benchmarkInfo.strategyUpdateIntervalSec}s
          </div>
        </div>
        <button
          onClick={onResetBenchmarkRun}
          className="text-xs bg-slate-100 hover:bg-white text-slate-800 px-3 py-2 rounded-lg font-bold"
        >
          Reset CLI Repro Run
        </button>
      </div>

      {/* 2. Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard
          title="Tracking Accuracy"
          naive={currentMetrics.strictTrackAccuracyNaive * 100}
          opt={currentMetrics.strictTrackAccuracyOptimized * 100}
          unit="%"
          direction="higherBetter"
          formatter={(v) => v.toFixed(0)}
        />
        <MetricCard
          title="Local Track Acc."
          naive={currentMetrics.localTrackAccuracyNaive * 100}
          opt={currentMetrics.localTrackAccuracyOptimized * 100}
          unit="%"
          direction="higherBetter"
          formatter={(v) => v.toFixed(0)}
        />
        <MetricCard
          title="Average AoI"
          naive={currentMetrics.avgAoISecNaive}
          opt={currentMetrics.avgAoISecOptimized}
          unit="s"
          direction="lowerBetter"
        />
        <MetricCard
          title="Avg Scan Rate"
          naive={currentMetrics.avgScanRateHzNaive}
          opt={currentMetrics.avgScanRateHzOptimized}
          unit="Hz"
          direction="higherBetter"
          formatter={(v) => v.toFixed(1)}
        />
      </div>

      {/* 3. Bottom Area: Tuning & Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[300px]">

        {/* Tuning Panel */}
        <div className="lg:col-span-4 bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Signal Tuning</h3>
            <button
              onClick={() => setTuning({ ...sensorProfileTuning })}
              className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded"
            >
              RESET PROFILE
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>Noise Scale</span>
                <span className="font-mono">{tuning.noiseScale.toFixed(2)}</span>
              </div>
              <input type="range" min="0" max="3" step="0.05" value={tuning.noiseScale} onChange={e => updateTuning({ noiseScale: Number(e.target.value) })} className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-600" />
            </div>
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>Speckle Prob</span>
                <span className="font-mono">{tuning.speckleProb.toFixed(4)}</span>
              </div>
              <input type="range" min="0" max="0.1" step="0.001" value={tuning.speckleProb} onChange={e => updateTuning({ speckleProb: Number(e.target.value) })} className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-600" />
            </div>
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>Threshold</span>
                <span className="font-mono">{tuning.threshold.toFixed(2)}</span>
              </div>
              <input type="range" min="0.5" max="2" step="0.01" value={tuning.threshold} onChange={e => updateTuning({ threshold: Number(e.target.value) })} className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-600" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>DBSCAN Eps</span>
                  <span className="font-mono">{tuning.dbscanEpsBins}</span>
                </div>
                <input type="range" min="0.5" max="5" step="0.1" value={tuning.dbscanEpsBins} onChange={e => updateTuning({ dbscanEpsBins: Number(e.target.value) })} className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-600" />
              </div>
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>MinPts</span>
                  <span className="font-mono">{tuning.dbscanMinPts}</span>
                </div>
                <input type="range" min="3" max="20" step="1" value={tuning.dbscanMinPts} onChange={e => updateTuning({ dbscanMinPts: Number(e.target.value) })} className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-600" />
              </div>
            </div>
            <div className="p-3 bg-slate-50 rounded text-xs text-slate-500 leading-relaxed italic border border-slate-100">
              Adjust thresholds to balance False Alarm Rate vs. Detection Probability.
            </div>
          </div>
        </div>

        {/* Chart */}
        <div className="lg:col-span-8 bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex flex-col">
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Performance Comparison</h3>
          <div className="flex-1 min-h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={metricsHistory}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="timestamp" hide />
                <YAxis
                  yAxisId="left"
                  domain={[0, 1]}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: '#64748b' }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={[0, 'auto']}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: '#64748b' }}
                />
                <Tooltip
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Legend wrapperStyle={{ paddingTop: '10px' }} />
                <Line yAxisId="left" type="monotone" dataKey="strictTrackAccuracyNaive" stroke="#ef4444" strokeWidth={2} name="Tracking Acc. Baseline" dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="strictTrackAccuracyOptimized" stroke="#16a34a" strokeWidth={2} name="Tracking Acc. Candidate" dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="localTrackAccuracyNaive" stroke="#f43f5e" strokeWidth={1.5} name="Local Acc. Baseline" dot={false} strokeDasharray="2 3" />
                <Line yAxisId="left" type="monotone" dataKey="localTrackAccuracyOptimized" stroke="#22c55e" strokeWidth={1.5} name="Local Acc. Candidate" dot={false} strokeDasharray="2 3" />
                <Line yAxisId="right" type="monotone" dataKey="avgAoISecNaive" stroke="#f97316" strokeWidth={1.8} name="AoI Baseline" dot={false} strokeDasharray="4 4" />
                <Line yAxisId="right" type="monotone" dataKey="avgAoISecOptimized" stroke="#06b6d4" strokeWidth={1.8} name="AoI Candidate" dot={false} strokeDasharray="4 4" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  );
};
