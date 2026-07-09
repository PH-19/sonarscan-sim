#!/usr/bin/env python3
"""Summarize and plot the 6-sonar V3 ablation benchmark with min/max error bars."""

from __future__ import annotations

import argparse
import csv
import json
import math
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
matplotlib.rc("pdf", fonttype=42)

import matplotlib.pyplot as plt
import numpy as np


EXPECTED_STRATEGIES = [
    "FULL_SCAN",
    "PID_ROI",
    "BELIEF_PSO_V3_NO_PSO",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING",
    "BELIEF_PSO_V3",
]
V3_COMPARE_STRATEGIES = [
    "BELIEF_PSO_V3_NO_PSO",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING",
]
EXPECTED_COUNTS = [2, 4, 6, 10, 20]
EXPECTED_SEEDS = [1, 2, 3, 4, 5, 6]

STRATEGY_LABELS = {
    "FULL_SCAN": "Full Scan",
    "PID_ROI": "PID ROI",
    "BELIEF_PSO_V3_NO_PSO": "No PSO",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": "No Repair",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": "No Redundant",
    "BELIEF_PSO_V3": "V3",
}

STRATEGY_COLORS = {
    "FULL_SCAN": "#999999",
    "PID_ROI": "#67B1D7",
    "BELIEF_PSO_V3_NO_PSO": "#F2B74D",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": "#E38D8C",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": "#84C2AE",
    "BELIEF_PSO_V3": "#9FACD3",
}

CHART_METRICS = [
    {
        "id": "localTrackAccuracy",
        "label": "Local tracking accuracy (%)",
        "scale": 100.0,
        "higher_better": True,
        "filename": "local_tracking_accuracy",
    },
    {
        "id": "avgAoISec",
        "label": "Mean scan interval (s)",
        "scale": 1.0,
        "higher_better": False,
        "filename": "mean_scan_interval",
    },
    {
        "id": "avgScanRateHz",
        "label": "Scanned rate (Hz)",
        "scale": 1.0,
        "higher_better": True,
        "filename": "scanned_rate",
    },
]


def finite(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def flatten_run(row: dict) -> dict:
    output = {
        "experimentId": row.get("experimentId", ""),
        "benchmarkId": row.get("benchmarkId", ""),
        "scenario": row.get("scenario", ""),
        "movementModel": row.get("movementModel", ""),
        "swimmerCount": row.get("swimmerCount", ""),
        "restingSwimmerCount": row.get("restingSwimmerCount", ""),
        "strategy": row.get("strategy", ""),
        "seed": row.get("seed", ""),
        "durationSec": row.get("durationSec", ""),
        "sonarCount": row.get("sonarCount", ""),
        "tdmaEnabled": row.get("tdmaEnabled", ""),
        "sensorProfile": row.get("sensorProfile", ""),
        "strategyImplementation": row.get("strategyImplementation", {}).get("implementation", ""),
        "strategyCodeVersion": row.get("strategyImplementation", {}).get("codeVersion", ""),
    }
    for section_name in ("aggregateMetrics", "finalMetrics", "commandMetrics"):
        for key, value in (row.get(section_name) or {}).items():
            if finite(value):
                output[f"{section_name}.{key}"] = value
    return output


def metric_value(row: dict, metric_id: str, scale: float = 1.0) -> float:
    value = (row.get("aggregateMetrics") or {}).get(metric_id)
    if finite(value):
        return float(value) * scale
    value = (row.get("commandMetrics") or {}).get(metric_id)
    if finite(value):
        return float(value) * scale
    return float("nan")


def stat(values: list[float]) -> dict:
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if not clean:
        return {
            "n": 0,
            "mean": float("nan"),
            "min": float("nan"),
            "max": float("nan"),
            "std": float("nan"),
            "err_lower": float("nan"),
            "err_upper": float("nan"),
        }
    mean = float(np.mean(clean))
    std = float(np.std(clean, ddof=1)) if len(clean) > 1 else 0.0
    min_value = float(np.min(clean))
    max_value = float(np.max(clean))
    return {
        "n": len(clean),
        "mean": mean,
        "min": min_value,
        "max": max_value,
        "std": std,
        "err_lower": mean - min_value,
        "err_upper": max_value - mean,
    }


def csv_value(value: object) -> object:
    if isinstance(value, float) and not math.isfinite(value):
        return ""
    return value


def json_safe(value: object) -> object:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            if key not in seen:
                fieldnames.append(key)
                seen.add(key)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: csv_value(row.get(key, "")) for key in fieldnames})


def grouped_rows(rows: list[dict]) -> dict[tuple[str, int, str], list[dict]]:
    groups: dict[tuple[str, int, str], list[dict]] = defaultdict(list)
    for row in rows:
        groups[(row.get("movementModel", ""), int(row.get("swimmerCount", 0)), row.get("strategy", ""))].append(row)
    return groups


def make_summary_rows(rows: list[dict]) -> tuple[list[dict], dict]:
    groups = grouped_rows(rows)
    metric_ids = sorted({
        key
        for row in rows
        for key, value in (row.get("aggregateMetrics") or {}).items()
        if finite(value)
    } | {
        key
        for row in rows
        for key, value in (row.get("commandMetrics") or {}).items()
        if finite(value)
    })
    summary_rows: list[dict] = []
    summary_lookup: dict = {}
    for movement_model, count, strategy in sorted(groups.keys(), key=lambda item: (item[0], item[1], EXPECTED_STRATEGIES.index(item[2]) if item[2] in EXPECTED_STRATEGIES else 99, item[2])):
        group = groups[(movement_model, count, strategy)]
        seeds = sorted({row.get("seed") for row in group})
        for metric_id in metric_ids:
            values = [metric_value(row, metric_id) for row in group]
            stats = stat(values)
            summary_row = {
                "movementModel": movement_model,
                "swimmerCount": count,
                "strategy": strategy,
                "metric": metric_id,
                "n": stats["n"],
                "seeds": " ".join(str(seed) for seed in seeds),
                "mean": stats["mean"],
                "min": stats["min"],
                "max": stats["max"],
                "err_lower": stats["err_lower"],
                "err_upper": stats["err_upper"],
                "std": stats["std"],
            }
            summary_rows.append(summary_row)
            summary_lookup[(movement_model, count, strategy, metric_id)] = summary_row
    return summary_rows, summary_lookup


def make_paired_delta_rows(rows: list[dict]) -> list[dict]:
    by_key = {
        (row.get("movementModel", ""), int(row.get("swimmerCount", 0)), row.get("strategy", ""), row.get("seed")): row
        for row in rows
    }
    metric_ids = sorted({
        key
        for row in rows
        for key, value in (row.get("aggregateMetrics") or {}).items()
        if finite(value)
    } | {
        key
        for row in rows
        for key, value in (row.get("commandMetrics") or {}).items()
        if finite(value)
    })
    movement_models = sorted({row.get("movementModel", "") for row in rows})
    counts = sorted({int(row.get("swimmerCount", 0)) for row in rows})
    seeds = sorted({row.get("seed") for row in rows})
    comparators = V3_COMPARE_STRATEGIES
    output: list[dict] = []
    for movement_model in movement_models:
        for count in counts:
            for comparator in comparators:
                for metric_id in metric_ids:
                    deltas = []
                    paired_seeds = []
                    for seed in seeds:
                        proposed = by_key.get((movement_model, count, "BELIEF_PSO_V3", seed))
                        baseline = by_key.get((movement_model, count, comparator, seed))
                        if not proposed or not baseline:
                            continue
                        delta = metric_value(proposed, metric_id) - metric_value(baseline, metric_id)
                        if math.isfinite(delta):
                            deltas.append(delta)
                            paired_seeds.append(seed)
                    stats = stat(deltas)
                    output.append({
                        "movementModel": movement_model,
                        "swimmerCount": count,
                        "comparison": f"BELIEF_PSO_V3 - {comparator}",
                        "comparator": comparator,
                        "metric": metric_id,
                        "n": stats["n"],
                        "seeds": " ".join(str(seed) for seed in paired_seeds),
                        "mean_delta": stats["mean"],
                        "min_delta": stats["min"],
                        "max_delta": stats["max"],
                        "err_lower": stats["err_lower"],
                        "err_upper": stats["err_upper"],
                        "std_delta": stats["std"],
                    })
    return output


def setup_plot_style() -> None:
    plt.rc("font", family="Times New Roman", size=14)
    plt.rcParams.update({
        "axes.linewidth": 1.0,
        "axes.labelsize": 14,
        "xtick.labelsize": 12,
        "ytick.labelsize": 12,
        "legend.fontsize": 11,
    })


def style_axis(axis: plt.Axes) -> None:
    axis.yaxis.grid(True, zorder=0, color="#d9d9d9", linewidth=0.8)
    axis.set_axisbelow(True)
    axis.spines["top"].set_visible(False)
    axis.spines["right"].set_visible(False)


def set_ylim_for_error(axis: plt.Axes, means: list[float], lows: list[float], highs: list[float], zero: bool = True) -> None:
    finite_bounds = [
        (mean - low, mean + high)
        for mean, low, high in zip(means, lows, highs)
        if math.isfinite(mean) and math.isfinite(low) and math.isfinite(high)
    ]
    if not finite_bounds:
        return
    lower = min(bound[0] for bound in finite_bounds)
    upper = max(bound[1] for bound in finite_bounds)
    if zero:
        lower = min(0.0, lower)
        upper = max(0.0, upper)
    span = max(1e-6, upper - lower)
    axis.set_ylim(lower - 0.10 * span, upper + 0.16 * span)


def set_ylim_for_values(axis: plt.Axes, values: list[float], zero: bool = True) -> None:
    clean = [value for value in values if math.isfinite(value)]
    if not clean:
        return
    lower = min(clean)
    upper = max(clean)
    if zero:
        lower = min(0.0, lower)
        upper = max(0.0, upper)
    span = max(1e-6, upper - lower)
    axis.set_ylim(lower - 0.14 * span, upper + 0.20 * span)


def plot_metric(summary_lookup: dict, out_dir: Path, metric: dict, counts: list[int], strategies: list[str]) -> Path:
    x = np.arange(len(counts)) * 10.0
    width = min(1.25, 7.2 / max(1, len(strategies)))
    fig, axis = plt.subplots(figsize=(7.4, 4.2))
    all_means: list[float] = []
    all_lows: list[float] = []
    all_highs: list[float] = []
    handles = []
    labels = []
    for index, strategy in enumerate(strategies):
        offset = (index - (len(strategies) - 1) / 2.0) * width
        means = []
        lows = []
        highs = []
        for count in counts:
            row = summary_lookup.get(("random_reflect", count, strategy, metric["id"]), {})
            means.append(float(row.get("mean", float("nan"))) * metric["scale"])
            lows.append(float(row.get("err_lower", float("nan"))) * metric["scale"])
            highs.append(float(row.get("err_upper", float("nan"))) * metric["scale"])
        all_means.extend(means)
        all_lows.extend(lows)
        all_highs.extend(highs)
        bars = axis.bar(
            x + offset,
            means,
            bottom=0,
            width=width * 0.86,
            align="center",
            color="white",
            label=STRATEGY_LABELS.get(strategy, strategy),
            edgecolor=STRATEGY_COLORS.get(strategy, "#999999"),
            linewidth=1.7,
            zorder=3,
        )
        axis.errorbar(
            x + offset,
            means,
            yerr=np.array([lows, highs]),
            color="black",
            fmt="none",
            capsize=4,
            elinewidth=1.1,
            capthick=1.1,
            zorder=10,
        )
        handles.append(bars[0])
        labels.append(STRATEGY_LABELS.get(strategy, strategy))
    axis.set_ylabel(metric["label"])
    axis.set_xlabel("Swimmer count")
    axis.set_xticks(x)
    axis.set_xticklabels([str(count) for count in counts])
    set_ylim_for_error(axis, all_means, all_lows, all_highs, zero=True)
    style_axis(axis)
    axis.legend(handles=handles, labels=labels, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.28), frameon=False, columnspacing=0.8, handletextpad=0.4)
    fig.tight_layout()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{metric['filename']}_minmax.png"
    fig.savefig(path, dpi=220, bbox_inches="tight", pad_inches=0.02)
    fig.savefig(path.with_suffix(".pdf"), bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return path


def plot_delta_metric(delta_rows: list[dict], out_dir: Path, metric: dict, counts: list[int]) -> Path:
    comparators = V3_COMPARE_STRATEGIES
    by_key = {
        (int(row["swimmerCount"]), row["comparator"], row["metric"]): row
        for row in delta_rows
    }
    x = np.arange(len(counts)) * 10.0
    width = min(1.35, 7.2 / max(1, len(comparators)))
    fig, axis = plt.subplots(figsize=(7.4, 4.2))
    all_means: list[float] = []
    handles = []
    labels = []
    for index, comparator in enumerate(comparators):
        offset = (index - (len(comparators) - 1) / 2.0) * width
        means = []
        for count in counts:
            row = by_key.get((count, comparator, metric["id"]), {})
            means.append(float(row.get("mean_delta", float("nan"))) * metric["scale"])
        all_means.extend(means)
        bars = axis.bar(
            x + offset,
            means,
            bottom=0,
            width=width * 0.86,
            align="center",
            color="white",
            label=STRATEGY_LABELS.get(comparator, comparator),
            edgecolor=STRATEGY_COLORS.get(comparator, "#999999"),
            linewidth=1.7,
            zorder=3,
        )
        handles.append(bars[0])
        labels.append(STRATEGY_LABELS.get(comparator, comparator))
    axis.axhline(0, color="black", linewidth=1.0)
    axis.set_ylabel(f"Delta {metric['label']}")
    axis.set_xlabel("Swimmer count")
    axis.set_xticks(x)
    axis.set_xticklabels([str(count) for count in counts])
    set_ylim_for_values(axis, all_means, zero=True)
    style_axis(axis)
    axis.legend(handles=handles, labels=labels, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.28), frameon=False, columnspacing=0.8, handletextpad=0.4)
    fig.tight_layout()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"delta_{metric['filename']}_no_errorbar.png"
    fig.savefig(path, dpi=220, bbox_inches="tight", pad_inches=0.02)
    fig.savefig(path.with_suffix(".pdf"), bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return path


def validate_matrix(rows: list[dict]) -> list[str]:
    warnings = []
    seen = {(int(row.get("swimmerCount", 0)), row.get("strategy"), row.get("seed")) for row in rows}
    expected = {
        (count, strategy, seed)
        for count in EXPECTED_COUNTS
        for strategy in EXPECTED_STRATEGIES
        for seed in EXPECTED_SEEDS
    }
    missing = sorted(expected - seen)
    extra = sorted(seen - expected)
    if missing:
        warnings.append(f"Missing expected run cells: {missing[:12]}{' ...' if len(missing) > 12 else ''}")
    if extra:
        warnings.append(f"Extra run cells outside requested matrix: {extra[:12]}{' ...' if len(extra) > 12 else ''}")
    if len(rows) != 180:
        warnings.append(f"Expected 180 runs, observed {len(rows)}")
    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("benchmark_output", help="Benchmark output directory containing runs.jsonl")
    parser.add_argument("--out", help="Report output directory")
    args = parser.parse_args()

    benchmark_dir = Path(args.benchmark_output).resolve()
    out_dir = Path(args.out).resolve() if args.out else benchmark_dir / "minmax_report"
    out_dir.mkdir(parents=True, exist_ok=True)
    tables_dir = out_dir / "tables"
    charts_dir = out_dir / "charts"
    data_dir = out_dir / "data"
    tables_dir.mkdir(parents=True, exist_ok=True)
    charts_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    runs_path = benchmark_dir / "runs.jsonl"
    samples_path = benchmark_dir / "samples.jsonl"
    manifest_path = benchmark_dir / "manifest.json"
    rows = load_jsonl(runs_path)
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    warnings = validate_matrix(rows)
    flat_rows = [flatten_run(row) for row in rows]
    summary_rows, summary_lookup = make_summary_rows(rows)
    delta_rows = make_paired_delta_rows(rows)

    write_csv(tables_dir / "metrics_by_run.csv", flat_rows)
    write_csv(tables_dir / "metrics_summary_minmax.csv", summary_rows)
    write_csv(tables_dir / "paired_deltas_vs_v3_minmax.csv", delta_rows)

    plot_data = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "benchmarkDir": str(benchmark_dir),
            "runsPath": str(runs_path),
            "samplesPath": str(samples_path),
            "manifestPath": str(manifest_path),
        },
        "expectedMatrix": {
            "densities": EXPECTED_COUNTS,
            "strategies": EXPECTED_STRATEGIES,
            "v3CompareStrategies": V3_COMPARE_STRATEGIES,
            "seeds": EXPECTED_SEEDS,
            "expectedRuns": 180,
        },
        "warnings": warnings,
        "summary": summary_rows,
        "pairedDeltasVsV3": delta_rows,
    }
    (data_dir / "plot_data_minmax.json").write_text(json.dumps(json_safe(plot_data), indent=2) + "\n")
    if manifest:
        (data_dir / "benchmark_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if samples_path.exists():
        shutil.copy2(samples_path, data_dir / "samples.jsonl")
    shutil.copy2(runs_path, data_dir / "runs.jsonl")

    setup_plot_style()
    chart_paths = []
    for metric in CHART_METRICS:
        chart_paths.append(plot_delta_metric(delta_rows, charts_dir, metric, EXPECTED_COUNTS))

    report_lines = [
        "# V3 ablation min/max report",
        "",
        f"Generated at: {datetime.now(timezone.utc).isoformat()}",
        "",
        "## Source data",
        "",
        f"- Benchmark output: `{benchmark_dir}`",
        f"- Raw runs: `{runs_path}`",
        f"- Raw samples: `{samples_path}`",
        f"- Manifest: `{manifest_path}`",
        "",
        "## Matrix check",
        "",
        f"- Runs observed: {len(rows)}",
        f"- Densities: {EXPECTED_COUNTS}",
        f"- Strategies: {', '.join(EXPECTED_STRATEGIES)}",
        f"- V3 comparison strategies in figures: {', '.join(V3_COMPARE_STRATEGIES)}",
        f"- Seeds: {EXPECTED_SEEDS}",
        "- Figures: mean paired deltas only; error bars are not drawn.",
        "- Y axes are zoomed to the V3-comparison mean-delta range while retaining the zero reference line.",
        "- Tables still preserve min/max and asymmetric error terms for later analysis.",
        "",
    ]
    if warnings:
        report_lines.append("Warnings:")
        report_lines.extend(f"- {warning}" for warning in warnings)
        report_lines.append("")
    report_lines.extend([
        "## Figures",
        "",
    ])
    for path in chart_paths:
        report_lines.append(f"![{path.stem}](charts/{path.name})")
        report_lines.append("")
    report_lines.extend([
        "## Reusable data",
        "",
        "- `tables/metrics_by_run.csv`: flattened per-run metrics for all 180 runs.",
        "- `tables/metrics_summary_minmax.csv`: mean/min/max/std and asymmetric error terms by density, strategy, metric.",
        "- `tables/paired_deltas_vs_v3_minmax.csv`: paired seed deltas, computed as V3 minus the three V3 ablation comparators used in the figures.",
        "- `data/plot_data_minmax.json`: complete structured plot data.",
        "- `data/runs.jsonl`, `data/samples.jsonl`, `data/benchmark_manifest.json`: copied raw benchmark artifacts.",
        "",
    ])
    (out_dir / "README.md").write_text("\n".join(report_lines))

    print(json.dumps({
        "reportDir": str(out_dir),
        "runCount": len(rows),
        "warnings": warnings,
        "charts": [str(path) for path in chart_paths],
    }, indent=2))
    return 1 if warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())
