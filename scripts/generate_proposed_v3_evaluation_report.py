#!/usr/bin/env python3
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
import matplotlib.pyplot as plt
import numpy as np


STRATEGY_LABELS = {
    "FULL_SCAN": "Full Scan",
    "ROUND_ROBIN_SECTOR": "Round-Robin Sector",
    "ROUND_ROBIN_ROI": "Round-Robin ROI",
    "NEAREST_ROI": "Nearest ROI",
    "PID_ROI": "PID ROI",
    "BELIEF_PSO_V3": "Belief-PSO V3",
    "BELIEF_PSO_V3_NO_COVERAGE": "No Coverage",
    "BELIEF_PSO_V3_NO_UNCERTAINTY": "No Uncertainty",
    "BELIEF_PSO_V3_FIXED_RANGE": "Fixed Range",
    "BELIEF_PSO_V3_NO_PSO": "No PSO",
}

STRATEGY_COLORS = {
    "FULL_SCAN": "#4b5563",
    "ROUND_ROBIN_SECTOR": "#2563eb",
    "ROUND_ROBIN_ROI": "#0891b2",
    "NEAREST_ROI": "#f97316",
    "PID_ROI": "#0891b2",
    "BELIEF_PSO_V3": "#dc2626",
    "BELIEF_PSO_V3_NO_COVERAGE": "#2563eb",
    "BELIEF_PSO_V3_NO_UNCERTAINTY": "#16a34a",
    "BELIEF_PSO_V3_FIXED_RANGE": "#f59e0b",
    "BELIEF_PSO_V3_NO_PSO": "#6b7280",
}

BASELINE_ORDER = [
    "FULL_SCAN",
    "ROUND_ROBIN_SECTOR",
    "ROUND_ROBIN_ROI",
    "NEAREST_ROI",
    "PID_ROI",
    "BELIEF_PSO_V3",
]

ABLATION_ORDER = [
    "BELIEF_PSO_V3",
    "BELIEF_PSO_V3_NO_COVERAGE",
    "BELIEF_PSO_V3_NO_UNCERTAINTY",
    "BELIEF_PSO_V3_FIXED_RANGE",
    "BELIEF_PSO_V3_NO_PSO",
]

FAILURE_ORDER = ["none", "single_transient", "segment_transient"]
FAILURE_LABELS = {
    "none": "Control",
    "single_transient": "Single-Sonar Outage",
    "segment_transient": "Segment Outage",
}

FOCUS_METRICS = [
    {
        "id": "strict_tracking_accuracy",
        "source": ("aggregateMetrics", "strictTrackAccuracy"),
        "label": "Strict Tracking Accuracy (%)",
        "report_name": "Strict Tracking Accuracy",
        "scale": 100.0,
        "accuracy": True,
    },
    {
        "id": "tracking_accuracy",
        "source": ("aggregateMetrics", "localTrackAccuracy"),
        "label": "Tracking Accuracy (%)",
        "report_name": "Tracking Accuracy",
        "scale": 100.0,
        "accuracy": True,
    },
    {
        "id": "scan_interval",
        "source": ("aggregateMetrics", "avgAoISec"),
        "label": "Mean Per-Swimmer Scan Interval (s)",
        "report_name": "Mean Per-Swimmer Scan Interval (s)",
        "scale": 1.0,
        "accuracy": False,
    },
    {
        "id": "scanned_rate",
        "source": ("aggregateMetrics", "avgScanRateHz"),
        "label": "Avg Swimmer Scanned Rate (Hz)",
        "report_name": "Avg Swimmer Scanned Rate",
        "scale": 1.0,
        "accuracy": False,
    },
]

LATENCY_METRIC = {
    "id": "latency_p95",
    "source": ("commandMetrics", "decisionLatencyP95Ms"),
    "label": "Decision Latency P95 (ms)",
    "scale": 1.0,
    "accuracy": False,
}


def setup_matplotlib():
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 17,
            "axes.titlesize": 19,
            "axes.labelsize": 18,
            "xtick.labelsize": 15,
            "ytick.labelsize": 15,
            "legend.fontsize": 13,
            "figure.titlesize": 22,
            "axes.linewidth": 1.1,
        }
    )


def load_json(path):
    return json.loads(path.read_text())


def load_runs(output_dir):
    output_dir = Path(output_dir)
    runs_path = output_dir / "runs.jsonl"
    if not runs_path.exists():
        raise FileNotFoundError(f"Missing runs.jsonl: {runs_path}")
    rows = []
    with runs_path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    manifest_path = output_dir / "manifest.json"
    manifest = load_json(manifest_path) if manifest_path.exists() else {}
    return rows, manifest


def metric_value(row, metric):
    section, key = metric["source"]
    value = row.get(section, {}).get(key)
    if value is None:
        return float("nan")
    return float(value) * metric["scale"]


def mean_ci(values):
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if not clean:
        return {"mean": float("nan"), "ci95": float("nan"), "std": float("nan"), "n": 0}
    mean = sum(clean) / len(clean)
    if len(clean) == 1:
        return {"mean": mean, "ci95": 0.0, "std": 0.0, "n": 1}
    variance = sum((value - mean) ** 2 for value in clean) / (len(clean) - 1)
    std = math.sqrt(variance)
    return {"mean": mean, "ci95": 1.96 * std / math.sqrt(len(clean)), "std": std, "n": len(clean)}


def present(value, digits=2):
    if value is None or not math.isfinite(float(value)):
        return "n/a"
    return f"{float(value):.{digits}f}"


def strategy_label(strategy):
    return STRATEGY_LABELS.get(strategy, strategy.replace("_", " ").title())


def ordered_present(values, preferred):
    present_values = set(values)
    ordered = [value for value in preferred if value in present_values]
    ordered.extend(sorted(present_values.difference(ordered)))
    return ordered


def grouped_values(rows, key_fields, metric):
    groups = defaultdict(list)
    for row in rows:
        key = tuple(row.get(field, "") for field in key_fields)
        groups[key].append(metric_value(row, metric))
    return {key: mean_ci(values) for key, values in groups.items()}


def y_limit(metric, stats):
    if metric.get("accuracy"):
        upper_values = [
            stat["mean"] + (0 if not math.isfinite(stat["ci95"]) else stat["ci95"])
            for stat in stats
            if math.isfinite(stat["mean"])
        ]
        upper = max(upper_values + [1.0])
        padded = min(100.0, max(10.0, upper * 1.18))
        tick_rounded = min(100.0, max(10.0, math.ceil(padded / 5.0) * 5.0))
        return 0, tick_rounded
    upper_values = [
        stat["mean"] + (0 if not math.isfinite(stat["ci95"]) else stat["ci95"])
        for stat in stats
        if math.isfinite(stat["mean"])
    ]
    upper = max(upper_values + [1.0])
    return 0, upper * 1.18


def style_axis(axis):
    axis.grid(axis="y", linestyle="--", linewidth=0.9, alpha=0.35)
    axis.set_axisbelow(True)
    axis.spines["top"].set_visible(False)
    axis.spines["right"].set_visible(False)


def error_values(stats):
    return [0.0 if not math.isfinite(stat["ci95"]) else stat["ci95"] for stat in stats]


def bar_color(strategy):
    return STRATEGY_COLORS.get(strategy, "#64748b")


def save_figure(fig, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=220, bbox_inches="tight")
    plt.close(fig)
    return output_path


def plot_e2e_metric(rows, charts_dir, metric, strategies, counts):
    stats = grouped_values(rows, ["swimmerCount", "strategy"], metric)
    x = np.arange(len(counts), dtype=float)
    width = min(0.12, 0.78 / max(1, len(strategies)))
    offsets = (np.arange(len(strategies)) - (len(strategies) - 1) / 2.0) * width

    fig, axis = plt.subplots(figsize=(15.5, 7.4))
    handles = []
    labels = []
    all_stats = []
    for index, strategy in enumerate(strategies):
        series = [stats.get((count, strategy), mean_ci([])) for count in counts]
        means = [stat["mean"] for stat in series]
        all_stats.extend(series)
        bars = axis.bar(
            x + offsets[index],
            means,
            width,
            yerr=error_values(series),
            capsize=4,
            color=bar_color(strategy),
            edgecolor="#111827",
            linewidth=0.55,
            error_kw={"elinewidth": 1.5, "capthick": 1.5},
            label=strategy_label(strategy),
        )
        handles.append(bars[0])
        labels.append(strategy_label(strategy))

    axis.set_title(f"E2E Random-Reflect Benchmark: {metric['label']}")
    axis.set_xlabel("Swimmer Count")
    axis.set_ylabel(metric["label"])
    axis.set_xticks(x)
    axis.set_xticklabels([str(count) for count in counts])
    axis.set_ylim(*y_limit(metric, all_stats))
    style_axis(axis)
    fig.legend(handles, labels, loc="lower center", ncol=3, frameon=False, bbox_to_anchor=(0.5, -0.02))
    fig.tight_layout(rect=(0, 0.12, 1, 1))
    return save_figure(fig, charts_dir / f"e2e_{metric['id']}.png")


def plot_latency(rows, charts_dir, counts):
    v3_rows = [row for row in rows if row.get("strategy") == "BELIEF_PSO_V3"]
    stats = grouped_values(v3_rows, ["swimmerCount"], LATENCY_METRIC)
    series = [stats.get((count,), mean_ci([])) for count in counts]
    x = np.arange(len(counts), dtype=float)

    fig, axis = plt.subplots(figsize=(10.5, 6.8))
    axis.bar(
        x,
        [stat["mean"] for stat in series],
        0.55,
        yerr=error_values(series),
        capsize=5,
        color=bar_color("BELIEF_PSO_V3"),
        edgecolor="#111827",
        linewidth=0.7,
        error_kw={"elinewidth": 1.6, "capthick": 1.6},
    )
    axis.set_title("Belief-PSO V3 Decision Latency")
    axis.set_xlabel("Swimmer Count")
    axis.set_ylabel(LATENCY_METRIC["label"])
    axis.set_xticks(x)
    axis.set_xticklabels([str(count) for count in counts])
    axis.set_ylim(*y_limit(LATENCY_METRIC, series))
    style_axis(axis)
    fig.tight_layout()
    return save_figure(fig, charts_dir / "e2e_latency_p95_v3.png")


def plot_ablation_metric(rows, charts_dir, metric, strategies, count):
    subset = [row for row in rows if row.get("swimmerCount") == count]
    stats = grouped_values(subset, ["strategy"], metric)
    series = [stats.get((strategy,), mean_ci([])) for strategy in strategies]
    x = np.arange(len(strategies), dtype=float)

    fig, axis = plt.subplots(figsize=(11.5, 7.0))
    axis.bar(
        x,
        [stat["mean"] for stat in series],
        0.62,
        yerr=error_values(series),
        capsize=5,
        color=[bar_color(strategy) for strategy in strategies],
        edgecolor="#111827",
        linewidth=0.65,
        error_kw={"elinewidth": 1.6, "capthick": 1.6},
    )
    axis.set_title(f"Cost Ablation at {count} Swimmers: {metric['label']}")
    axis.set_ylabel(metric["label"])
    axis.set_xticks(x)
    axis.set_xticklabels([strategy_label(strategy) for strategy in strategies], rotation=18, ha="right")
    axis.set_ylim(*y_limit(metric, series))
    style_axis(axis)
    fig.tight_layout()
    return save_figure(fig, charts_dir / f"ablation_{count}_{metric['id']}.png")


def normalized_failure_mode(row):
    mode = row.get("sonarFailureMode")
    if mode:
        return mode
    scenario = row.get("scenario", "")
    if scenario.endswith("single_sonar_outage"):
        return "single_transient"
    if scenario.endswith("segment_outage"):
        return "segment_transient"
    return "none"


def plot_robustness_metric(rows, charts_dir, metric, strategies, count):
    subset = [dict(row, sonarFailureMode=normalized_failure_mode(row)) for row in rows if row.get("swimmerCount") == count]
    stats = grouped_values(subset, ["sonarFailureMode", "strategy"], metric)
    x = np.arange(len(FAILURE_ORDER), dtype=float)
    width = min(0.12, 0.78 / max(1, len(strategies)))
    offsets = (np.arange(len(strategies)) - (len(strategies) - 1) / 2.0) * width

    fig, axis = plt.subplots(figsize=(14.8, 7.3))
    handles = []
    labels = []
    all_stats = []
    for index, strategy in enumerate(strategies):
        series = [stats.get((mode, strategy), mean_ci([])) for mode in FAILURE_ORDER]
        all_stats.extend(series)
        bars = axis.bar(
            x + offsets[index],
            [stat["mean"] for stat in series],
            width,
            yerr=error_values(series),
            capsize=4,
            color=bar_color(strategy),
            edgecolor="#111827",
            linewidth=0.55,
            error_kw={"elinewidth": 1.5, "capthick": 1.5},
            label=strategy_label(strategy),
        )
        handles.append(bars[0])
        labels.append(strategy_label(strategy))

    axis.set_title(f"Sonar Robustness at {count} Swimmers: {metric['label']}")
    axis.set_ylabel(metric["label"])
    axis.set_xticks(x)
    axis.set_xticklabels([FAILURE_LABELS[mode] for mode in FAILURE_ORDER])
    axis.set_ylim(*y_limit(metric, all_stats))
    style_axis(axis)
    fig.legend(handles, labels, loc="lower center", ncol=3, frameon=False, bbox_to_anchor=(0.5, -0.02))
    fig.tight_layout(rect=(0, 0.14, 1, 1))
    return save_figure(fig, charts_dir / f"robustness_{count}_{metric['id']}.png")


def write_summary_csv(path, rows, group_fields, metrics):
    grouped = defaultdict(list)
    for row in rows:
        enriched = dict(row)
        if "sonarFailureMode" in group_fields:
            enriched["sonarFailureMode"] = normalized_failure_mode(row)
        key = tuple(enriched.get(field, "") for field in group_fields)
        grouped[key].append(enriched)

    fieldnames = list(group_fields) + ["n"]
    for metric in metrics:
        fieldnames.extend([f"{metric['id']}_mean", f"{metric['id']}_ci95", f"{metric['id']}_std"])

    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for key in sorted(grouped.keys()):
            group_rows = grouped[key]
            output = {field: value for field, value in zip(group_fields, key)}
            output["n"] = len(group_rows)
            for metric in metrics:
                stat = mean_ci(metric_value(row, metric) for row in group_rows)
                output[f"{metric['id']}_mean"] = present(stat["mean"], 6)
                output[f"{metric['id']}_ci95"] = present(stat["ci95"], 6)
                output[f"{metric['id']}_std"] = present(stat["std"], 6)
            writer.writerow(output)


def group_stat(rows, filters, metric):
    values = []
    for row in rows:
        ok = True
        for field, expected in filters.items():
            value = normalized_failure_mode(row) if field == "sonarFailureMode" else row.get(field)
            if value != expected:
                ok = False
                break
        if ok:
            values.append(metric_value(row, metric))
    return mean_ci(values)


def make_report(out_dir, chart_paths, csv_paths, rows_by_kind, manifests, source_dirs):
    e2e_rows = rows_by_kind["e2e"]
    ablation_rows = rows_by_kind["ablation"]
    robustness_rows = rows_by_kind["robustness"]
    counts = sorted({row.get("swimmerCount") for row in e2e_rows if row.get("swimmerCount") is not None})

    lines = []
    lines.append("# BELIEF_PSO_V3 端到端、消融与声呐失效鲁棒性实验报告")
    lines.append("")
    lines.append(f"生成时间：{datetime.now(timezone.utc).isoformat()}")
    lines.append("")
    lines.append("## 版本与数据来源")
    lines.append("")
    lines.append("- 主方法：`BELIEF_PSO_V3`。V2 仍保留为 `BELIEF_PSO_V2`/`strategies.proposed_v2:plan`，但本报告的 proposed 结果使用 V3。")
    lines.append("- V3 识别方式：优先查看 benchmark `manifest.json` 中的 `strategyImplementations.BELIEF_PSO_V3`；当前配置和 UI 默认候选策略均指向 `BELIEF_PSO_V3`。")
    lines.append("- 原始 run summary、sample 和 manifest 仍保留在以下输出目录，报告目录中的 `report_bundle_manifest.json` 记录了这些路径。")
    for key, path in source_dirs.items():
        lines.append(f"- {key}: `{path}`")
    lines.append("")
    lines.append("## 实验设置")
    lines.append("")
    lines.append("- 端到端测试：`random_reflect`，6 个 sonar，swimmer counts = 2/4/6/10/20，210 runs。")
    lines.append("- Cost function 消融：`random_reflect`，6 个 sonar，swimmer counts = 10/20，100 runs。")
    lines.append("- Sonar 失效鲁棒性：`random_reflect`，6 个 sonar，swimmer counts = 10/20，control/single-sonar outage/segment outage，108 runs。")
    lines.append("- Error bar：跨 seed 的 95% confidence interval。")
    lines.append("")
    lines.append("## Baseline 简述")
    lines.append("")
    lines.append("- `FULL_SCAN`：每次覆盖完整声呐视场，作为高覆盖但低调度选择性的参考。")
    lines.append("- `ROUND_ROBIN_SECTOR`：在声呐/扇区之间轮询搜索，强调均匀覆盖。")
    lines.append("- `ROUND_ROBIN_ROI`：在已有 track 的 ROI 之间轮询，强调已知目标的持续复访。")
    lines.append("- `NEAREST_ROI`：将目标交给几何上更近的 sonar 扫描，代表局部贪婪关联。")
    lines.append("- `PID_ROI`：只使用 Kalman tracks 的 PID-guided ROI controller，作为在线控制器 baseline。")
    lines.append("- `BELIEF_PSO_V3`：使用 belief-state cost function 和 PSO 搜索联合选择 sonar-target 扫描计划，是本报告主方法。")
    lines.append("")
    lines.append("## 指标命名")
    lines.append("")
    lines.append("- Strict Tracking Accuracy：由 `strictTrackAccuracy` 计算，图中以百分比展示。")
    lines.append("- Tracking Accuracy：由 `localTrackAccuracy` 计算，图中以百分比展示。")
    lines.append("- Mean Per-Swimmer Scan Interval (s)：由 `avgAoISec` 计算，表示每个 swimmer 平均多久被扫描一次。")
    lines.append("- Avg Swimmer Scanned Rate：由 `avgScanRateHz` 计算，图中以 Hz 展示。")
    lines.append("- Decision Latency P95 (ms)：只报告 V3 随 swimmer 数量变化，不和 baseline 做优劣对比。")
    lines.append("")

    lines.append("## 端到端结果")
    lines.append("")
    for metric in FOCUS_METRICS:
        lines.append(f"![E2E {metric['label']}](charts/{chart_paths[f'e2e_{metric['id']}'].name})")
        lines.append("")
    lines.append(f"![V3 latency](charts/{chart_paths['e2e_latency_p95_v3'].name})")
    lines.append("")

    if counts:
        strict_metric = next(metric for metric in FOCUS_METRICS if metric["id"] == "strict_tracking_accuracy")
        tracking_metric = next(metric for metric in FOCUS_METRICS if metric["id"] == "tracking_accuracy")
        interval_metric = next(metric for metric in FOCUS_METRICS if metric["id"] == "scan_interval")
        rate_metric = next(metric for metric in FOCUS_METRICS if metric["id"] == "scanned_rate")
        v3_strict_accuracy = group_stat(e2e_rows, {"strategy": "BELIEF_PSO_V3"}, strict_metric)
        v3_tracking_accuracy = group_stat(e2e_rows, {"strategy": "BELIEF_PSO_V3"}, tracking_metric)
        v3_interval = group_stat(e2e_rows, {"strategy": "BELIEF_PSO_V3"}, interval_metric)
        v3_rate = group_stat(e2e_rows, {"strategy": "BELIEF_PSO_V3"}, rate_metric)
        lines.append(
            f"V3 在全部 E2E 随机场景上的均值：Strict Tracking Accuracy = {present(v3_strict_accuracy['mean'])}%，"
            f"Tracking Accuracy = {present(v3_tracking_accuracy['mean'])}%，"
            f"Mean Per-Swimmer Scan Interval = {present(v3_interval['mean'])} s，"
            f"Avg Swimmer Scanned Rate = {present(v3_rate['mean'])} Hz。"
        )
        lines.append("")

    lines.append("## Cost Function 消融")
    lines.append("")
    lines.append("消融组保持同一 strategy 框架，只移除或替换 cost function 中的关键项：coverage、uncertainty、range adaptation，以及将 PSO 搜索替换为 greedy/no-PSO 选择。")
    lines.append("")
    for count in sorted({row.get("swimmerCount") for row in ablation_rows if row.get("swimmerCount") is not None}):
        lines.append(f"### {count} swimmers")
        lines.append("")
        for metric in FOCUS_METRICS:
            lines.append(f"![Ablation {count} {metric['label']}](charts/{chart_paths[f'ablation_{count}_{metric['id']}'].name})")
            lines.append("")

    lines.append("## Sonar 失效鲁棒性")
    lines.append("")
    lines.append("鲁棒性测试在随机泳者场景中加入一次 transient outage：single-sonar outage 关闭 1 个 sonar，segment outage 关闭相邻 2 个 sonar；control 不关闭 sonar。")
    lines.append("")
    for count in sorted({row.get("swimmerCount") for row in robustness_rows if row.get("swimmerCount") is not None}):
        lines.append(f"### {count} swimmers")
        lines.append("")
        for metric in FOCUS_METRICS:
            lines.append(f"![Robustness {count} {metric['label']}](charts/{chart_paths[f'robustness_{count}_{metric['id']}'].name})")
            lines.append("")

    lines.append("## 可复现文件")
    lines.append("")
    for name, path in csv_paths.items():
        lines.append(f"- `{name}`: `{path.relative_to(out_dir)}`")
    lines.append("- `report_bundle_manifest.json`: 汇总输入输出路径、配置摘要和图表清单。")
    lines.append("")

    report_path = out_dir / "proposed_v3_evaluation_report.md"
    report_path.write_text("\n".join(lines))
    return report_path


def copy_config_from_manifest(manifest, destination):
    config_path = manifest.get("config", {}).get("configPath") or manifest.get("configPath")
    if not config_path:
        return None
    source = Path(config_path)
    if not source.exists():
        return None
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / source.name
    shutil.copy2(source, target)
    return target


def main():
    parser = argparse.ArgumentParser(description="Generate the unified BELIEF_PSO_V3 evaluation report.")
    parser.add_argument("--e2e", required=True, help="E2E benchmark output directory")
    parser.add_argument("--ablation", required=True, help="Cost ablation benchmark output directory")
    parser.add_argument("--robustness", required=True, help="Sonar robustness benchmark output directory")
    parser.add_argument("--out", required=True, help="Report output directory")
    args = parser.parse_args()

    setup_matplotlib()
    out_dir = Path(args.out).resolve()
    charts_dir = out_dir / "charts"
    tables_dir = out_dir / "tables"
    configs_dir = out_dir / "configs"
    out_dir.mkdir(parents=True, exist_ok=True)
    charts_dir.mkdir(parents=True, exist_ok=True)
    tables_dir.mkdir(parents=True, exist_ok=True)
    configs_dir.mkdir(parents=True, exist_ok=True)

    e2e_rows, e2e_manifest = load_runs(args.e2e)
    ablation_rows, ablation_manifest = load_runs(args.ablation)
    robustness_rows, robustness_manifest = load_runs(args.robustness)

    e2e_counts = sorted({row.get("swimmerCount") for row in e2e_rows if row.get("swimmerCount") is not None})
    e2e_strategies = ordered_present((row.get("strategy") for row in e2e_rows), BASELINE_ORDER)
    ablation_counts = sorted({row.get("swimmerCount") for row in ablation_rows if row.get("swimmerCount") is not None})
    ablation_strategies = ordered_present((row.get("strategy") for row in ablation_rows), ABLATION_ORDER)
    robustness_counts = sorted({row.get("swimmerCount") for row in robustness_rows if row.get("swimmerCount") is not None})
    robustness_strategies = ordered_present((row.get("strategy") for row in robustness_rows), BASELINE_ORDER)

    chart_paths = {}
    for metric in FOCUS_METRICS:
        chart_paths[f"e2e_{metric['id']}"] = plot_e2e_metric(e2e_rows, charts_dir, metric, e2e_strategies, e2e_counts)
    chart_paths["e2e_latency_p95_v3"] = plot_latency(e2e_rows, charts_dir, e2e_counts)

    for count in ablation_counts:
        for metric in FOCUS_METRICS:
            chart_paths[f"ablation_{count}_{metric['id']}"] = plot_ablation_metric(
                ablation_rows,
                charts_dir,
                metric,
                ablation_strategies,
                count,
            )

    for count in robustness_counts:
        for metric in FOCUS_METRICS:
            chart_paths[f"robustness_{count}_{metric['id']}"] = plot_robustness_metric(
                robustness_rows,
                charts_dir,
                metric,
                robustness_strategies,
                count,
            )

    csv_paths = {
        "e2e_summary.csv": tables_dir / "e2e_summary.csv",
        "cost_ablation_summary.csv": tables_dir / "cost_ablation_summary.csv",
        "sonar_robustness_summary.csv": tables_dir / "sonar_robustness_summary.csv",
    }
    write_summary_csv(csv_paths["e2e_summary.csv"], e2e_rows, ["swimmerCount", "strategy"], FOCUS_METRICS + [LATENCY_METRIC])
    write_summary_csv(csv_paths["cost_ablation_summary.csv"], ablation_rows, ["swimmerCount", "strategy"], FOCUS_METRICS)
    write_summary_csv(
        csv_paths["sonar_robustness_summary.csv"],
        robustness_rows,
        ["swimmerCount", "sonarFailureMode", "strategy"],
        FOCUS_METRICS,
    )

    copied_configs = [
        copy_config_from_manifest(e2e_manifest, configs_dir),
        copy_config_from_manifest(ablation_manifest, configs_dir),
        copy_config_from_manifest(robustness_manifest, configs_dir),
    ]
    copied_configs = [str(path) for path in copied_configs if path is not None]

    source_dirs = {
        "e2e": str(Path(args.e2e).resolve()),
        "ablation": str(Path(args.ablation).resolve()),
        "robustness": str(Path(args.robustness).resolve()),
    }
    report_path = make_report(
        out_dir,
        chart_paths,
        csv_paths,
        {"e2e": e2e_rows, "ablation": ablation_rows, "robustness": robustness_rows},
        {"e2e": e2e_manifest, "ablation": ablation_manifest, "robustness": robustness_manifest},
        source_dirs,
    )

    bundle_manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "reportPath": str(report_path),
        "sourceDirs": source_dirs,
        "sourceFiles": {
            key: {
                "runs": str(Path(path).resolve() / "runs.jsonl"),
                "samples": str(Path(path).resolve() / "samples.jsonl"),
                "manifest": str(Path(path).resolve() / "manifest.json"),
            }
            for key, path in source_dirs.items()
        },
        "copiedConfigs": copied_configs,
        "charts": {key: str(path) for key, path in chart_paths.items()},
        "tables": {key: str(path) for key, path in csv_paths.items()},
        "runCounts": {
            "e2e": len(e2e_rows),
            "ablation": len(ablation_rows),
            "robustness": len(robustness_rows),
        },
        "strategyImplementations": {
            "e2e": e2e_manifest.get("strategyImplementations", {}),
            "ablation": ablation_manifest.get("strategyImplementations", {}),
            "robustness": robustness_manifest.get("strategyImplementations", {}),
        },
    }
    (out_dir / "report_bundle_manifest.json").write_text(json.dumps(bundle_manifest, indent=2))
    print(json.dumps({"reportPath": str(report_path), "outDir": str(out_dir), "charts": len(chart_paths)}, indent=2))


if __name__ == "__main__":
    main()
