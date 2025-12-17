import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { SimulationMetrics } from '../types';

interface DashboardProps {
  metricsHistory: SimulationMetrics[];
  currentMetrics: SimulationMetrics;
  onAddSwimmer: () => void;
  onRemoveSwimmer: () => void;
  strategy: 'NAIVE' | 'OPTIMIZED';
  setStrategy: (s: 'NAIVE' | 'OPTIMIZED') => void;
  swimmerCount: number;
}

export const Dashboard: React.FC<DashboardProps> = ({
  metricsHistory,
  currentMetrics,
  onAddSwimmer,
  onRemoveSwimmer,
  strategy,
  setStrategy,
  swimmerCount
}) => {
  const scanGainPct =
    currentMetrics.avgScanRateHzNaive > 0
      ? (currentMetrics.avgScanRateHzOptimized / currentMetrics.avgScanRateHzNaive - 1) * 100
      : 0;
  const aoiReductionPct =
    currentMetrics.avgAoISecNaive > 0
      ? (1 - currentMetrics.avgAoISecOptimized / currentMetrics.avgAoISecNaive) * 100
      : 0;
  const rmseReductionPct =
    currentMetrics.trackingRMSEmNaive > 0
      ? (1 - currentMetrics.trackingRMSEmOptimized / currentMetrics.trackingRMSEmNaive) * 100
      : 0;

  return (
    <div className="flex flex-col gap-4 p-4 bg-white rounded-xl shadow-lg border border-slate-200 h-full">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-xl font-bold text-slate-800">Sonar Control</h2>
        <div className="flex gap-2">
           <button 
             onClick={onAddSwimmer}
             className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded shadow text-sm"
           >
             + Swimmer
           </button>
           <button 
             onClick={onRemoveSwimmer}
             className="px-3 py-1 bg-red-500 hover:bg-red-600 text-white rounded shadow text-sm"
           >
             - Swimmer
           </button>
        </div>
      </div>

      {/* Strategy Toggle */}
      <div className="flex gap-2 p-1 bg-slate-100 rounded-lg">
        <button
          onClick={() => setStrategy('NAIVE')}
          className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${
            strategy === 'NAIVE' 
            ? 'bg-white text-blue-600 shadow' 
            : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Naive (Full Scan)
        </button>
        <button
          onClick={() => setStrategy('OPTIMIZED')}
          className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${
            strategy === 'OPTIMIZED' 
            ? 'bg-white text-green-600 shadow' 
            : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          PSO/Optimized (Adaptive)
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 mt-2">
        <div className="bg-slate-50 p-3 rounded border">
          <div className="text-xs text-slate-500 uppercase">Avg Scan Rate / Swimmer (Naive → Optimized)</div>
          <div className="text-lg font-mono font-bold text-slate-700">
            <span className="text-red-600">{currentMetrics.avgScanRateHzNaive.toFixed(2)}</span>
            <span className="text-slate-400 mx-1">→</span>
            <span className="text-green-700">{currentMetrics.avgScanRateHzOptimized.toFixed(2)}</span>
            <span className="text-sm font-normal text-slate-400 ml-1">Hz</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Gain: {scanGainPct.toFixed(0)}%</div>
        </div>

        <div className="bg-slate-50 p-3 rounded border">
          <div className="text-xs text-slate-500 uppercase">Update Freshness (Avg AoI, Naive → Optimized)</div>
          <div className="text-lg font-mono font-bold text-slate-700">
            <span className="text-red-600">{currentMetrics.avgAoISecNaive.toFixed(2)}</span>
            <span className="text-slate-400 mx-1">→</span>
            <span className="text-green-700">{currentMetrics.avgAoISecOptimized.toFixed(2)}</span>
            <span className="text-sm font-normal text-slate-400 ml-1">s</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Reduction: {aoiReductionPct.toFixed(0)}%</div>
        </div>

        <div className="bg-slate-50 p-3 rounded border">
          <div className="text-xs text-slate-500 uppercase">Tracking Quality (RMSE, Naive → Optimized)</div>
          <div className="text-lg font-mono font-bold text-slate-700">
            <span className="text-red-600">{currentMetrics.trackingRMSEmNaive.toFixed(2)}</span>
            <span className="text-slate-400 mx-1">→</span>
            <span className="text-green-700">{currentMetrics.trackingRMSEmOptimized.toFixed(2)}</span>
            <span className="text-sm font-normal text-slate-400 ml-1">m</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Reduction: {rmseReductionPct.toFixed(0)}%</div>
        </div>
      </div>

      {/* Charts */}
      <div className="flex-1 min-h-[150px] flex flex-col">
        <h3 className="text-sm font-semibold text-slate-600 mb-2">Avg Scan Rate (Hz, higher is better)</h3>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={metricsHistory}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="timestamp" hide />
            <YAxis domain={[0, (dataMax: number) => Math.max(0.5, dataMax * 1.2)]} />
            <Tooltip 
              contentStyle={{ backgroundColor: '#fff', borderRadius: '8px', fontSize: '12px' }}
              labelFormatter={() => ''}
            />
            <Legend />
            <Line 
              type="monotone" 
              dataKey="avgScanRateHzNaive" 
              stroke="#ef4444" 
              strokeWidth={2} 
              name="Naive Scan Rate" 
              dot={false}
            />
            <Line 
              type="monotone" 
              dataKey="avgScanRateHzOptimized" 
              stroke="#22c55e" 
              strokeWidth={2} 
              name="Optimized Scan Rate" 
              dot={false} 
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="text-xs text-slate-400 mt-2">
        <p>Swimmers: {swimmerCount} | Sim Time: {currentMetrics.timestamp.toFixed(1)}s</p>
      </div>
    </div>
  );
};
