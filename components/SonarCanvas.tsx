import React, { useRef, useEffect } from 'react';
import { SimulationEngine } from '../services/SimulationEngine';
import { POOL_WIDTH, POOL_LENGTH, COLOR_PALETTE, IMAGING_FOV_DEG } from '../constants';
import { localToWorldBearing } from '../services/sim/sonar/SonarCoordinates';

interface Props {
  engine: SimulationEngine;
  width: number;
  height: number;
  showMatchedOnly: boolean;
}

const SonarCanvas: React.FC<Props> = ({ engine, width, height, showMatchedOnly }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = (ctx: CanvasRenderingContext2D) => {
    ctx.clearRect(0, 0, width, height);

    const scaleX = width / POOL_LENGTH;
    const scaleY = height / POOL_WIDTH;
    const scale = Math.min(scaleX, scaleY);
    const viewWidth = POOL_LENGTH * scale;
    const viewHeight = POOL_WIDTH * scale;
    const offsetX = (width - viewWidth) / 2;
    const offsetY = (height - viewHeight) / 2;

    const toVisual = (p: { x: number; y: number }) => ({
      x: offsetX + p.y * scale,
      y: offsetY + p.x * scale,
    });

    // Pool background
    ctx.fillStyle = COLOR_PALETTE.poolWater;
    ctx.fillRect(offsetX, offsetY, viewWidth, viewHeight);

    // Grid
    ctx.strokeStyle = 'rgba(100,100,120,0.08)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i <= POOL_LENGTH; i += 5) {
      ctx.moveTo(offsetX + i * scale, offsetY);
      ctx.lineTo(offsetX + i * scale, offsetY + viewHeight);
    }
    for (let i = 0; i <= POOL_WIDTH; i += 5) {
      ctx.moveTo(offsetX, offsetY + i * scale);
      ctx.lineTo(offsetX + viewWidth, offsetY + i * scale);
    }
    ctx.stroke();

    ctx.strokeStyle = COLOR_PALETTE.poolBorder;
    ctx.lineWidth = 3;
    ctx.strokeRect(offsetX, offsetY, viewWidth, viewHeight);

    const isBaseline = engine.comparisonRole === 'BASELINE';
    const beamFill = isBaseline ? COLOR_PALETTE.beamNaive : COLOR_PALETTE.beamOptimized;
    const beamStroke = isBaseline ? COLOR_PALETTE.beamNaiveBorder : COLOR_PALETTE.beamOptimizedBorder;

    // Draw sonars with beams and ROI bounds
    engine.sonars.forEach(sonar => {
      const vPos = toVisual(sonar.position);
      const radius = sonar.scanRange * scale;

      // Active scan region (dashed)
      if (sonar.activeScanMinLocalAngle !== undefined && sonar.activeScanMaxLocalAngle !== undefined) {
        const minBearing = localToWorldBearing(sonar, sonar.activeScanMinLocalAngle);
        const maxBearing = localToWorldBearing(sonar, sonar.activeScanMaxLocalAngle);
        const s = Math.PI / 2 - (minBearing * Math.PI) / 180;
        const e = Math.PI / 2 - (maxBearing * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(vPos.x, vPos.y);
        ctx.arc(vPos.x, vPos.y, radius, s, e, false);
        ctx.lineTo(vPos.x, vPos.y);
        ctx.fillStyle = 'rgba(100,116,139,0.04)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(100,116,139,0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Beam wedge
      const realAngleRad = (sonar.currentAngle * Math.PI) / 180;
      const halfBeamRad = ((IMAGING_FOV_DEG / 2) * Math.PI) / 180;
      const e1 = Math.PI / 2 - (realAngleRad + halfBeamRad);
      const e2 = Math.PI / 2 - (realAngleRad - halfBeamRad);

      if (sonar.mode === 'SCANNING') {
        ctx.beginPath();
        ctx.moveTo(vPos.x, vPos.y);
        ctx.arc(vPos.x, vPos.y, radius, e1, e2, false);
        ctx.lineTo(vPos.x, vPos.y);
        ctx.fillStyle = beamFill;
        ctx.fill();
        ctx.strokeStyle = beamStroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Scan direction marker
      const dirVis = Math.PI / 2 - realAngleRad;
      const ax = vPos.x + Math.cos(dirVis - Math.PI / 2) * 18 * sonar.scanDirection;
      const ay = vPos.y - Math.sin(dirVis - Math.PI / 2) * 18 * sonar.scanDirection;
      ctx.fillStyle = '#64748b';
      ctx.beginPath();
      ctx.arc(ax, ay, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Detected points (red)
      const points = showMatchedOnly ? sonar.matchedPoints : sonar.detectedPoints;
      points.slice(-30).forEach(p => {
        const vp = toVisual(p);
        ctx.fillStyle = COLOR_PALETTE.swimmerDetected;
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // Sonar body
      ctx.fillStyle = COLOR_PALETTE.sonarBody;
      ctx.beginPath();
      ctx.arc(vPos.x, vPos.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sonar.id, vPos.x, vPos.y);

      // Action label
      if (sonar.activeAction && sonar.activeAction !== 'IDLE') {
        ctx.fillStyle = '#64748b';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(sonar.activeAction, vPos.x + 10, vPos.y - 10);
      }
    });

    // Tracker belief layer. Truth remains visually distinct and is never fed to strategy.
    engine.trackBeliefs.forEach(track => {
      const vp = toVisual(track.position);
      const positionVariance = Math.max(0, (track.covariance[0]?.[0] ?? 0) + (track.covariance[1]?.[1] ?? 0));
      const uncertaintyRadius = Math.min(40, Math.max(4, Math.sqrt(positionVariance) * scale));
      const color = track.status === 'confirmed' ? '#7c3aed' : track.status === 'tentative' ? '#d97706' : '#94a3b8';

      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, uncertaintyRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(vp.x, vp.y);
      ctx.lineTo(vp.x + track.velocity.y * scale * 3, vp.y + track.velocity.x * scale * 3);
      ctx.stroke();
      ctx.font = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${track.trackId} ${(track.confidence * 100).toFixed(0)}%`, vp.x + 5, vp.y + 10);
    });

    // Swimmers (green dots + labels)
    engine.swimmers.forEach(swimmer => {
      const vp = toVisual(swimmer.position);
      ctx.fillStyle = COLOR_PALETTE.swimmerReal;
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = COLOR_PALETTE.swimmerReal;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(vp.x, vp.y);
      ctx.lineTo(vp.x + swimmer.velocity.y * scale * 5, vp.y + swimmer.velocity.x * scale * 5);
      ctx.stroke();

      ctx.fillStyle = '#0f172a';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(swimmer.id, vp.x + 7, vp.y - 7);
    });
  };

  useEffect(() => {
    let id: number;
    const render = () => {
      const c = canvasRef.current;
      if (c) { const cx = c.getContext('2d'); if (cx) draw(cx); }
      id = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(id);
  }, [engine, width, height, showMatchedOnly]);

  return <canvas ref={canvasRef} width={width} height={height} className="rounded-xl shadow-inner bg-slate-50 cursor-crosshair" />;
};

export default SonarCanvas;
