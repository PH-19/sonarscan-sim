export class SimulationClock {
  time = 0;

  reset() {
    this.time = 0;
  }

  step(dt: number) {
    this.time += Math.max(0, dt);
    return this.time;
  }
}
