#!/usr/bin/env python3
"""Summarize the V3 ablation benchmark and draw AquaScan-style charts."""

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
matplotlib.rc("ps", fonttype=42)

import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np


EXPECTED_MOVEMENTS = ["random_reflect"]
EXPECTED_COUNTS = [2, 4, 6, 10, 20]
EXPECTED_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
EXPECTED_STRATEGIES = [
    "FULL_SCAN",
    "PID_ROI",
    "BELIEF_PSO_V3_NO_PSO",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING",
    "BELIEF_PSO_V3",
]
PROPOSED_STRATEGY = "BELIEF_PSO_V3"
ABLATED_STRATEGIES = [
    "BELIEF_PSO_V3_NO_PSO",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING",
]

STRATEGY_LABELS = {
    "FULL_SCAN": "Full Scan",
    "PID_ROI": "PID ROI",
    "BELIEF_PSO_V3_NO_PSO": "No PSO",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": "No Repair",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": "No Redundant",
    "BELIEF_PSO_V3": "Proposed",
}

AQUASCAN_COLORS = {
    "FULL_SCAN": "#999999",
    "PID_ROI": "#9FACD3",
    "BELIEF_PSO_V3_NO_PSO": "#F2B74D",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": "#67B1D7",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": "#84C2AE",
    "BELIEF_PSO_V3": "#E38D8C",
}

AQUASCAN_HATCHES = {
    "FULL_SCAN": "///",
    "PID_ROI": "++",
    "BELIEF_PSO_V3_NO_PSO": "..",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": "--",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": "\\\\\\",
    "BELIEF_PSO_V3": "xx",
}

CORE_METRICS = [
    {"key": "f1", "label": "F1", "better": "higher"},
    {"key": "recall", "label": "Recall", "better": "higher"},
    {"key": "precision", "label": "Precision", "better": "higher"},
    {"key": "avgAoISec", "label": "Scan Interval (s)", "better": "lower"},
    {"key": "p90AoISec", "label": "P90 AoI (s)", "better": "lower"},
    {"key": "trackingRate", "label": "Tracking Rate", "better": "higher"},
    {"key": "strictTrackAccuracy", "label": "Strict Tracking Accuracy", "better": "higher"},
    {"key": "localTrackAccuracy", "label": "Tracking Accuracy", "better": "higher"},
    {"key": "trackContinuity", "label": "Identity Continuity", "better": "higher"},
    {"key": "trackingRMSEm", "label": "Tracking RMSE (m)", "better": "lower"},
    {"key": "gospa", "label": "GOSPA", "better": "lower"},
    {"key": "avgScanRateHz", "label": "Scanned Rate (Hz)", "better": "higher"},
    {"key": "sonarBusyRatio", "label": "Sonar Workload", "better": "lower"},
    {"key": "searchCoverageRatio", "label": "Search Coverage", "better": "higher"},
    {"key": "beamRateHz", "label": "Beam Rate (Hz)", "better": "context"},
    {"key": "decisionLatencyP95Ms", "label": "Planner Latency (P95 ms)", "better": "lower"},
]

FOCUS_METRICS = [
    {"key": "localTrackAccuracy", "label": "Tracking Accuracy", "filename": "localTrackAccuracy"},
    {"key": "avgAoISec", "label": "Scan Interval", "filename": "avgAoISec"},
    {"key": "avgScanRateHz", "label": "Scanned Rate", "filename": "avgScanRateHz"},
    {"key": "trackContinuity", "label": "Identity Continuity", "filename": "trackContinuity"},
    {"key": "sonarBusyRatio", "label": "Sonar Workload", "filename": "sonarBusyRatio"},
    {"key": "searchCoverageRatio", "label": "Search Coverage", "filename": "searchCoverageRatio"},
    {"key": "decisionLatencyP95Ms", "label": "Planner Latency", "filename": "decisionLatencyP95Ms"},
]

PERCENT_METRICS = {
    "strictTrackAccuracy",
    "localTrackAccuracy",
    "trackContinuity",
    "sonarBusyRatio",
    "searchCoverageRatio",
    "trackingRate",
    "f1",
    "recall",
    "precision",
}


def is_finite(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def resolve_input(input_path: Path) -> tuple[Path, Path, Path, Path]:
    if input_path.is_dir():
        output_dir = input_path
        return (
            output_dir,
            output_dir / "runs.jsonl",
            output_dir / "samples.jsonl",
            output_dir / "manifest.json",
        )
    output_dir = input_path.parent
    return output_dir, input_path, output_dir / "samples.jsonl", output_dir / "manifest.json"


def movement_label(row: dict) -> str:
    return str(row.get("movementModel") or row.get("scenario") or "")


def count_value(row: dict) -> int:
    return int(row.get("swimmerCount") or row.get("finalTruthCount") or 0)


def metric_value(row: dict, key: str) -> float:
    for section in ("aggregateMetrics", "finalMetrics", "commandMetrics"):
        value = (row.get(section) or {}).get(key)
        if is_finite(value):
            return float(value)
    return float("nan")


def mean(values: list[float]) -> float:
    clean = [float(value) for value in values if math.isfinite(float(value))]
    return float(np.mean(clean)) if clean else float("nan")


def std(values: list[float]) -> float:
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if len(clean) <= 1:
        return 0.0 if clean else float("nan")
    return float(np.std(clean, ddof=1))


def stat(values: list[float]) -> dict:
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if not clean:
        return {
            "n": 0,
            "mean": float("nan"),
            "std": float("nan"),
            "ci95": float("nan"),
            "min": float("nan"),
            "max": float("nan"),
            "lowerError": float("nan"),
            "upperError": float("nan"),
        }
    m = mean(clean)
    s = std(clean)
    min_value = min(clean)
    max_value = max(clean)
    return {
        "n": len(clean),
        "mean": m,
        "std": s,
        "ci95": 1.96 * s / math.sqrt(len(clean)) if len(clean) > 1 else 0.0,
        "min": min_value,
        "max": max_value,
        "lowerError": m - min_value,
        "upperError": max_value - m,
    }


def metric_ids(rows: list[dict]) -> list[str]:
    observed = {
        key
        for row in rows
        for section in ("aggregateMetrics", "finalMetrics", "commandMetrics")
        for key, value in (row.get(section) or {}).items()
        if is_finite(value)
    }
    ordered = [metric["key"] for metric in CORE_METRICS if metric["key"] in observed]
    ordered.extend(sorted(observed - set(ordered)))
    return ordered


def grouped_rows(rows: list[dict]) -> dict[tuple[str, int, str, str], list[dict]]:
    groups: dict[tuple[str, int, str, str], list[dict]] = defaultdict(list)
    for row in rows:
        key = (
            movement_label(row),
            count_value(row),
            str(row.get("strategy") or ""),
            str(row.get("sensorProfile") or ""),
        )
        groups[key].append(row)
    return groups


def strategy_rank(strategy: str) -> tuple[int, str]:
    try:
        return EXPECTED_STRATEGIES.index(strategy), strategy
    except ValueError:
        return len(EXPECTED_STRATEGIES), strategy


def make_summary(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    groups = grouped_rows(rows)
    metrics = metric_ids(rows)
    summary_rows: list[dict] = []
    plot_rows: list[dict] = []
    for key in sorted(groups.keys(), key=lambda item: (item[0], item[1], strategy_rank(item[2]), item[3])):
        movement, count, strategy, sensor_profile = key
        group = groups[key]
        seeds = sorted({int(row.get("seed")) for row in group if row.get("seed") is not None})
        metric_stats: dict[str, dict] = {}
        for metric in metrics:
            stats = stat([metric_value(row, metric) for row in group])
            metric_stats[metric] = {
                "mean": stats["mean"],
                "std": stats["std"],
                "ci95": stats["ci95"],
                "min": stats["min"],
                "max": stats["max"],
            }
            summary_rows.append({
                "movementModel": movement,
                "swimmerCount": count,
                "strategy": strategy,
                "sensorProfile": sensor_profile,
                "runCount": len(group),
                "seeds": " ".join(str(seed) for seed in seeds),
                "metric": metric,
                "n": stats["n"],
                "mean": stats["mean"],
                "std": stats["std"],
                "ci95": stats["ci95"],
                "min": stats["min"],
                "max": stats["max"],
                "lowerError": stats["lowerError"],
                "upperError": stats["upperError"],
            })
        plot_rows.append({
            "movementModel": movement,
            "swimmerCount": count,
            "restingSwimmerCount": group[0].get("restingSwimmerCount", 0),
            "strategy": strategy,
            "sensorProfile": sensor_profile,
            "runCount": len(group),
            "seeds": seeds,
            "metrics": metric_stats,
        })
    return summary_rows, plot_rows


def make_run_metric_rows(rows: list[dict]) -> list[dict]:
    metrics = metric_ids(rows)
    output: list[dict] = []
    for row in sorted(rows, key=lambda item: (movement_label(item), count_value(item), strategy_rank(str(item.get("strategy") or "")), int(item.get("seed") or 0))):
        for metric in metrics:
            value = metric_value(row, metric)
            if not math.isfinite(value):
                continue
            output.append({
                "movementModel": movement_label(row),
                "swimmerCount": count_value(row),
                "restingSwimmerCount": row.get("restingSwimmerCount", 0),
                "strategy": row.get("strategy", ""),
                "sensorProfile": row.get("sensorProfile", ""),
                "seed": row.get("seed", ""),
                "metric": metric,
                "value": value,
            })
    return output


def make_paired_delta_rows(rows: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    metrics = metric_ids(rows)
    by_key = {
        (
            movement_label(row),
            count_value(row),
            str(row.get("strategy") or ""),
            int(row.get("seed") or 0),
        ): row
        for row in rows
    }
    per_seed_rows: list[dict] = []
    by_group: dict[tuple[str, int, str, str], list[float]] = defaultdict(list)

    for movement in EXPECTED_MOVEMENTS:
        for count in EXPECTED_COUNTS:
            for ablated in ABLATED_STRATEGIES:
                for seed in EXPECTED_SEEDS:
                    proposed = by_key.get((movement, count, PROPOSED_STRATEGY, seed))
                    variant = by_key.get((movement, count, ablated, seed))
                    if proposed is None or variant is None:
                        continue
                    for metric in metrics:
                        proposed_value = metric_value(proposed, metric)
                        variant_value = metric_value(variant, metric)
                        if not math.isfinite(proposed_value) or not math.isfinite(variant_value):
                            continue
                        delta = proposed_value - variant_value
                        per_seed_rows.append({
                            "movementModel": movement,
                            "swimmerCount": count,
                            "seed": seed,
                            "proposedStrategy": PROPOSED_STRATEGY,
                            "ablatedStrategy": ablated,
                            "ablatedLabel": STRATEGY_LABELS[ablated],
                            "metric": metric,
                            "proposedValue": proposed_value,
                            "ablatedValue": variant_value,
                            "delta": delta,
                        })
                        by_group[(movement, count, ablated, metric)].append(delta)

    summary_rows: list[dict] = []
    plot_rows: list[dict] = []
    for key in sorted(by_group.keys(), key=lambda item: (item[0], item[1], strategy_rank(item[2]), item[3])):
        movement, count, ablated, metric = key
        stats = stat(by_group[key])
        summary_rows.append({
            "movementModel": movement,
            "swimmerCount": count,
            "proposedStrategy": PROPOSED_STRATEGY,
            "ablatedStrategy": ablated,
            "ablatedLabel": STRATEGY_LABELS[ablated],
            "metric": metric,
            "n": stats["n"],
            "meanDelta": stats["mean"],
            "stdDelta": stats["std"],
            "ci95Delta": stats["ci95"],
            "minDelta": stats["min"],
            "maxDelta": stats["max"],
        })
        plot_rows.append({
            "movementModel": movement,
            "swimmerCount": count,
            "proposedStrategy": PROPOSED_STRATEGY,
            "ablatedStrategy": ablated,
            "ablatedLabel": STRATEGY_LABELS[ablated],
            "metric": metric,
            "n": stats["n"],
            "meanDelta": stats["mean"],
            "stdDelta": stats["std"],
            "minDelta": stats["min"],
            "maxDelta": stats["max"],
        })
    return per_seed_rows, summary_rows, plot_rows


def csv_cell(value: object) -> object:
    if isinstance(value, float) and not math.isfinite(value):
        return ""
    return value


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            if key not in seen:
                seen.add(key)
                fields.append(key)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: csv_cell(row.get(field, "")) for field in fields})


def json_safe(value: object) -> object:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


def validate_matrix(rows: list[dict]) -> dict:
    by_cell: dict[tuple[str, int, str], list[dict]] = defaultdict(list)
    for row in rows:
        by_cell[(movement_label(row), count_value(row), str(row.get("strategy") or ""))].append(row)

    expected = {
        (movement, count, strategy)
        for movement in EXPECTED_MOVEMENTS
        for count in EXPECTED_COUNTS
        for strategy in EXPECTED_STRATEGIES
    }
    bad_cells = []
    for cell in sorted(expected, key=lambda item: (item[0], item[1], strategy_rank(item[2]))):
        cell_rows = by_cell.get(cell, [])
        seeds = sorted({int(row.get("seed")) for row in cell_rows if row.get("seed") is not None})
        if seeds != EXPECTED_SEEDS or len(cell_rows) != len(EXPECTED_SEEDS):
            bad_cells.append({
                "movementModel": cell[0],
                "swimmerCount": cell[1],
                "strategy": cell[2],
                "runCount": len(cell_rows),
                "seeds": seeds,
                "missingSeeds": [seed for seed in EXPECTED_SEEDS if seed not in seeds],
                "extraSeeds": [seed for seed in seeds if seed not in EXPECTED_SEEDS],
            })
    extra_cells = [
        {
            "movementModel": cell[0],
            "swimmerCount": cell[1],
            "strategy": cell[2],
            "runCount": len(by_cell[cell]),
            "seeds": sorted({int(row.get("seed")) for row in by_cell[cell] if row.get("seed") is not None}),
        }
        for cell in sorted(set(by_cell.keys()) - expected, key=lambda item: (item[0], item[1], strategy_rank(item[2])))
    ]
    expected_run_count = (
        len(EXPECTED_MOVEMENTS)
        * len(EXPECTED_COUNTS)
        * len(EXPECTED_STRATEGIES)
        * len(EXPECTED_SEEDS)
    )
    return {
        "expectedRunCount": expected_run_count,
        "actualRunCount": len(rows),
        "expectedMovements": EXPECTED_MOVEMENTS,
        "expectedSwimmerCounts": EXPECTED_COUNTS,
        "expectedStrategies": EXPECTED_STRATEGIES,
        "expectedSeeds": EXPECTED_SEEDS,
        "badCellCount": len(bad_cells),
        "badCells": bad_cells,
        "extraCellCount": len(extra_cells),
        "extraCells": extra_cells,
        "complete": len(rows) == expected_run_count and not bad_cells and not extra_cells,
    }


def is_percent_metric(metric_key: str) -> bool:
    return metric_key in PERCENT_METRICS


def scaled_value(value: float, metric_key: str) -> float:
    if not math.isfinite(value):
        return float("nan")
    return value * 100.0 if is_percent_metric(metric_key) else value


def ylabel_for(metric_key: str) -> str:
    labels = {
        "strictTrackAccuracy": "Strict tracking accuracy (%)",
        "localTrackAccuracy": "Tracking accuracy (%)",
        "trackContinuity": "Identity continuity (%)",
        "avgAoISec": "Mean scan interval (s)",
        "avgScanRateHz": "Scanned rate (Hz)",
        "sonarBusyRatio": "Sonar workload (%)",
        "searchCoverageRatio": "Search coverage (%)",
        "decisionLatencyP95Ms": "Planner latency P95 (ms)",
    }
    return labels.get(metric_key, metric_key)


def delta_ylabel_for(metric_key: str) -> str:
    labels = {
        "strictTrackAccuracy": "Strict tracking accuracy delta (pp)",
        "localTrackAccuracy": "Tracking accuracy delta (pp)",
        "trackContinuity": "Identity continuity delta (pp)",
        "avgAoISec": "Mean scan interval delta (s)",
        "avgScanRateHz": "Scanned rate delta (Hz)",
        "sonarBusyRatio": "Sonar workload delta (pp)",
        "searchCoverageRatio": "Search coverage delta (pp)",
        "decisionLatencyP95Ms": "Planner latency P95 delta (ms)",
    }
    return labels.get(metric_key, f"{metric_key} delta")


def ylim_for(metric_key: str, values: list[float]) -> tuple[float, float]:
    clean = [value for value in values if math.isfinite(value)]
    if not clean:
        return 0.0, 1.0
    lower = min(clean)
    upper = max(clean)
    span = max(upper - lower, 1e-9)
    if is_percent_metric(metric_key):
        if lower >= 70.0:
            pad = max(0.8, span * 0.18)
            return max(0.0, lower - pad), min(101.5, upper + pad)
        return 0.0, min(101.5, max(upper * 1.08, 10.0))
    if metric_key == "decisionLatencyP95Ms":
        return 0.0, upper * 1.12 if upper > 0 else 1.0
    if lower > 0 and upper / max(lower, 1e-9) < 1.7:
        pad = max(span * 0.18, upper * 0.03)
        return max(0.0, lower - pad), upper + pad
    return 0.0, upper * 1.15 if upper > 0 else 1.0


def delta_ylim_for(metric_key: str, values: list[float]) -> tuple[float, float]:
    clean = [value for value in values if math.isfinite(value)]
    if not clean:
        return -1.0, 1.0
    lower = min(min(clean), 0.0)
    upper = max(max(clean), 0.0)
    span = max(upper - lower, 1e-9)
    if is_percent_metric(metric_key):
        pad = max(0.35, span * 0.18)
    elif metric_key == "decisionLatencyP95Ms":
        pad = max(8.0, span * 0.16)
    elif metric_key == "avgScanRateHz":
        pad = max(0.015, span * 0.18)
    else:
        pad = max(0.04, span * 0.18)
    return lower - pad, upper + pad


def configure_plot_style() -> None:
    plt.rcParams.update({
        "font.family": "Times New Roman",
        "font.size": 14,
        "axes.labelsize": 15,
        "xtick.labelsize": 13,
        "ytick.labelsize": 13,
        "legend.fontsize": 12,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
    })


def build_lookup(plot_rows: list[dict]) -> dict[tuple[str, int, str], dict]:
    return {
        (row["movementModel"], int(row["swimmerCount"]), row["strategy"]): row
        for row in plot_rows
    }


def plot_metric(plot_rows: list[dict], metric: dict, charts_dir: Path) -> dict:
    configure_plot_style()
    movements = [movement for movement in EXPECTED_MOVEMENTS if any(row["movementModel"] == movement for row in plot_rows)]
    if not movements:
        movements = sorted({row["movementModel"] for row in plot_rows})
    counts = [count for count in EXPECTED_COUNTS if any(int(row["swimmerCount"]) == count for row in plot_rows)]
    strategies = [strategy for strategy in EXPECTED_STRATEGIES if any(row["strategy"] == strategy for row in plot_rows)]
    lookup = build_lookup(plot_rows)

    fig_width = max(10.2, 6.0 * len(movements))
    fig, axes = plt.subplots(1, len(movements), figsize=(fig_width, 3.65), squeeze=False)
    axes = axes[0]
    x = np.arange(len(counts), dtype=float) * 1.25
    width = min(0.135, 0.82 / max(1, len(strategies)))
    offsets = (np.arange(len(strategies)) - (len(strategies) - 1) / 2.0) * width
    all_values: list[float] = []
    legend_handles = []
    legend_labels = []

    for axis, movement in zip(axes, movements):
        for strategy_index, strategy in enumerate(strategies):
            values = []
            for count in counts:
                row = lookup.get((movement, count, strategy))
                if not row:
                    values.append(float("nan"))
                    continue
                raw = row.get("metrics", {}).get(metric["key"], {}).get("mean", float("nan"))
                values.append(scaled_value(float(raw), metric["key"]) if is_finite(raw) else float("nan"))
            all_values.extend(values)
            color = AQUASCAN_COLORS[strategy]
            bars = axis.bar(
                x + offsets[strategy_index],
                values,
                width=width,
                label=STRATEGY_LABELS[strategy],
                facecolor="white",
                edgecolor=color,
                hatch=AQUASCAN_HATCHES[strategy],
                linewidth=1.45,
                zorder=100,
            )
            if axis is axes[0]:
                legend_handles.append(bars[0])
                legend_labels.append(STRATEGY_LABELS[strategy])

        axis.set_xticks(x)
        axis.set_xticklabels([str(count) for count in counts])
        axis.set_xlabel("Swimmer count")
        axis.yaxis.grid(True, zorder=0, color="#d9d9d9", linestyle="-", linewidth=0.75)
        axis.set_axisbelow(True)
        axis.spines["top"].set_visible(False)
        axis.spines["right"].set_visible(False)
        axis.spines["left"].set_linewidth(1.0)
        axis.spines["bottom"].set_linewidth(1.0)
        axis.tick_params(axis="both", width=1.0, length=5)
        if len(movements) > 1:
            axis.text(0.5, 1.02, movement, transform=axis.transAxes, ha="center", va="bottom")

    ymin, ymax = ylim_for(metric["key"], all_values)
    for axis in axes:
        axis.set_ylim(ymin, ymax)
        if is_percent_metric(metric["key"]):
            axis.yaxis.set_major_formatter(mticker.StrMethodFormatter("{x:.0f}"))
    axes[0].set_ylabel(ylabel_for(metric["key"]))

    fig.legend(
        legend_handles,
        legend_labels,
        loc="upper center",
        ncol=min(6, len(legend_labels)),
        bbox_to_anchor=(0.5, 1.035),
        frameon=False,
        handletextpad=0.35,
        columnspacing=0.8,
        labelspacing=0.15,
    )
    fig.text(0.985, 0.018, "Mean across 10 seeds; no error bars", ha="right", va="bottom", fontsize=11, color="#6b6b6b")
    fig.tight_layout(rect=(0, 0.035, 1, 0.90))

    output_path = charts_dir / f"{metric['filename']}.png"
    fig.savefig(output_path, dpi=300, bbox_inches="tight", pad_inches=0.02)
    fig.savefig(output_path.with_suffix(".pdf"), format="pdf", bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return {"metric": metric["key"], "png": str(output_path), "pdf": str(output_path.with_suffix(".pdf"))}


def delta_lookup(delta_plot_rows: list[dict]) -> dict[tuple[str, int, str, str], dict]:
    return {
        (
            row["movementModel"],
            int(row["swimmerCount"]),
            row["ablatedStrategy"],
            row["metric"],
        ): row
        for row in delta_plot_rows
    }


def plot_delta_metric(delta_plot_rows: list[dict], metric: dict, charts_dir: Path) -> dict:
    configure_plot_style()
    lookup = delta_lookup(delta_plot_rows)
    counts = [count for count in EXPECTED_COUNTS if any(int(row["swimmerCount"]) == count for row in delta_plot_rows)]
    movement = EXPECTED_MOVEMENTS[0]
    x = np.arange(len(counts), dtype=float) * 1.25
    width = min(0.19, 0.72 / max(1, len(ABLATED_STRATEGIES)))
    offsets = (np.arange(len(ABLATED_STRATEGIES)) - (len(ABLATED_STRATEGIES) - 1) / 2.0) * width

    fig, ax = plt.subplots(figsize=(10.2, 3.65))
    all_values: list[float] = []
    legend_handles = []
    legend_labels = []
    for strategy_index, ablated in enumerate(ABLATED_STRATEGIES):
        values = []
        for count in counts:
            row = lookup.get((movement, count, ablated, metric["key"]))
            raw = row.get("meanDelta", float("nan")) if row else float("nan")
            values.append(scaled_value(float(raw), metric["key"]) if is_finite(raw) else float("nan"))
        all_values.extend(values)
        color = AQUASCAN_COLORS[ablated]
        bars = ax.bar(
            x + offsets[strategy_index],
            values,
            width=width,
            label=STRATEGY_LABELS[ablated],
            facecolor="white",
            edgecolor=color,
            hatch=AQUASCAN_HATCHES[ablated],
            linewidth=1.45,
            zorder=100,
        )
        legend_handles.append(bars[0])
        legend_labels.append(STRATEGY_LABELS[ablated])

    ax.axhline(0, color="#2f2f2f", linewidth=1.0, zorder=80)
    ax.set_xticks(x)
    ax.set_xticklabels([str(count) for count in counts])
    ax.set_xlabel("Swimmer count")
    ax.set_ylabel(delta_ylabel_for(metric["key"]))
    ax.yaxis.grid(True, zorder=0, color="#d9d9d9", linestyle="-", linewidth=0.75)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_linewidth(1.0)
    ax.spines["bottom"].set_linewidth(1.0)
    ax.tick_params(axis="both", width=1.0, length=5)
    ax.set_ylim(*delta_ylim_for(metric["key"], all_values))

    fig.legend(
        legend_handles,
        legend_labels,
        loc="upper center",
        ncol=min(3, len(legend_labels)),
        bbox_to_anchor=(0.5, 1.035),
        frameon=False,
        handletextpad=0.35,
        columnspacing=0.9,
    )
    fig.text(0.985, 0.018, "Proposed - ablated variant; paired mean across 10 seeds; no error bars", ha="right", va="bottom", fontsize=11, color="#6b6b6b")
    fig.tight_layout(rect=(0, 0.035, 1, 0.90))

    output_path = charts_dir / f"delta_proposed_minus_ablation_{metric['filename']}.png"
    fig.savefig(output_path, dpi=300, bbox_inches="tight", pad_inches=0.02)
    fig.savefig(output_path.with_suffix(".pdf"), format="pdf", bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return {"metric": f"delta_{metric['key']}", "png": str(output_path), "pdf": str(output_path.with_suffix(".pdf"))}


def plot_core_panel(plot_rows: list[dict], charts_dir: Path) -> dict:
    configure_plot_style()
    metrics = [
        {"key": "localTrackAccuracy", "label": "Tracking accuracy (%)"},
        {"key": "avgAoISec", "label": "Mean scan interval (s)"},
        {"key": "avgScanRateHz", "label": "Scanned rate (Hz)"},
    ]
    counts = [count for count in EXPECTED_COUNTS if any(int(row["swimmerCount"]) == count for row in plot_rows)]
    strategies = [strategy for strategy in EXPECTED_STRATEGIES if any(row["strategy"] == strategy for row in plot_rows)]
    lookup = build_lookup(plot_rows)
    movement = EXPECTED_MOVEMENTS[0]

    fig, axes = plt.subplots(3, 1, figsize=(10.8, 8.2), sharex=True)
    x = np.arange(len(counts), dtype=float) * 1.25
    width = min(0.135, 0.82 / max(1, len(strategies)))
    offsets = (np.arange(len(strategies)) - (len(strategies) - 1) / 2.0) * width
    legend_handles = []
    legend_labels = []

    for axis, metric in zip(axes, metrics):
        all_values: list[float] = []
        for strategy_index, strategy in enumerate(strategies):
            values = []
            for count in counts:
                row = lookup.get((movement, count, strategy))
                raw = row.get("metrics", {}).get(metric["key"], {}).get("mean", float("nan")) if row else float("nan")
                values.append(scaled_value(float(raw), metric["key"]) if is_finite(raw) else float("nan"))
            all_values.extend(values)
            color = AQUASCAN_COLORS[strategy]
            bars = axis.bar(
                x + offsets[strategy_index],
                values,
                width=width,
                label=STRATEGY_LABELS[strategy],
                facecolor="white",
                edgecolor=color,
                hatch=AQUASCAN_HATCHES[strategy],
                linewidth=1.45,
                zorder=100,
            )
            if axis is axes[0]:
                legend_handles.append(bars[0])
                legend_labels.append(STRATEGY_LABELS[strategy])
        axis.set_ylabel(metric["label"])
        axis.yaxis.grid(True, zorder=0, color="#d9d9d9", linestyle="-", linewidth=0.75)
        axis.set_axisbelow(True)
        axis.spines["top"].set_visible(False)
        axis.spines["right"].set_visible(False)
        axis.spines["left"].set_linewidth(1.0)
        axis.spines["bottom"].set_linewidth(1.0)
        axis.tick_params(axis="both", width=1.0, length=5)
        ymin, ymax = ylim_for(metric["key"], all_values)
        axis.set_ylim(ymin, ymax)
        if is_percent_metric(metric["key"]):
            axis.yaxis.set_major_formatter(mticker.StrMethodFormatter("{x:.0f}"))

    axes[-1].set_xticks(x)
    axes[-1].set_xticklabels([str(count) for count in counts])
    axes[-1].set_xlabel("Swimmer count")
    fig.legend(
        legend_handles,
        legend_labels,
        loc="upper center",
        ncol=min(6, len(legend_labels)),
        bbox_to_anchor=(0.5, 1.01),
        frameon=False,
        handletextpad=0.35,
        columnspacing=0.8,
    )
    fig.text(0.985, 0.012, "Mean across 10 seeds; no error bars", ha="right", va="bottom", fontsize=11, color="#6b6b6b")
    fig.tight_layout(rect=(0, 0.035, 1, 0.955), h_pad=1.1)
    output_path = charts_dir / "paper_ablation_absolute_no_errorbar.png"
    fig.savefig(output_path, dpi=300, bbox_inches="tight", pad_inches=0.02)
    fig.savefig(output_path.with_suffix(".pdf"), format="pdf", bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return {"metric": "core_panel", "png": str(output_path), "pdf": str(output_path.with_suffix(".pdf"))}


def plot_delta_core_panel(delta_plot_rows: list[dict], charts_dir: Path) -> dict:
    configure_plot_style()
    metrics = [
        {"key": "localTrackAccuracy", "label": "Track acc. delta (pp)"},
        {"key": "avgAoISec", "label": "Interval delta (s)"},
        {"key": "avgScanRateHz", "label": "Rate delta (Hz)"},
    ]
    lookup = delta_lookup(delta_plot_rows)
    counts = [count for count in EXPECTED_COUNTS if any(int(row["swimmerCount"]) == count for row in delta_plot_rows)]
    movement = EXPECTED_MOVEMENTS[0]
    x = np.arange(len(counts), dtype=float) * 1.25
    width = min(0.19, 0.72 / max(1, len(ABLATED_STRATEGIES)))
    offsets = (np.arange(len(ABLATED_STRATEGIES)) - (len(ABLATED_STRATEGIES) - 1) / 2.0) * width

    fig, axes = plt.subplots(3, 1, figsize=(10.8, 8.2), sharex=True)
    legend_handles = []
    legend_labels = []
    for axis, metric in zip(axes, metrics):
        all_values: list[float] = []
        for strategy_index, ablated in enumerate(ABLATED_STRATEGIES):
            values = []
            for count in counts:
                row = lookup.get((movement, count, ablated, metric["key"]))
                raw = row.get("meanDelta", float("nan")) if row else float("nan")
                values.append(scaled_value(float(raw), metric["key"]) if is_finite(raw) else float("nan"))
            all_values.extend(values)
            color = AQUASCAN_COLORS[ablated]
            bars = axis.bar(
                x + offsets[strategy_index],
                values,
                width=width,
                label=STRATEGY_LABELS[ablated],
                facecolor="white",
                edgecolor=color,
                hatch=AQUASCAN_HATCHES[ablated],
                linewidth=1.45,
                zorder=100,
            )
            if axis is axes[0]:
                legend_handles.append(bars[0])
                legend_labels.append(STRATEGY_LABELS[ablated])
        axis.axhline(0, color="#2f2f2f", linewidth=1.0, zorder=80)
        axis.set_ylabel(metric["label"])
        axis.yaxis.grid(True, zorder=0, color="#d9d9d9", linestyle="-", linewidth=0.75)
        axis.set_axisbelow(True)
        axis.spines["top"].set_visible(False)
        axis.spines["right"].set_visible(False)
        axis.spines["left"].set_linewidth(1.0)
        axis.spines["bottom"].set_linewidth(1.0)
        axis.tick_params(axis="both", width=1.0, length=5)
        axis.set_ylim(*delta_ylim_for(metric["key"], all_values))

    axes[-1].set_xticks(x)
    axes[-1].set_xticklabels([str(count) for count in counts])
    axes[-1].set_xlabel("Swimmer count")
    fig.legend(
        legend_handles,
        legend_labels,
        loc="upper center",
        ncol=min(3, len(legend_labels)),
        bbox_to_anchor=(0.5, 1.01),
        frameon=False,
        handletextpad=0.35,
        columnspacing=0.9,
    )
    fig.text(0.985, 0.012, "Proposed - ablated variant; paired mean across 10 seeds; no error bars", ha="right", va="bottom", fontsize=11, color="#6b6b6b")
    fig.tight_layout(rect=(0, 0.035, 1, 0.955), h_pad=1.1)
    output_path = charts_dir / "paper_proposed_minus_ablation_no_errorbar.png"
    fig.savefig(output_path, dpi=300, bbox_inches="tight", pad_inches=0.02)
    fig.savefig(output_path.with_suffix(".pdf"), format="pdf", bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return {"metric": "delta_core_panel", "png": str(output_path), "pdf": str(output_path.with_suffix(".pdf"))}


def copy_raw_files(runs_path: Path, samples_path: Path, manifest_path: Path, data_dir: Path) -> dict:
    data_dir.mkdir(parents=True, exist_ok=True)
    copied = {}
    for label, path in (("runs", runs_path), ("samples", samples_path), ("manifest", manifest_path)):
        if path.exists():
            dest = data_dir / path.name
            shutil.copy2(path, dest)
            copied[label] = str(dest)
    return copied


def write_report(report_dir: Path, summary: dict, chart_files: list[dict], delta_chart_files: list[dict]) -> Path:
    report_path = report_dir / "ablation_absolute_report.md"
    chart_lines = []
    for chart in chart_files:
        if chart["metric"] == "core_panel":
            continue
        metric = chart["metric"]
        chart_lines.extend([
            f"### {metric}",
            "",
            f"![{metric}](charts/{Path(chart['png']).name})",
            "",
        ])
    delta_chart_lines = []
    for chart in delta_chart_files:
        if chart["metric"] == "delta_core_panel":
            continue
        metric = chart["metric"].removeprefix("delta_")
        delta_chart_lines.extend([
            f"### {metric}",
            "",
            f"![{metric}](charts/{Path(chart['png']).name})",
            "",
        ])
    report_path.write_text("\n".join([
        "# V3 ablation 300-run charts",
        "",
        "This report uses the 5 density x 6 strategy x 10 seed matrix. Absolute figures are grouped-bar mean values. Delta figures show `Proposed - ablated variant` paired means by seed. No figure uses error bars. Compressed-range metrics use zoomed y-axes for readability; seed min/max/std are preserved in the CSV and JSON tables.",
        "",
        "## Matrix",
        "",
        f"- Runs: {summary['matrixValidation']['actualRunCount']} / {summary['matrixValidation']['expectedRunCount']}",
        f"- Bad cells: {summary['matrixValidation']['badCellCount']}",
        f"- Extra cells: {summary['matrixValidation']['extraCellCount']}",
        "- Movement: random_reflect",
        "- Swimmer counts: 2, 4, 6, 10, 20",
        "- Seeds: 1..10",
        "- Strategies: Full Scan, PID ROI, No PSO, No Repair, No Redundant, Proposed",
        "",
        "## Paper-ready core panel",
        "",
        "![paper_ablation_absolute_no_errorbar](charts/paper_ablation_absolute_no_errorbar.png)",
        "",
        "## Proposed minus ablated variants",
        "",
        "![paper_proposed_minus_ablation_no_errorbar](charts/paper_proposed_minus_ablation_no_errorbar.png)",
        "",
        "## Proposed-minus-ablation metric charts",
        "",
        *delta_chart_lines,
        "",
        "## E2E-style metric charts",
        "",
        *chart_lines,
        "## Data files",
        "",
        "- `data/runs.jsonl`: copied raw run summaries.",
        "- `data/samples.jsonl`: copied raw per-sample metrics.",
        "- `data/manifest.json`: copied benchmark manifest.",
        "- `tables/metrics_by_run.csv`: long-form per-run metrics.",
        "- `tables/metrics_summary.csv`: per-density/strategy summary with mean, std, ci95, min, max.",
        "- `tables/proposed_minus_ablation_by_seed.csv`: paired seed-level `Proposed - ablated variant` deltas.",
        "- `tables/proposed_minus_ablation_summary.csv`: per-density paired delta summaries.",
        "- `data/plot_data_absolute.json`: chart-ready summary payload.",
        "- `data/plot_data_proposed_minus_ablation.json`: chart-ready paired delta payload.",
        "- `summary.json`: matrix validation and chart inventory.",
        "",
    ]), encoding="utf-8")
    return report_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Benchmark output directory or runs.jsonl path")
    parser.add_argument("--out", required=True, help="Report output directory")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    report_dir = Path(args.out).resolve()
    tables_dir = report_dir / "tables"
    data_dir = report_dir / "data"
    charts_dir = report_dir / "charts"
    report_dir.mkdir(parents=True, exist_ok=True)
    tables_dir.mkdir(parents=True, exist_ok=True)
    charts_dir.mkdir(parents=True, exist_ok=True)

    benchmark_dir, runs_path, samples_path, manifest_path = resolve_input(input_path)
    rows = load_jsonl(runs_path)
    if not rows:
        raise SystemExit(f"No runs found in {runs_path}")

    matrix_validation = validate_matrix(rows)
    if not matrix_validation["complete"]:
        raise SystemExit(json.dumps(matrix_validation, indent=2))

    raw_files = copy_raw_files(runs_path, samples_path, manifest_path, data_dir)
    run_metric_rows = make_run_metric_rows(rows)
    summary_rows, plot_rows = make_summary(rows)
    delta_seed_rows, delta_summary_rows, delta_plot_rows = make_paired_delta_rows(rows)
    write_csv(tables_dir / "metrics_by_run.csv", run_metric_rows)
    write_csv(tables_dir / "metrics_summary.csv", summary_rows)
    write_csv(tables_dir / "proposed_minus_ablation_by_seed.csv", delta_seed_rows)
    write_csv(tables_dir / "proposed_minus_ablation_summary.csv", delta_summary_rows)

    plot_payload = {
        "outputLabel": rows[0].get("outputLabel", ""),
        "source": str(runs_path),
        "benchmarkOutputDir": str(benchmark_dir),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "focusMetricKeys": [metric["key"] for metric in FOCUS_METRICS],
        "focusMetrics": FOCUS_METRICS,
        "movementModels": EXPECTED_MOVEMENTS,
        "swimmerCounts": EXPECTED_COUNTS,
        "strategies": EXPECTED_STRATEGIES,
        "summaryRows": plot_rows,
        "deltaMode": False,
        "showErrorBars": False,
        "chartStyle": {
            "family": "AquaScan-inspired grouped bars",
            "barFill": "white",
            "seriesEncoding": "colored edge plus hatch",
            "palette": AQUASCAN_COLORS,
        },
    }
    (data_dir / "plot_data_absolute.json").write_text(
        json.dumps(json_safe(plot_payload), indent=2),
        encoding="utf-8",
    )
    delta_payload = {
        "outputLabel": rows[0].get("outputLabel", ""),
        "source": str(runs_path),
        "benchmarkOutputDir": str(benchmark_dir),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "deltaDefinition": "BELIEF_PSO_V3 - ablated variant, paired by seed",
        "proposedStrategy": PROPOSED_STRATEGY,
        "ablatedStrategies": ABLATED_STRATEGIES,
        "focusMetricKeys": [metric["key"] for metric in FOCUS_METRICS],
        "focusMetrics": FOCUS_METRICS,
        "movementModels": EXPECTED_MOVEMENTS,
        "swimmerCounts": EXPECTED_COUNTS,
        "summaryRows": delta_plot_rows,
        "deltaMode": True,
        "showErrorBars": False,
        "chartStyle": {
            "family": "AquaScan-inspired grouped delta bars",
            "barFill": "white",
            "seriesEncoding": "colored edge plus hatch",
            "palette": {strategy: AQUASCAN_COLORS[strategy] for strategy in ABLATED_STRATEGIES},
        },
    }
    (data_dir / "plot_data_proposed_minus_ablation.json").write_text(
        json.dumps(json_safe(delta_payload), indent=2),
        encoding="utf-8",
    )

    chart_files = [plot_metric(plot_rows, metric, charts_dir) for metric in FOCUS_METRICS]
    chart_files.insert(0, plot_core_panel(plot_rows, charts_dir))
    delta_chart_files = [plot_delta_metric(delta_plot_rows, metric, charts_dir) for metric in FOCUS_METRICS]
    delta_chart_files.insert(0, plot_delta_core_panel(delta_plot_rows, charts_dir))

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "benchmarkOutputDir": str(benchmark_dir),
        "runsPath": str(runs_path),
        "samplesPath": str(samples_path),
        "manifestPath": str(manifest_path),
        "reportDir": str(report_dir),
        "rawFiles": raw_files,
        "matrixValidation": matrix_validation,
        "focusMetricKeys": [metric["key"] for metric in FOCUS_METRICS],
        "chartFiles": chart_files,
        "deltaChartFiles": delta_chart_files,
        "deltaDefinition": "BELIEF_PSO_V3 - ablated variant, paired by seed",
        "deltaMode": False,
        "showErrorBars": False,
    }
    (report_dir / "summary.json").write_text(json.dumps(json_safe(summary), indent=2), encoding="utf-8")
    report_path = write_report(report_dir, summary, chart_files, delta_chart_files)

    print(json.dumps({
        "reportDir": str(report_dir),
        "reportPath": str(report_path),
        "runCount": len(rows),
        "badCellCount": matrix_validation["badCellCount"],
        "chartCount": len(chart_files),
        "deltaChartCount": len(delta_chart_files),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
