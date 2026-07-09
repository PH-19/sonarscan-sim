# Sonar Physics Regression

This experiment is intentionally strategy-free. It validates the command-level sonar timing model directly, so strategy benchmarks cannot accidentally stay "green" after a physical timing regression.

Run the check-only gate:

```bash
npm run test:sonar-physics
```

Generate the local experiment report:

```bash
npm run experiment:sonar-physics
```

The report covers:

- range sweep: larger ranges must take longer because acoustic round-trip receive time grows
- angular width sweep: wider sectors must emit more beams and take longer
- angular resolution sweep: finer scan steps must take longer for the same sector
- TDMA slot sweep: `pingSlotCount` must multiply per-beam timing
- mechanical slew: non-emitting reposition time must be separate from scan emission
- multi-window jump scan: per-window ranges and non-emitting gaps must be preserved
- Ping360 calibration envelopes: about 3.4s for 1m/360deg and about 32s for 50m/360deg

Generated files are written to `experiments/sonar_physics_regression/report/`.
