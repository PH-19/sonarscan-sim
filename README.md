## 本仓库做什么

这个项目用一个轻量的 TypeScript/React 仿真，比较两种多声呐扫描策略的效果差异：

- `NAIVE`：每个声呐固定最大量程，全扇区往返扫
- `OPTIMIZED`：更贴近 AquaScan 的 **track-driven 规划**：以 Kalman 预测结果做 **量程 + 扫描角度自适应**（保持连续扫，暂不启用 intermittent scanning），避免直接用真值作为 planner 输入

核心目标是让评测链路更贴近真实的 **scanning imaging sonar（Ping360）**：声呐输出是 2D 灰度强度图（像素为回波强度），而不是“每 ping 直接吐候选点”。本仓库将检测从 **按 ping** 改为 **按 frame**（一轮扫完再检测），并补齐 AquaScan 论文体系的指标与 UI。

## 与 AquaScan / Ping360 对齐说明（MobiCom'25）

- **Ping360 关键参数（按论文口径）**
  - 频率：750 kHz
  - 最大功耗：5 W
  - 波束宽度（grads）：水平 2.22 grads（≈2°），垂直 27.78 grads（≈25°）
  - 扫描方式：单波束电机旋转，逐 bearing 输出 range profile，累积成 2D 强度图（angle×range）

- **扫描时长/帧率校准（按论文给的量级）**
  - `NAIVE` 近似 `1/1`：~6.18s / frame → FPS ≈ 0.162
  - `OPTIMIZED` 在该泳池尺度下（典型距离 ~27m）通过 **量程 + 角度窗口自适应** 达到 ~3.4s / frame 的量级 → FPS ≈ 0.296（窗口更窄会更快）
  - 在本仓库中主要由 `SCAN_STEP_ANGLE` 与 `PING360_PROCESSING_OVERHEAD_S` 拟合量级（当前未启用 intermittent scan/slew）

- **physical-aware 双分支去噪 + DBSCAN（结构对齐 paper Fig.8 / §4.3，简化实现）**
  1) `Weak-echo elimination`：对 background-subtracted 强度做全局 percentile 阈值（并设下限）
  2) Branch A（去噪）：较大 median kernel（这里用二值 majority filter 近似）压制动态噪声/散斑
  3) Branch B（检测）：较小 median kernel 保留人体簇形态
  4) 融合：要求 cluster 在去噪分支中保留一定比例（overlap），并通过物理约束筛除细长噪声条
  5) 聚类：DBSCAN（自行实现，禁止新增依赖），输出 `bbox + amplitude-weighted centroid`
  6) 自适应 kernel 搜索：从小核逐步增大，直到输出簇满足物理约束；最大 kernel cap=13（论文指出 >13 miss 会激增）

## 更贴近真实的评测链路（按帧：成像 → 背景扣除 → 检测 → 聚类 → 候选 → 匹配/跟踪）

每个 sonar 在一轮扫描（一个 `frame`）内累积一个极坐标强度图：

- angle bins × range bins（扇区为 90°，量程覆盖 `MAX_RANGE_NAIVE`）
- 强度包含：
  - **静态结构**：池壁/泳道线（几何射线与墙体/泳道线交点距离 → 稳定强回波带）
  - **动态噪声**：heavy-tail speckle + weak band / ghost（可与人体簇重叠）
  - **目标回波**：随距离衰减的 blob

只有当 `frame` 扫描完成时，才运行一次：

1) background subtraction（背景模型为每个 sonar 的 EMA；启动阶段有 warmup frames 作为 background scan）
2) AquaScan-like physical-aware 检测（双分支 median + DBSCAN）
3) 输出候选 `cluster`：`bbox + centroid(x,y)`
4) 匹配/更新跟踪（仅 match 成功才更新 `lastSeen/updateTimes` 与 Kalman）

## 评测侧匹配与更新规则

在同一 `timeBucket`（时间桶）内（保持现有去重逻辑）：

- 用“门限半径 + 一对一匹配（greedy by distance）”将候选点与真值 swimmer 做匹配
- 每个候选点最多匹配一个 swimmer；每个 swimmer 也最多匹配一个候选点
- 只有匹配成功的候选点，才会：
  - 刷新该 swimmer 的 `lastSeen / updateTimes`（用于 AoI / 扫描频率 / 回访间隔等）
  - 作为 Kalman 跟踪的测量更新
- 未匹配的候选点计为误检（false alarm）
- swimmer 在视场内但未匹配成功，计为漏检机会（miss opportunity）

## Paper-aligned Metrics（默认滑动窗口 10s，可切换 30s）

新增（基于滑动窗口、按 frame 统计）：

- `precision / recall / F1`：以 `cluster bbox` 与 `GT bbox` 的 IoU 匹配为 TP（默认阈值 0.1）统计
- `MDR`（miss detection rate）：`FN / GT`
- `meanIoU`：匹配到的 TP 对的平均 IoU
- `FPS`：每个 sonar 的帧率（滑窗内 frame 数 / 时间），再做平均
- `TR`（tracking rate）：滑窗内至少被成功 match 更新过一次的 swimmer 数 / 总 swimmer 数
- `falseAlarmsPerSec`：`FP / 秒`（按 frame 统计）

保留且仍基于“有效匹配更新”的旧指标（用于观察策略带来的 AoI/跟踪误差变化）：

- `avgAoISec / p90AoISec`
- `avgScanRateHz / avgRevisitIntervalSec`
- `trackingRMSEm / p90TrackingErrorM`
- `avgLocalizationErrorM` / `p90LocalizationErrorM`：匹配点到真值的距离误差（越低越好）
- `avgTimeToFirstDetectionSec` / `p90TimeToFirstDetectionSec`：从 `enteredAt` 到“首次匹配成功”的时间  
  - 实现说明：仅统计 **进入时间在评测窗口内** 的 swimmer；尚未首次命中的 swimmer 会按当前时间做截断（censored at now）

## 可调参数（UI sliders + `constants.ts` 默认值）

你可以在 Dashboard 的 sliders 或 `constants.ts` 调参来观察趋势（随机性由 seed 固定可复现）：

- 噪声相关：`IMAGING_NOISE_STD`（以及 UI 的 `Noise Strength`）、`Speckle Prob`、`IMAGING_SPECKLE_STRENGTH`
- 阈值/聚类：`Threshold`、`DBSCAN eps/minPts`、`Median Kernel Cap (<=13)`
- 网格大小：`IMAGING_FRAME_ANGLE_BINS`、`IMAGING_RANGE_BINS`、`IMAGING_FOV_DEG`
- 匹配门限：`MATCH_GATE_RADIUS_M`、`AQUASCAN_IOU_MATCH_THRESHOLD`

验收现象（应当能观察到）：

- 调高噪声 / 调低阈值：误检上升、定位误差变大
- 调高阈值：漏检上升、首次发现时间变长
- NAIVE vs OPTIMIZED：除“更勤/更快”外，还能体现“首次发现时间、误检代价、量程自适应带来的发声等待差异”等

## 控制面板参数说明（Dashboard）

- **Strategy Toggle**
  - `Naive (Full Scan)`：固定全扇区 + 最大量程扫描
  - `PSO/Optimized (Track-driven)`：使用 Kalman 预测结果做量程/角度窗口自适应（连续扫）
- **Metrics Window（10s / 30s）**：滑动窗口长度，影响所有指标的统计周期
- **Display → Matched only**：仅显示“匹配成功”的候选点（用于减少画面杂点）
- **AquaScan-aligned Tuning**
  - `Noise Strength`：噪声/杂波强度缩放（越大误报越多）
  - `Speckle Prob`：冲击散斑概率（越大误报越多）
  - `Threshold`：去噪后阈值（越大误报越少但漏检变多）
  - `DBSCAN eps`：聚类半径（越大越容易合并成大簇）
  - `minPts`：最小聚类点数（越大越“严格”）
  - `Median Kernel Cap`：最大去噪核（越大越去噪但更容易 miss）

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies: `npm install`
2. Run the app: `npm run dev`
