# Sensor Failure Robustness Experiment Design

## Objective

Evaluate how robust each scan-planning strategy is when a two-sonar segment becomes unavailable during the run. The primary experiment keeps the same baseline set, metrics, plotting style, and run count as the 300-run end-to-end population sweep.

## Primary Run Matrix

The primary sensor-failure benchmark is a 300-run population sweep:

| Dimension | Values |
| --- | --- |
| Movement model | `random_reflect` |
| Swimmer counts | `2, 4, 6, 10, 20` |
| Strategies | `FULL_SCAN`, `ROUND_ROBIN_SECTOR`, `ROUND_ROBIN_ROI`, `NEAREST_ROI`, `PID_ROI`, `BELIEF_PSO_V3` |
| Seeds | `1..10` |
| Run count | `5 densities * 6 strategies * 10 seeds = 300` |
| Sonars | 6 synthetic imaging sonars |
| Duration | 90 s |
| Warmup | 15 s |
| Metrics window | 20 s |
| Sensor profile | `synthetic_default_v0` |
| TDMA | disabled |

Config:

```bash
npm run benchmark:synthetic -- --skip-gate experiments/proposed_v3_evaluation/configs/sensor_failure_robustness_random_6sonar_pid_300run.json
```

## Failure Injection

Primary failure condition: `segment_transient`.

- Two adjacent sonars are unavailable from `45s` to `85s`.
- The failed sonar IDs are selected deterministically from the 6 sonar IDs using `movementModel`, `swimmerCount`, `seed`, failure mode, and `sonarCount`.
- All strategies for the same `swimmerCount` and `seed` share the same failed sonars, so strategy comparisons remain paired.
- The final 20-second evaluation window covers the last 15 seconds of outage and the first 5 seconds of recovery, which stresses both failure-time tracking and immediate recovery.

The previous no-failure 300-run end-to-end result is the control condition. Keeping the failure run itself at 300 runs preserves the same run budget as the main end-to-end setup while still enabling paired degradation analysis against the saved control data.

## Metrics

Use the same seven main metrics as the end-to-end experiment:

| Metric | Direction | Notes |
| --- | --- | --- |
| Tracking Accuracy | higher is better | `localTrackAccuracy` |
| Scan Interval | lower is better | `avgAoISec` |
| Scanned Rate | higher is better | `avgScanRateHz` |
| Identity Continuity | higher is better | `trackContinuity` |
| Sonar Workload | lower is better | `sonarBusyRatio` |
| Search Coverage | higher is better | `searchCoverageRatio` |
| Planner Latency | lower is better | `decisionLatencyP95Ms` |

Strict tracking accuracy remains available in the raw summaries, but the main figure uses Tracking Accuracy (`localTrackAccuracy`) to match the latest end-to-end report.

## Plots

Use the same matplotlib grouped bar style as the end-to-end test and `draw_figure_update.py`:

- x-axis: swimmer count.
- bar groups: the six strategies.
- one figure per metric.
- output both PNG and PDF.
- bar height: mean across the 10 seeds.
- asymmetric error bars: lower error is `mean - min(seed values)`, upper error is `max(seed values) - mean`.

The primary failure-performance figures can be generated with the current population report pipeline because the primary config contains only one failure mode.

## Robustness Comparison Against Control

For the Sensor Failure Robustness section, report two views:

1. Failure-performance view: the same seven metric figures under `segment_transient` failure.
2. Degradation view: paired difference between failure and the no-failure 300-run control for the same `swimmerCount`, `strategy`, `seed`, and metric.

Recommended degradation signs:

- `tracking accuracy`, `scanned rate`, `identity continuity`, and `search coverage`: failure minus control. Negative means degradation.
- `scan interval`, `sonar workload`, and `planner latency`: failure minus control. Positive means degradation.

The degradation view should still use grouped bar charts with min/max asymmetric error bars, but the bars represent paired per-seed deltas rather than raw metric values.

## Data Products

Save the same data products as the end-to-end experiment:

- `runs.jsonl`
- `samples.jsonl`
- `manifest.json`
- `metrics_by_run.csv`
- `metrics_by_density.csv`
- `paired_effects.csv`
- `summary.json`
- PNG/PDF charts

For the control comparison, additionally save:

- `failure_vs_control_deltas.csv`
- paired-delta PNG/PDF charts for the seven metrics

## Implementation Notes

- Do not include `none`, `single_transient`, and `segment_transient` in one 300-run primary config. The runner treats failure mode as an extra Cartesian-product dimension, so three modes would create `5 * 3 * 6 * 10 = 900` runs.
- If a future section also needs the milder single-sonar failure case, run a separate 300-run stress benchmark with `sonarFailureModes: ["single_transient"]`.
- If multiple failure modes are intentionally combined in one output, the report grouping must include `sonarFailureMode`; otherwise the current population report script will mix modes when aggregating by swimmer count and strategy.
