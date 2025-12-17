import React, { useRef, useEffect } from 'react';
import { SimulationEngine } from '../services/SimulationEngine';
import { POOL_WIDTH, POOL_LENGTH, COLOR_PALETTE, BEAM_WIDTH } from '../constants';

interface Props {
  engine: SimulationEngine;
  width: number;
  height: number;
}

const SonarCanvas: React.FC<Props> = ({ engine, width, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Scaling factors
  const scaleX = width / POOL_WIDTH;
  const scaleY = height / POOL_LENGTH;

  const draw = (ctx: CanvasRenderingContext2D) => {
    // Clear
    ctx.clearRect(0, 0, width, height);

    // 1. Draw Pool
    ctx.fillStyle = COLOR_PALETTE.poolWater;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = COLOR_PALETTE.poolBorder;
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, width, height);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for(let i=0; i<=POOL_WIDTH; i+=5) {
      ctx.moveTo(i * scaleX, 0); ctx.lineTo(i * scaleX, height);
    }
    for(let i=0; i<=POOL_LENGTH; i+=5) {
      ctx.moveTo(0, i * scaleY); ctx.lineTo(width, i * scaleY);
    }
    ctx.stroke();

    // 2. Draw Sonars and Beams
    engine.sonars.forEach(sonar => {
      const sx = sonar.position.x * scaleX;
      const sy = sonar.position.y * scaleY;
      
      // Draw Beam
      const radius = sonar.scanRange * Math.min(scaleX, scaleY);
      
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      // Main beam line
      const angleRad = (sonar.currentAngle * Math.PI) / 180;
      const endX = sx + Math.cos(angleRad) * radius;
      const endY = sy + Math.sin(angleRad) * radius;
      
      // Wedge
      const halfBeamRad = ((BEAM_WIDTH / 2) * Math.PI) / 180;
      ctx.arc(sx, sy, radius, angleRad - halfBeamRad, angleRad + halfBeamRad);
      ctx.lineTo(sx, sy);
      
      if (sonar.mode === 'SCANNING') {
        ctx.fillStyle = engine.strategy === 'NAIVE' ? COLOR_PALETTE.beamNaive : COLOR_PALETTE.beamOptimized;
      } else {
        ctx.fillStyle = COLOR_PALETTE.slewIndicator;
      }
      ctx.fill();
      
      // Draw detected points (Simulation persistence)
      ctx.fillStyle = COLOR_PALETTE.swimmerDetected;
      sonar.detectedPoints.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x * scaleX, p.y * scaleY, 4, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw Sonar Body
      ctx.fillStyle = COLOR_PALETTE.sonarBody;
      ctx.beginPath();
      ctx.arc(sx, sy, 10, 0, Math.PI * 2);
      ctx.fill();
      
      // Label
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.fillText(sonar.id, sx - 5, sy - 12);
    });

    // 3. Draw Real Swimmers (Ground Truth)
    engine.swimmers.forEach(swimmer => {
      const x = swimmer.position.x * scaleX;
      const y = swimmer.position.y * scaleY;

      ctx.fillStyle = COLOR_PALETTE.swimmerReal;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      
      // Velocity Vector
      ctx.strokeStyle = COLOR_PALETTE.swimmerReal;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + swimmer.velocity.x * 10, y + swimmer.velocity.y * 10);
      ctx.stroke();
    });
  };

  useEffect(() => {
    let animationFrameId: number;
    
    const render = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          draw(ctx);
        }
      }
      animationFrameId = requestAnimationFrame(render);
    };
    render();

    return () => cancelAnimationFrame(animationFrameId);
  }, [engine, width, height]);

  return <canvas ref={canvasRef} width={width} height={height} className="rounded-lg shadow-inner bg-slate-50" />;
};

export default SonarCanvas;
