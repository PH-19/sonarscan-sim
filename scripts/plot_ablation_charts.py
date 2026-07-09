#!/usr/bin/env python3
"""Generate matplotlib charts for conditional PSO ablation reports."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


COMPONENT_ORDER = [
    ("BELIEF_PSO_NO_COVERAGE", "Coverage"),
    ("BELIEF_PSO_NO_UNCERTAINTY", "Uncertainty"),
    ("BELIEF_PSO_FIXED_RANGE", "Range"),
    ("BELIEF_PSO_NO_PSO", "PSO"),
    ("BELIEF_PSO_V3_NO_COVERAGE", "Coverage"),
    ("BELIEF_PSO_V3_NO_UNCERTAINTY", "Uncertainty"),
    ("BELIEF_PSO_V3_FIXED_RANGE", "Range"),
    ("BELIEF_PSO_V3_NO_PSO", "PSO"),
    ("BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR", "Constrained repair"),
    ("BELIEF_PSO_V3_NO_REDUNDANT_TRACKING", "Redundant tracking"),
    ("BELIEF_PSO_V3_NO_RESERVE_SEARCH", "Reserve search"),
]
COMPONENT_LABELS = dict(COMPONENT_ORDER)
COMPONENT_COLORS = {
    "BELIEF_PSO_NO_COVERAGE": "#2563eb",
    "BELIEF_PSO_NO_UNCERTAINTY": "#059669",
    "BELIEF_PSO_FIXED_RANGE": "#d97706",
    "BELIEF_PSO_NO_PSO": "#7c3aed",
    "BELIEF_PSO_V3_NO_COVERAGE": "#2563eb",
    "BELIEF_PSO_V3_NO_UNCERTAINTY": "#059669",
    "BELIEF_PSO_V3_FIXED_RANGE": "#d97706",
    "BELIEF_PSO_V3_NO_PSO": "#7c3aed",
    "BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR": "#dc2626",
    "BELIEF_PSO_V3_NO_REDUNDANT_TRACKING": "#0891b2",
    "BELIEF_PSO_V3_NO_RESERVE_SEARCH": "#4b5563",
}


def is_finite(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def dimension_sort_key(label: str) -> tuple[str, int, str]:
    if "_" in label:
        prefix, _, suffix = label.rpartition("_")
        try:
            return prefix, int(suffix), label
        except ValueError:
            pass
    return label, -1, label


def dimension_label(label: str) -> str:
    if "_" in label:
        movement_model, _, suffix = label.rpartition("_")
        try:
            count = int(suffix)
        except ValueError:
            return label.replace("_", " ")
        movement_text = {
            "random_reflect": "Random swimmer",
            "lap_swim_with_rest": "Lane swim",
        }.get(movement_model, movement_model.replace("_", " "))
        return f"{movement_text}\nN={count}"
    return label.replace("_", " ")


def metric_stat(row: dict, metric: str, stat: str) -> float:
    value = row.get("metrics", {}).get(metric, {}).get(stat)
    return float(value) if is_finite(value) else 0.0


def prepare_component_grid(rows: list[dict]) -> tuple[list[str], list[str]]:
    dimensions = sorted({row["dimension"] for row in rows}, key=dimension_sort_key)
    strategies = [
        strategy
        for strategy, _ in COMPONENT_ORDER
        if any(row.get("ablationStrategy") == strategy for row in rows)
    ]
    return dimensions, strategies


def set_delta_ylim(ax: plt.Axes, values: list[float], errors: list[float]) -> None:
    if not values:
        ax.set_ylim(-1, 1)
        return
    lower = min([0.0] + [value - err for value, err in zip(values, errors)])
    upper = max([0.0] + [value + err for value, err in zip(values, errors)])
    span = max(1e-9, upper - lower)
    ax.set_ylim(lower - span * 0.18, upper + span * 0.22)


def plot_component_delta(
    rows: list[dict],
    metric: str,
    title: str,
    ylabel: str,
    output_path: Path,
) -> None:
    dimensions, strategies = prepare_component_grid(rows)
    fig, ax = plt.subplots(figsize=(12.5, 7.2), constrained_layout=False)
    if not dimensions or not strategies:
        ax.text(0.5, 0.5, "No ablation data", ha="center", va="center", fontsize=18)
        ax.axis("off")
        fig.savefig(output_path, dpi=180, bbox_inches="tight")
        plt.close(fig)
        return

    row_by_key = {
        (row["dimension"], row["ablationStrategy"]): row
        for row in rows
    }
    x_positions = list(range(len(dimensions)))
    width = min(0.18, 0.74 / max(1, len(strategies)))
    all_values: list[float] = []
    all_errors: list[float] = []

    for strategy_index, strategy in enumerate(strategies):
        offset = (strategy_index - (len(strategies) - 1) / 2) * width
        values = []
        errors = []
        for dimension in dimensions:
            row = row_by_key.get((dimension, strategy), {})
            values.append(metric_stat(row, metric, "mean"))
            errors.append(metric_stat(row, metric, "ci95"))
        all_values.extend(values)
        all_errors.extend(errors)
        ax.bar(
            [x + offset for x in x_positions],
            values,
            width=width * 0.92,
            yerr=errors,
            capsize=6,
            label=COMPONENT_LABELS.get(strategy, strategy),
            color=COMPONENT_COLORS.get(strategy, "#64748b"),
            edgecolor="#1f2937",
            linewidth=0.7,
            error_kw={"elinewidth": 1.5, "capthick": 1.5},
        )

    ax.axhline(0, color="#111827", linewidth=1.2)
    fig.suptitle(title, y=0.965, fontweight="bold")
    ax.set_ylabel(ylabel, labelpad=12)
    ax.set_xticks(x_positions)
    ax.set_xticklabels([dimension_label(dimension) for dimension in dimensions])
    ax.grid(axis="y", color="#d1d5db", linewidth=0.9, alpha=0.75)
    ax.set_axisbelow(True)
    set_delta_ylim(ax, all_values, all_errors)
    handles, labels = ax.get_legend_handles_labels()
    fig.legend(
        handles,
        labels,
        loc="upper center",
        bbox_to_anchor=(0.5, 0.895),
        ncol=min(4, len(strategies)),
        frameon=False,
        handlelength=1.4,
        columnspacing=1.2,
    )
    fig.subplots_adjust(left=0.13, right=0.98, bottom=0.16, top=0.74)
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def binomial_ci95(rate: float, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    rate = min(1.0, max(0.0, rate))
    return 1.96 * math.sqrt(rate * (1.0 - rate) / denominator)


def plot_pso_exposure(rows: list[dict], proposed_strategy: str, output_path: Path) -> None:
    proposed_rows = [
        row for row in rows
        if row.get("strategy") == proposed_strategy
    ]
    dimensions = sorted({row["dimension"] for row in proposed_rows}, key=dimension_sort_key)
    fig, ax = plt.subplots(figsize=(11.5, 6.8), constrained_layout=False)
    if not dimensions:
        ax.text(0.5, 0.5, "No PSO diagnostics", ha="center", va="center", fontsize=18)
        ax.axis("off")
        fig.savefig(output_path, dpi=180, bbox_inches="tight")
        plt.close(fig)
        return

    row_by_dimension = {row["dimension"]: row for row in proposed_rows}
    series = [
        ("Eligible", "psoEligibleRate", "decisionCount", "#ca8a04"),
        ("Accepted", "psoAcceptedRate", "psoEligibleCount", "#059669"),
        ("Changed", "psoChangedRate", "psoEligibleCount", "#2563eb"),
    ]
    x_positions = list(range(len(dimensions)))
    width = 0.22
    max_rate = 0.0
    for series_index, (label, rate_key, denominator_key, color) in enumerate(series):
        offset = (series_index - 1) * width
        values = []
        errors = []
        for dimension in dimensions:
            row = row_by_dimension[dimension]
            rate = float(row.get(rate_key) or 0.0)
            denominator = int(round(float(row.get(denominator_key) or 0)))
            values.append(rate)
            errors.append(binomial_ci95(rate, denominator))
            max_rate = max(max_rate, rate + errors[-1])
        ax.bar(
            [x + offset for x in x_positions],
            values,
            width=width * 0.9,
            yerr=errors,
            capsize=6,
            label=label,
            color=color,
            edgecolor="#1f2937",
            linewidth=0.7,
            error_kw={"elinewidth": 1.5, "capthick": 1.5},
        )

    fig.suptitle("Conditional PSO exposure", y=0.965, fontweight="bold")
    ax.set_ylabel("Rate", labelpad=12)
    ax.set_xticks(x_positions)
    ax.set_xticklabels([dimension_label(dimension) for dimension in dimensions])
    ax.set_ylim(0, min(1.0, max(0.10, max_rate * 1.18)))
    ax.yaxis.set_major_formatter(lambda value, _pos: f"{value * 100:.0f}%")
    ax.grid(axis="y", color="#d1d5db", linewidth=0.9, alpha=0.75)
    ax.set_axisbelow(True)
    handles, labels = ax.get_legend_handles_labels()
    fig.legend(
        handles,
        labels,
        loc="upper center",
        bbox_to_anchor=(0.5, 0.895),
        ncol=3,
        frameon=False,
        handlelength=1.4,
    )
    fig.subplots_adjust(left=0.12, right=0.98, bottom=0.16, top=0.74)
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: plot_ablation_charts.py <ablation_summary.json> <charts-dir>", file=sys.stderr)
        return 2

    summary_path = Path(sys.argv[1])
    chart_dir = Path(sys.argv[2])
    chart_dir.mkdir(parents=True, exist_ok=True)

    plt.rcParams.update({
        "font.size": 16,
        "axes.titlesize": 20,
        "axes.labelsize": 18,
        "xtick.labelsize": 15,
        "ytick.labelsize": 15,
        "legend.fontsize": 15,
        "figure.titlesize": 22,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "savefig.facecolor": "white",
    })

    summary = json.loads(summary_path.read_text(encoding="utf8"))
    component_rows = summary.get("componentAblations", [])
    pso_rows = summary.get("psoExposure", [])
    proposed_strategy = (
        "BELIEF_PSO_V3"
        if any(row.get("proposedStrategy") == "BELIEF_PSO_V3" for row in component_rows)
        else "BELIEF_PSO_V2"
    )

    plot_component_delta(
        component_rows,
        "localTrackAccuracy",
        "Component impact on local tracking accuracy",
        f"Delta local tracking accuracy\n{proposed_strategy} - ablation",
        chart_dir / "component_local_tracking_accuracy_delta.png",
    )
    plot_component_delta(
        component_rows,
        "avgAoISec",
        "Component impact on mean scan interval",
        f"Delta avg interval (s)\n{proposed_strategy} - ablation",
        chart_dir / "component_interval_delta.png",
    )
    plot_component_delta(
        component_rows,
        "avgScanRateHz",
        "Component impact on average scanned rate",
        f"Delta avg scanned rate (Hz)\n{proposed_strategy} - ablation",
        chart_dir / "component_scanned_rate_delta.png",
    )
    plot_pso_exposure(pso_rows, proposed_strategy, chart_dir / "pso_exposure.png")

    print(json.dumps({
        "chartFiles": [
            "component_local_tracking_accuracy_delta.png",
            "component_interval_delta.png",
            "component_scanned_rate_delta.png",
            "pso_exposure.png",
        ]
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
