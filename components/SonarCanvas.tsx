import React, { useRef, useEffect } from 'react';
import { SimulationEngine } from '../services/SimulationEngine';
import { POOL_WIDTH, POOL_LENGTH, COLOR_PALETTE, IMAGING_FOV_DEG } from '../constants';

interface Props {
  engine: SimulationEngine;
  width: number;
  height: number;
  showMatchedOnly: boolean;
}

const SonarCanvas: React.FC<Props> = ({ engine, width, height, showMatchedOnly }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Horizontal Layout:
  // Visual X axis = Real Pool Y axis (0 to 50m)
  // Visual Y axis = Real Pool X axis (0 to 20m)
  // We want isotropic scaling to avoid distortion.

  const draw = (ctx: CanvasRenderingContext2D) => {
    // Clear
    ctx.clearRect(0, 0, width, height);

    // Calculate Scaling
    const scaleX = width / POOL_LENGTH;
    const scaleY = height / POOL_WIDTH;
    const scale = Math.min(scaleX, scaleY);

    const viewWidth = POOL_LENGTH * scale;
    const viewHeight = POOL_WIDTH * scale;

    const offsetX = (width - viewWidth) / 2;
    const offsetY = (height - viewHeight) / 2;

    const toVisual = (p: { x: number, y: number }) => {
      // Rotate: Real Y -> Visual X, Real X -> Visual Y
      return {
        x: offsetX + p.y * scale,
        y: offsetY + p.x * scale
      };
    };

    // 1. Draw Pool Water
    ctx.fillStyle = COLOR_PALETTE.poolWater;
    ctx.fillRect(offsetX, offsetY, viewWidth, viewHeight);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Vertical lines (Real Pool Length markers, 0, 5, 10...)
    // These are constant Y in real world? No.
    // Real world: lines of constant Y are horizontal (across width).
    // In rotated view: lines of constant Real Y are Vertical (x increases).
    for (let i = 0; i <= POOL_LENGTH; i += 5) {
      const x = offsetX + i * scale;
      ctx.moveTo(x, offsetY);
      ctx.lineTo(x, offsetY + viewHeight);

      // text labels for distance
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '10px sans-serif';
      if (i % 10 === 0) ctx.fillText(`${i}m`, x + 2, offsetY + viewHeight - 2);
    }

    // Horizontal lines (Real Pool Width markers)
    for (let i = 0; i <= POOL_WIDTH; i += 5) {
      const y = offsetY + i * scale;
      ctx.moveTo(offsetX, y);
      ctx.lineTo(offsetX + viewWidth, y);
    }
    ctx.stroke();

    // Border
    ctx.strokeStyle = COLOR_PALETTE.poolBorder;
    ctx.lineWidth = 4;
    ctx.strokeRect(offsetX, offsetY, viewWidth, viewHeight);

    // 2. Draw Sonars and Beams
    engine.sonars.forEach(sonar => {
      const vPos = toVisual(sonar.position);

      // Draw Beam
      const radius = sonar.scanRange * scale;

      ctx.beginPath();
      ctx.moveTo(vPos.x, vPos.y);

      // Angle Mapping:
      // Real: 0 (Right/East), 90 (Down/South)
      // Visual: 0 (Right), 90 (Down)
      // Rotated Mapping: 
      // Real 0 (+X) -> Visual (+Y) (Down, 90 deg)
      // Real 90 (+Y) -> Visual (+X) (Right, 0 deg)
      // Formula: VisualAngle = 90 (PI/2) - RealAngle

      const realAngleRad = (sonar.currentAngle * Math.PI) / 180;
      const visualAxisAngle = Math.PI / 2 - realAngleRad;
      // Note: arc() draws clockwise. 
      // Need to flip direction?
      // Real increase: clockwise?
      // Our engine angles: 0 is North? Or East?
      // Looking at `createSwimmer`: Top (y=0) has dir y=+1 (Down).
      // Standard canvas physics usually y inv.
      // Let's assume standard math Angle 0 = +X.
      // If our mapping is correct: visualAngle = PI/2 - realAngle.

      const halfBeamRad = ((IMAGING_FOV_DEG / 2) * Math.PI) / 180;

      // We want to fill the arc between (visualAngle - half) and (visualAngle + half)
      // But since we did a transform that includes flip, we need to be careful.
      // Let's rely on vector components to be safe.

      // Wedge edges (Real)
      // Left Edge: a + half
      // Right Edge: a - half
      const edge1Real = realAngleRad + halfBeamRad;
      const edge2Real = realAngleRad - halfBeamRad;

      // Map to visual
      const edge1Vis = Math.PI / 2 - edge1Real;
      const edge2Vis = Math.PI / 2 - edge2Real;

      // Arc from edge1Vis to edge2Vis? Or min to max?
      // atan2 is stable.

      ctx.arc(vPos.x, vPos.y, radius, edge1Vis, edge2Vis, true); // true = counter-clockwise?
      // If edge1Vis < edge2Vis...
      // e.g. Angle=0 (Real). edge1Real = +10. edge2Real = -10.
      // edge1Vis = 90 - 10 = 80. edge2Vis = 90 - (-10) = 100.
      // We want to draw arc from 80 to 100.
      // Default arc is clockwise. 80 -> 100 is correct slice.
      // So false (default).

      ctx.lineTo(vPos.x, vPos.y);

      if (sonar.mode === 'SCANNING') {
        if (engine.strategy === 'NAIVE') {
          ctx.fillStyle = COLOR_PALETTE.beamNaive;
          ctx.strokeStyle = COLOR_PALETTE.beamNaiveBorder;
        } else {
          ctx.fillStyle = COLOR_PALETTE.beamOptimized;
          ctx.strokeStyle = COLOR_PALETTE.beamOptimizedBorder;
        }
      } else {
        ctx.fillStyle = COLOR_PALETTE.slewIndicator;
        ctx.strokeStyle = 'transparent';
      }
      ctx.fill();
      if (ctx.strokeStyle !== 'transparent') {
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Draw detected points
      ctx.fillStyle = COLOR_PALETTE.swimmerDetected;
      const points = showMatchedOnly ? sonar.matchedPoints : sonar.detectedPoints;
      points.forEach(p => {
        const vp = toVisual(p);
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, 3, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw Sonar Body
      ctx.fillStyle = COLOR_PALETTE.sonarBody;
      ctx.beginPath();
      // Draw square/circle
      ctx.arc(vPos.x, vPos.y, 8, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(sonar.id, vPos.x - 6, vPos.y + 4);
    });

    // 3. Draw Real Swimmers (Ground Truth)
    engine.swimmers.forEach(swimmer => {
      const vp = toVisual(swimmer.position);

      ctx.fillStyle = COLOR_PALETTE.swimmerReal;
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 5, 0, Math.PI * 2);
      ctx.fill();

      // Velocity Vector
      ctx.strokeStyle = COLOR_PALETTE.swimmerReal;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(vp.x, vp.y);
      // Map velocity vector
      const vx = swimmer.velocity.y; // Swap x/y for visual
      const vy = swimmer.velocity.x;

      ctx.lineTo(vp.x + vx * 10, vp.y + vy * 10);
      ctx.stroke();

      // Label ID
      ctx.fillStyle = '#334155';
      ctx.font = '10px sans-serif';
      ctx.fillText(swimmer.id, vp.x + 8, vp.y - 8);
    });
  };

  useEffect(() => {
    let animationFrameId: number;
    const render = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) draw(ctx);
      }
      animationFrameId = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [engine, width, height, showMatchedOnly]);

  return <canvas ref={canvasRef} width={width} height={height} className="rounded-xl shadow-inner bg-slate-50 cursor-crosshair" />;
};

export default SonarCanvas;
