import { SonarCommand } from '../../../types';
import { SonarTimingModel } from './SonarTimingModel';

type RuntimeCommand = {
  command: SonarCommand;
  endTime: number;
};

export class SonarCommandScheduler {
  private activeBySonar = new Map<string, RuntimeCommand>();
  private completedCommands: SonarCommand[] = [];

  constructor(private readonly timing: SonarTimingModel) {}

  reset() {
    this.activeBySonar.clear();
    this.completedCommands = [];
  }

  isBusy(sonarId: string) {
    return this.activeBySonar.has(sonarId);
  }

  active(sonarId: string) {
    return this.activeBySonar.get(sonarId)?.command;
  }

  activeEndTime(sonarId: string) {
    return this.activeBySonar.get(sonarId)?.endTime;
  }

  cancel(sonarId: string) {
    return this.activeBySonar.delete(sonarId);
  }

  submit(command: SonarCommand) {
    if (this.isBusy(command.sonarId)) return false;
    this.activeBySonar.set(command.sonarId, {
      command,
      endTime: this.timing.endTime(command),
    });
    return true;
  }

  advance(now: number) {
    for (const [sonarId, runtime] of this.activeBySonar.entries()) {
      if (runtime.endTime > now) continue;
      this.completedCommands.push(runtime.command);
      this.activeBySonar.delete(sonarId);
    }

    const completed = this.completedCommands;
    this.completedCommands = [];
    return completed;
  }

  snapshot(now: number) {
    return Array.from(this.activeBySonar.values()).map(runtime => ({
      command: runtime.command,
      endTime: runtime.endTime,
      progress: this.timing.progress(runtime.command, now),
    }));
  }
}
