import { SonarState, StrategySnapshot, TrackBelief } from '../../../types';
import {
  MAX_RANGE_NAIVE,
  PING360_PROCESSING_OVERHEAD_S,
  PING360_RECEIVE_GUARD_FACTOR,
  PING360_SCAN_STEP_OVERHEAD_S,
  POOL_LENGTH,
  POOL_WIDTH,
  SCAN_STEP_ANGLE,
  SONAR_SAMPLE_PERIOD_S,
  SLEW_SPEED,
  SPEED_OF_SOUND,
  IMAGING_RANGE_BINS,
} from '../../../constants';

export class StrategySnapshotBuilder {
  build(opts: {
    time: number;
    seed: number;
    sonars: SonarState[];
    tracks: TrackBelief[];
    coverageLastSeenBySonar?: Map<string, number[]>;
    tdmaSlotCount?: number;
  }): StrategySnapshot {
    const tdmaSlotCount = Math.max(
      1,
      opts.tdmaSlotCount ?? opts.sonars.filter(sonar => sonar.available).length
    );
    return {
      simulationTime: opts.time,
      seed: opts.seed,
      pool: { width: POOL_WIDTH, length: POOL_LENGTH },
      physics: {
        speedOfSound: SPEED_OF_SOUND,
        slewSpeed: SLEW_SPEED,
        scanStepAngle: SCAN_STEP_ANGLE,
        processingOverheadSec: PING360_PROCESSING_OVERHEAD_S,
        scanStepOverheadSec: PING360_SCAN_STEP_OVERHEAD_S,
        receiveGuardFactor: PING360_RECEIVE_GUARD_FACTOR,
        samplesPerBeam: IMAGING_RANGE_BINS,
        samplePeriodSec: SONAR_SAMPLE_PERIOD_S,
        maxRange: MAX_RANGE_NAIVE,
        tdmaSlotCount,
      },
      sonars: opts.sonars.map(sonar => ({
        id: sonar.id,
        position: { ...sonar.position },
        mountAngle: sonar.mountAngle,
        mountYaw: sonar.mountYaw,
        currentAngle: sonar.currentAngle,
        currentLocalAngle: sonar.currentLocalAngle ?? sonar.currentAngle,
        scanDirection: sonar.scanDirection ?? 1,
        minLocalAngle: sonar.minLocalAngle,
        maxLocalAngle: sonar.maxLocalAngle,
        mode: sonar.mode,
        activeCommandId: sonar.activeCommandId,
        activeCommandEndsAt: sonar.activeCommandEndsAt,
        assignedTargetIds: sonar.assignedTargetIds ?? [],
        available: sonar.available,
        coverageBins: (opts.coverageLastSeenBySonar?.get(sonar.id) ?? Array.from({ length: 18 }, () => 0))
          .map((lastObservedAt, index, bins) => {
            const width = (sonar.maxLocalAngle - sonar.minLocalAngle) / bins.length;
            return {
              minLocalAngle: sonar.minLocalAngle + index * width,
              maxLocalAngle: sonar.minLocalAngle + (index + 1) * width,
              lastObservedAt,
              ageSec: Math.max(0, opts.time - lastObservedAt),
            };
          }),
      })),
      tracks: opts.tracks
        .filter(track => track.status !== 'lost' || track.timeSinceUpdate <= 35)
        .map(track => ({
          id: track.trackId,
          position: { ...track.position },
          velocity: { ...track.velocity },
          covariance: track.covariance.map(row => [...row]),
          age: track.age,
          timeSinceUpdate: track.timeSinceUpdate,
          confidence: track.confidence,
          status: track.status,
        })),
    };
  }
}
