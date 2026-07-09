import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

matplotlib.rc("pdf", fonttype=42)
matplotlib.rc("ps", fonttype=42)
plt.rc("font", family="Times New Roman", size=14)

AQUASCAN_COLORS = [
    "#E38D8C",
    "#F2B74D",
    "#67B1D7",
    "#84C2AE",
    "#999999",
    "#9FACD3",
    "#7fc97f",
    "#beaed4",
]
AQUASCAN_HATCHES = ["xx", "//", "--", "\\\\", "OO", "++", "**", ".."]
STRATEGY_LABELS = {
    "FULL_SCAN": "Full Scan",
    "ROUND_ROBIN_SECTOR": "RR Sector",
    "ROUND_ROBIN_ROI": "RR ROI",
    "NEAREST_ROI": "Nearest ROI",
    "PID_ROI": "PID ROI",
    "BELIEF_PSO_V3": "Proposed",
    "BELIEF_PSO_V3_NO_PSO": "No PSO",
}
STRATEGY_STYLE_INDEX = {
    "BELIEF_PSO_V3": 0,
    "FULL_SCAN": 4,
    "ROUND_ROBIN_SECTOR": 1,
    "ROUND_ROBIN_ROI": 2,
    "NEAREST_ROI": 3,
    "PID_ROI": 5,
    "BELIEF_PSO_V3_NO_PSO": 6,
}


def metric_value(row, key, field):
    return row["metrics"][key][field]


def format_strategy(label):
    return STRATEGY_LABELS.get(label, label.replace("_", " "))


def is_percent_metric(metric_key):
    return metric_key in (
        "strictTrackAccuracy",
        "localTrackAccuracy",
        "trackContinuity",
        "sonarBusyRatio",
        "searchCoverageRatio",
    )


def scaled_metric_value(row, key, field):
    value = metric_value(row, key, field)
    return value * 100.0 if is_percent_metric(key) else value


def build_lookup(rows):
    lookup = {}
    for row in rows:
        lookup[(row["movementModel"], row["swimmerCount"], row["strategy"])] = row
    return lookup


def axis_ylim(metric_key, means, errors, delta_mode=False):
    finite_pairs = []
    for mean, error in zip(means, errors):
        if isinstance(error, (tuple, list)) and len(error) == 2:
            low, high = error
        else:
            low = high = error
        if math.isfinite(mean) and math.isfinite(low) and math.isfinite(high):
            finite_pairs.append((mean, low, high))
    if delta_mode:
        lower = min([m - low for m, low, _ in finite_pairs] + [0.0])
        upper = max([m + high for m, _, high in finite_pairs] + [0.0])
        span = max(upper - lower, 1e-9)
        pad = max(span * 0.12, 0.5 if is_percent_metric(metric_key) else span * 0.08)
        return lower - pad, upper + pad
    upper = max([m + high for m, _, high in finite_pairs] + [1e-9])
    if is_percent_metric(metric_key):
        return 0, min(101.9, max(100.0, upper * 1.08))
    return 0, upper * 1.15


def style_for_strategy(strategy, index):
    style_index = STRATEGY_STYLE_INDEX.get(strategy, index % len(AQUASCAN_COLORS))
    return {
        "color": AQUASCAN_COLORS[style_index % len(AQUASCAN_COLORS)],
        "hatch": AQUASCAN_HATCHES[style_index % len(AQUASCAN_HATCHES)],
    }


def y_label_for(metric, delta_mode=False):
    if delta_mode:
        if is_percent_metric(metric["key"]):
            return f"Delta {metric['label']} (pp)"
        if metric["key"] == "avgAoISec":
            return "Delta Scan Interval (s)"
        if metric["key"] == "avgScanRateHz":
            return "Delta Scanned Rate (Hz)"
        if metric["key"] == "decisionLatencyP95Ms":
            return "Delta Planner Latency (ms)"
        return f"Delta {metric['label']}"
    if metric["key"] == "strictTrackAccuracy":
        return "Strict Tracking Accuracy (%)"
    if metric["key"] == "localTrackAccuracy":
        return "Tracking Accuracy (%)"
    if metric["key"] == "trackContinuity":
        return "Identity Continuity (%)"
    if metric["key"] == "avgAoISec":
        return "Scan Interval (s)"
    if metric["key"] == "avgScanRateHz":
        return "Scanned Rate (Hz)"
    if metric["key"] == "sonarBusyRatio":
        return "Sonar Workload (%)"
    if metric["key"] == "searchCoverageRatio":
        return "Search Coverage (%)"
    if metric["key"] == "decisionLatencyP95Ms":
        return "Planner Latency (ms)"
    return metric["label"]


def plot_metric(payload, charts_dir, metric, strategies, filename, title_prefix="", subtitle=""):
    rows = payload["summaryRows"]
    lookup = build_lookup(rows)
    movements = payload["movementModels"]
    counts = payload["swimmerCounts"]
    delta_mode = bool(payload.get("deltaMode", False))
    show_error_bars = bool(payload.get("showErrorBars", True))

    plt.rcParams.update({
        "font.family": "Times New Roman",
        "font.size": 14,
        "axes.labelsize": 15,
        "xtick.labelsize": 13,
        "ytick.labelsize": 13,
        "legend.fontsize": 12,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })

    fig_width = max(10.2, 6.0 * len(movements))
    fig, axes = plt.subplots(1, len(movements), figsize=(fig_width, 3.45), squeeze=False)
    axes = axes[0]
    x = np.arange(len(counts), dtype=float) * 1.25
    bar_width = min(0.15, 0.86 / max(1, len(strategies)))
    offsets = (np.arange(len(strategies)) - (len(strategies) - 1) / 2.0) * bar_width

    legend_handles = []
    legend_labels = []
    all_means = []
    all_errors = []

    for axis, movement in zip(axes, movements):
        for strategy_index, strategy in enumerate(strategies):
            means = []
            errors = []
            for count in counts:
                row = lookup.get((movement, count, strategy))
                if row is None:
                    means.append(float("nan"))
                    errors.append((0.0, 0.0))
                    continue
                mean_value = scaled_metric_value(row, metric["key"], "mean")
                min_value = scaled_metric_value(row, metric["key"], "min")
                max_value = scaled_metric_value(row, metric["key"], "max")
                means.append(mean_value)
                errors.append((max(0.0, mean_value - min_value), max(0.0, max_value - mean_value)))
            all_means.extend([value for value in means if math.isfinite(value)])
            all_errors.extend([(low, high) for low, high in errors if math.isfinite(low) and math.isfinite(high)])
            style = style_for_strategy(strategy, strategy_index)
            bar_kwargs = {
                "label": strategy,
                "color": style["color"],
                "edgecolor": "black",
                "linewidth": 0.85,
                "zorder": 100,
            }
            if show_error_bars:
                bar_kwargs.update({
                    "yerr": np.array([
                        [low for low, _ in errors],
                        [high for _, high in errors],
                    ]),
                    "capsize": 5,
                    "error_kw": {"ecolor": "black", "elinewidth": 1.25, "capthick": 1.25, "zorder": 200},
                })
            bars = axis.bar(
                x + offsets[strategy_index],
                means,
                bar_width,
                **bar_kwargs,
            )
            for bar in bars:
                bar.set_hatch(style["hatch"])
            if axis is axes[0]:
                legend_handles.append(bars[0])
                legend_labels.append(strategy)

        axis.set_xticks(x)
        axis.set_xticklabels([str(count) for count in counts])
        axis.set_xlabel("Swimmer Count")
        axis.yaxis.grid(True, zorder=0, color="#d9d9d9", linestyle="-", linewidth=0.7)
        axis.set_axisbelow(True)
        axis.spines["top"].set_visible(False)
        axis.spines["right"].set_visible(False)
        axis.spines["left"].set_linewidth(0.9)
        axis.spines["bottom"].set_linewidth(0.9)
        if len(movements) > 1:
            axis.text(0.5, 1.02, movement, transform=axis.transAxes, ha="center", va="bottom")

    ymin, ymax = axis_ylim(metric["key"], all_means, all_errors, delta_mode)
    for axis in axes:
        axis.set_ylim(ymin, ymax)
        if delta_mode:
            axis.axhline(0, color="black", linewidth=0.8, zorder=50)
    axes[0].set_ylabel(y_label_for(metric, delta_mode))

    columns = min(6, max(1, len(strategies)))
    fig.legend(
        legend_handles,
        [format_strategy(label) for label in legend_labels],
        loc="upper center",
        ncol=columns,
        bbox_to_anchor=(0.5, 1.025),
        frameon=False,
        handletextpad=0.25,
        columnspacing=0.55,
        labelspacing=0.15,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.91))

    output_path = charts_dir / filename
    fig.savefig(output_path, dpi=300, bbox_inches="tight", pad_inches=0.02)
    fig.savefig(output_path.with_suffix(".pdf"), format="pdf", bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return {"metric": metric, "fileName": f"charts/{filename}"}


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 scripts/plot_e2e_population_charts.py <plot-data.json> <charts-dir>")
    payload_path = Path(sys.argv[1])
    charts_dir = Path(sys.argv[2])
    charts_dir.mkdir(parents=True, exist_ok=True)
    payload = json.loads(payload_path.read_text())

    chart_files = []
    main_subtitle = (
        f"{payload['ablationStrategy']} excluded from main comparison"
        if len(payload.get("ablationChartStrategies", [])) == 2
        else "All configured strategies included"
    )
    for metric in payload["focusMetrics"]:
        chart_files.append(plot_metric(
            payload,
            charts_dir,
            metric,
            payload["mainChartStrategies"],
            f"{metric['key']}.png",
            subtitle=main_subtitle,
        ))

    ablation_chart_files = []
    if len(payload["ablationChartStrategies"]) == 2:
        for metric in payload["focusMetrics"]:
            ablation_chart_files.append(plot_metric(
                payload,
                charts_dir,
                metric,
                payload["ablationChartStrategies"],
                f"ablation_{metric['key']}.png",
                title_prefix="PSO ablation: ",
                subtitle=f"{payload['candidateStrategy']} vs {payload['ablationStrategy']}",
            ))

    print(json.dumps({
        "chartFiles": chart_files,
        "ablationChartFiles": ablation_chart_files,
    }))


if __name__ == "__main__":
    main()
