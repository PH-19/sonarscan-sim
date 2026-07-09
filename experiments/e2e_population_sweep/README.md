# E2E Population Sweep

This experiment evaluates end-to-end simulator performance as swimmer count increases.

Run the smoke configuration:

```bash
npm run experiment:e2e-population:smoke
```

Run the full configuration:

```bash
npm run experiment:e2e-population
```

Generate the Markdown report from a benchmark output directory:

```bash
npm run experiment:e2e-population:report -- experiments/e2e_population_sweep/output/<benchmark-output-dir>
```

Generated raw outputs belong under `experiments/e2e_population_sweep/output/`.
Generated reports, charts, and CSV files belong under `experiments/e2e_population_sweep/report/`.
