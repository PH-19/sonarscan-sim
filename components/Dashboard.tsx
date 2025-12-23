import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { EngineTuningParams } from '../services/SimulationEngine';
import { SimulationMetrics } from '../types';

interface DashboardProps {
  metricsHistory: SimulationMetrics[];
  currentMetrics: SimulationMetrics;
  onAddSwimmer: () => void;
  onRemoveSwimmer: () => void;
  strategy: 'NAIVE' | 'OPTIMIZED';
  setStrategy: (s: 'NAIVE' | 'OPTIMIZED') => void;
  swimmerCount: number;
  evalWindowSec: number;
  setEvalWindowSec: (s: number) => void;
  tuning: EngineTuningParams;
  setTuning: React.Dispatch<React.SetStateAction<EngineTuningParams>>;
  showMatchedOnly: boolean;
  setShowMatchedOnly: (v: boolean) => void;
}

const MetricCard: React.FC<{
  title: string;
  naive: number;
  opt: number;
  unit?: string;
  naiveColor?: string;
  optColor?: string;
  formatter?: (v: number) => string;
}> = ({ title, naive, opt, unit = '', naiveColor = 'text-red-500', optColor = 'text-green-600', formatter = (v) => v.toFixed(2) }) => {
  const diff = opt - naive;
  const pct = naive !== 0 ? ((opt - naive) / Math.abs(naive)) * 100 : 0;

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
        <div className={`text-xs mt-1 font-medium ${diff > 0 ? 'text-blue-600' : 'text-slate-500'}`}>
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
  strategy,
  setStrategy,
  swimmerCount,
  evalWindowSec,
  setEvalWindowSec,
  tuning,
  setTuning,
  showMatchedOnly,
  setShowMatchedOnly
}) => {
  const updateTuning = (patch: Partial<EngineTuningParams>) => {
    setTuning(prev => ({ ...prev, ...patch }));
  };

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* 1. Top Controls Bar */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">

        {/* Strategy Selection */}
        <div className="md:col-span-4 bg-white p-1 rounded-xl shadow-sm border border-slate-200 flex">
          <button
            onClick={() => setStrategy('NAIVE')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${strategy === 'NAIVE'
              ? 'bg-red-50 text-red-600 shadow-sm ring-1 ring-red-200'
              : 'text-slate-400 hover:text-slate-600'
              }`}
          >
            NAIVE (Full Scan)
          </button>
          <button
            onClick={() => setStrategy('OPTIMIZED')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${strategy === 'OPTIMIZED'
              ? 'bg-green-50 text-green-600 shadow-sm ring-1 ring-green-200'
              : 'text-slate-400 hover:text-slate-600'
              }`}
          >
            OPTIMIZED (PSO)
          </button>
        </div>

        {/* Swimmer Controls */}
        <div className="md:col-span-3 bg-white p-2 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between px-4">
          <span className="text-xs font-bold text-slate-500 uppercase">Swimmers: {swimmerCount}</span>
          <div className="flex gap-2">
            <button onClick={onRemoveSwimmer} className="w-8 h-8 flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-bold">-</button>
            <button onClick={onAddSwimmer} className="w-8 h-8 flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold">+</button>
          </div>
        </div>

        {/* Global toggles */}
        <div className="md:col-span-5 bg-white p-2 rounded-xl shadow-sm border border-slate-200 flex items-center px-4 gap-6">
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

      {/* 2. Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <MetricCard
          title="Scan Rate"
          naive={currentMetrics.avgScanRateHzNaive}
          opt={currentMetrics.avgScanRateHzOptimized}
          unit="Hz"
          direction="high"
          formatter={(v) => v.toFixed(1)}
        />
        <MetricCard
          title="Freshness (AoI)"
          naive={currentMetrics.avgAoISecNaive}
          opt={currentMetrics.avgAoISecOptimized}
          unit="s"
          direction="low"
          formatter={(v) => v.toFixed(2)}
        />
        <MetricCard
          title="Tracking RMSE"
          naive={currentMetrics.trackingRMSEmNaive}
          opt={currentMetrics.trackingRMSEmOptimized}
          unit="m"
          direction="low"
        />
        <MetricCard
          title="False Alarms"
          naive={currentMetrics.falseAlarmsPerSecNaive}
          opt={currentMetrics.falseAlarmsPerSecOptimized}
          unit="/s"
          direction="low"
        />
        <MetricCard
          title="Hit Rate"
          naive={currentMetrics.detectionHitRateNaive * 100}
          opt={currentMetrics.detectionHitRateOptimized * 100}
          unit="%"
          direction="high"
          formatter={(v) => v.toFixed(0)}
        />
      </div>

      {/* 3. Bottom Area: Tuning & Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[300px]">

        {/* Tuning Panel */}
        <div className="lg:col-span-4 bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Signal Tuning</h3>
            <button
              onClick={() => setTuning({
                noiseScale: 0.85,
                speckleProb: 0.015,
                threshold: 1.05,
                dbscanEpsBins: 2.0,
                dbscanMinPts: 8,
                kernelCap: 11,
              })}
              className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded"
            >
              RESET
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
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Performance Trend (Scan Rate Hz)</h3>
          <div className="flex-1 min-h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={metricsHistory}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="timestamp" hide />
                <YAxis
                  domain={[0, 'auto']}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: '#64748b' }}
                />
                <Tooltip
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Legend wrapperStyle={{ paddingTop: '10px' }} />
                <Line
                  type="monotone"
                  dataKey="avgScanRateHzNaive"
                  stroke="#ef4444"
                  strokeWidth={2}
                  name="Naive Scan Rate"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="avgScanRateHzOptimized"
                  stroke="#16a34a"
                  strokeWidth={2}
                  name="Optimized Scan Rate"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  );
};
