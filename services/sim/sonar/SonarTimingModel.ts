import { SonarCommand, SonarCommandScanWindow } from '../../../types';
import {
  PING360_PROCESSING_OVERHEAD_S,
  PING360_RECEIVE_GUARD_FACTOR,
  PING360_SCAN_STEP_OVERHEAD_S,
  SCAN_STEP_ANGLE,
  SONAR_SAMPLE_PERIOD_S,
  SPEED_OF_SOUND,
  SLEW_SPEED,
} from '../../../constants';
import { angleAtSweepFraction } from './AngleSweep';

export type SonarTimingConfig = {
  soundSpeed: number;
  slewSpeedDegPerSec: number;
  defaultAngularStepDeg: number;
  processingOverheadSec: number;
  scanStepOverheadSec: number;
  receiveGuardFactor: number;
  samplePeriodSec: number;
};

export const defaultSonarTimingConfig: SonarTimingConfig = {
  soundSpeed: SPEED_OF_SOUND,
  slewSpeedDegPerSec: SLEW_SPEED,
  defaultAngularStepDeg: SCAN_STEP_ANGLE,
  processingOverheadSec: PING360_PROCESSING_OVERHEAD_S,
  scanStepOverheadSec: PING360_SCAN_STEP_OVERHEAD_S,
  receiveGuardFactor: PING360_RECEIVE_GUARD_FACTOR,
  samplePeriodSec: SONAR_SAMPLE_PERIOD_S,
};

export class SonarTimingModel {
  constructor(private readonly config = defaultSonarTimingConfig) {}

  scanWindows(command: SonarCommand): SonarCommandScanWindow[] {
    if (command.scanWindows?.length) return command.scanWindows;
    return [{
      scanStartLocalAngle: command.scanStartLocalAngle,
      endLocalAngle: command.endLocalAngle,
      scanMinLocalAngle: command.scanMinLocalAngle,
      scanMaxLocalAngle: command.scanMaxLocalAngle,
      range: command.range,
      assignedTargetIds: command.assignedTargetIds,
    }];
  }

  private slewBetweenLocalAngles(from: number, to: number) {
    const slewDeg = Math.abs(to - from);
    if (slewDeg < 0.5) return 0;
    return slewDeg / this.config.slewSpeedDegPerSec;
  }

  private windowBeamCount(window: Pick<SonarCommandScanWindow, 'scanStartLocalAngle' | 'endLocalAngle'>, angularStepDeg: number) {
    const width = Math.abs(window.endLocalAngle - window.scanStartLocalAngle);
    const step = Math.max(0.1, angularStepDeg || this.config.defaultAngularStepDeg);
    return Math.max(1, Math.floor(width / step) + 1);
  }

  private windowBeamIntervalSec(command: Pick<SonarCommand, 'angularStepDeg' | 'samplesPerBeam' | 'pingSlotCount'>, window: Pick<SonarCommandScanWindow, 'range'>) {
    return this.beamIntervalSec({
      range: window.range,
      angularStepDeg: command.angularStepDeg,
      samplesPerBeam: command.samplesPerBeam,
      pingSlotCount: command.pingSlotCount,
    });
  }

  slewTimeSec(command: SonarCommand) {
    const firstWindow = this.scanWindows(command)[0];
    return this.slewBetweenLocalAngles(command.startLocalAngle, firstWindow.scanStartLocalAngle);
  }

  scanBeamCount(command: SonarCommand) {
    return this.scanWindows(command).reduce(
      (sum, window) => sum + this.windowBeamCount(window, command.angularStepDeg),
      0
    );
  }

  beamCount(command: SonarCommand) {
    return this.scanBeamCount(command);
  }

  beamIntervalSec(command: Pick<SonarCommand, 'range' | 'angularStepDeg' | 'samplesPerBeam' | 'pingSlotCount'>) {
    const acousticRoundTrip = (2 * command.range) / this.config.soundSpeed;
    // Ping360 range is represented by sample period x sample count. Treat the
    // configured period as a hardware lower bound, not an extra receive delay.
    const sampling = Math.max(
      acousticRoundTrip,
      Math.max(1, command.samplesPerBeam) * this.config.samplePeriodSec
    );
    const motorStep = this.config.scanStepOverheadSec
      * Math.max(0.1, command.angularStepDeg)
      / Math.max(0.1, this.config.defaultAngularStepDeg);
    const singleSonarInterval = sampling * this.config.receiveGuardFactor + this.config.processingOverheadSec + motorStep;
    return singleSonarInterval * Math.max(1, command.pingSlotCount);
  }

  effectiveSamplePeriodSec(command: Pick<SonarCommand, 'range' | 'samplesPerBeam'>) {
    return Math.max(
      this.config.samplePeriodSec,
      (2 * command.range) / (this.config.soundSpeed * Math.max(1, command.samplesPerBeam))
    );
  }

  durationSec(command: SonarCommand) {
    const windows = this.scanWindows(command);
    if (windows.length === 0) return 0;

    let duration = this.slewBetweenLocalAngles(command.startLocalAngle, windows[0].scanStartLocalAngle);
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      duration += this.windowBeamCount(window, command.angularStepDeg) * this.windowBeamIntervalSec(command, window);
      const next = windows[index + 1];
      if (next) duration += this.slewBetweenLocalAngles(window.endLocalAngle, next.scanStartLocalAngle);
    }
    return duration;
  }

  endTime(command: SonarCommand) {
    return command.startTime + this.durationSec(command);
  }

  beamLocalAngle(command: SonarCommand, beamIndex: number) {
    let offset = beamIndex;
    for (const window of this.scanWindows(command)) {
      const count = this.windowBeamCount(window, command.angularStepDeg);
      if (offset < count) {
        if (count <= 1) return window.scanStartLocalAngle;
        return angleAtSweepFraction(
          { startAngle: window.scanStartLocalAngle, endAngle: window.endLocalAngle },
          offset / (count - 1)
        );
      }
      offset -= count;
    }
    return command.endLocalAngle;
  }

  beamTime(command: SonarCommand, beamIndex: number) {
    const windows = this.scanWindows(command);
    if (windows.length === 0) return command.startTime;

    let time = command.startTime + this.slewBetweenLocalAngles(command.startLocalAngle, windows[0].scanStartLocalAngle);
    let offset = beamIndex;
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      const count = this.windowBeamCount(window, command.angularStepDeg);
      const interval = this.windowBeamIntervalSec(command, window);
      if (offset < count) return time + (offset + 1) * interval;
      time += count * interval;
      const next = windows[index + 1];
      if (next) time += this.slewBetweenLocalAngles(window.endLocalAngle, next.scanStartLocalAngle);
      offset -= count;
    }
    return this.endTime(command);
  }

  beamRange(command: SonarCommand, beamIndex: number) {
    let offset = beamIndex;
    for (const window of this.scanWindows(command)) {
      const count = this.windowBeamCount(window, command.angularStepDeg);
      if (offset < count) return window.range;
      offset -= count;
    }
    return command.range;
  }

  mechanicalState(command: SonarCommand, now: number) {
    const windows = this.scanWindows(command);
    if (windows.length === 0) {
      return { localAngle: command.endLocalAngle, scanning: false };
    }

    let elapsed = Math.max(0, now - command.startTime);
    const initialSlew = this.slewBetweenLocalAngles(command.startLocalAngle, windows[0].scanStartLocalAngle);
    if (elapsed <= initialSlew && initialSlew > 0) {
      return {
        localAngle: command.startLocalAngle
          + (windows[0].scanStartLocalAngle - command.startLocalAngle) * (elapsed / initialSlew),
        scanning: false,
      };
    }
    elapsed -= initialSlew;

    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      const scanDuration = this.windowBeamCount(window, command.angularStepDeg) * this.windowBeamIntervalSec(command, window);
      if (elapsed <= scanDuration || index === windows.length - 1) {
        const fraction = scanDuration > 0 ? elapsed / scanDuration : 1;
        return {
          localAngle: angleAtSweepFraction(
            { startAngle: window.scanStartLocalAngle, endAngle: window.endLocalAngle },
            fraction
          ),
          scanning: true,
        };
      }
      elapsed -= scanDuration;

      const next = windows[index + 1];
      if (!next) break;
      const gapSlew = this.slewBetweenLocalAngles(window.endLocalAngle, next.scanStartLocalAngle);
      if (elapsed <= gapSlew && gapSlew > 0) {
        return {
          localAngle: window.endLocalAngle
            + (next.scanStartLocalAngle - window.endLocalAngle) * (elapsed / gapSlew),
          scanning: false,
        };
      }
      elapsed -= gapSlew;
    }

    return { localAngle: command.endLocalAngle, scanning: false };
  }

  progress(command: SonarCommand, now: number) {
    const duration = this.durationSec(command);
    if (duration <= 0) return 1;
    return Math.max(0, Math.min(1, (now - command.startTime) / duration));
  }

  scanProgress(command: SonarCommand, now: number) {
    const scanDuration = this.scanWindows(command).reduce(
      (sum, window) => sum + this.windowBeamCount(window, command.angularStepDeg) * this.windowBeamIntervalSec(command, window),
      0
    );
    if (scanDuration <= 0) return 1;

    const windows = this.scanWindows(command);
    let elapsed = Math.max(0, now - command.startTime);
    elapsed -= this.slewBetweenLocalAngles(command.startLocalAngle, windows[0].scanStartLocalAngle);
    let scanned = 0;
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      const windowDuration = this.windowBeamCount(window, command.angularStepDeg) * this.windowBeamIntervalSec(command, window);
      if (elapsed <= windowDuration) {
        scanned += Math.max(0, elapsed);
        break;
      }
      scanned += windowDuration;
      elapsed -= windowDuration;
      const next = windows[index + 1];
      if (next) elapsed -= this.slewBetweenLocalAngles(window.endLocalAngle, next.scanStartLocalAngle);
    }
    return Math.max(0, Math.min(1, scanned / scanDuration));
  }
}
