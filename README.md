## 本仓库做什么

这个项目用 TypeScript/React 仿真物理、成像、检测、跟踪和指标，用 Python 实现可替换的扫描策略，比较两种多声呐扫描策略的效果差异：

- `FULL_SCAN`：每个声呐固定最大量程，在 local `0°↔180°` 连续往返扫
- `BELIEF_PSO_V3`：当前 proposed method；通过离散 PSO 联合优化 confirmed Kalman beliefs 的 sonar assignment、协方差感知 ROI、range 和 coverage-search budget；planner 不读取真值。V3 保持 V2 框架，使用 latency-tuned `32x30` PSO budget
- `BELIEF_PSO_V2`：冻结的 previous proposed method，用于版本对照和回归比较
- `TRUTH_LOOKAHEAD_ORACLE`：仅用于 headless benchmark 的不可部署参考，truth 通过隔离 provider 注入，永远不会进入在线策略 snapshot 或 Python 服务

核心目标是让评测链路更贴近真实的 **scanning imaging sonar（Ping360）**：声呐输出是 2D 灰度强度图（像素为回波强度），而不是“每 ping 直接吐候选点”。本仓库将检测从 **按 ping** 改为 **按 frame**（一轮扫完再检测），并补齐 AquaScan 论文体系的指标与 UI。

策略与模拟器通过 JSON/HTTP 解耦。接口和新增 baseline 的方法见 [STRATEGY_INTEGRATION.md](./STRATEGY_INTEGRATION.md)。

## 与 AquaScan / Ping360 对齐说明（MobiCom'25）

- **Ping360 关键参数（按论文口径）**
  - 频率：750 kHz
  - 最大功耗：5 W
  - 波束宽度（grads）：水平 2.22 grads（≈2°），垂直 27.78 grads（≈25°）
  - 扫描方式：单波束电机旋转，逐 bearing 输出 range profile，累积成 2D 强度图（angle×range）

- **扫描时长/帧率校准（command-level timing model）**
  - timing regression 对齐公开规格：约 3.4s / 1m / 360°，约 32s / 50m / 360°
  - 独立物理回归实验：`npm run test:sonar-physics` 只检查 `SonarTimingModel`，不经过策略层
  - `BELIEF_PSO_V3` 通过量程和角度窗口自适应缩短 ROI command；实际数值必须以 `synthetic-uncalibrated` benchmark 输出为准
  - 扫描步进耗时、receive guard 与无发射 reposition 使用不同参数

- **physical-aware 双分支去噪 + DBSCAN（结构对齐 paper Fig.8 / §4.3，简化实现）**
  1) `Weak-echo elimination`：对 background-subtracted 强度做全局 percentile 阈值（并设下限）
  2) Range-direction denoise：用 `kernelCap` 控制的二值 range filter 近似 median kernel，压制动态噪声/散斑
  3) 自适应阈值：结合 fixed threshold、weak echo percentile 和 frame-local 噪声统计
  4) 物理约束：用 cross-range、range extent 和 aspect ratio 筛除细长噪声条
  5) 聚类：DBSCAN（自行实现，禁止新增依赖），输出 `bbox + amplitude-weighted centroid`
  6) Kernel cap：最大 kernel cap=13（论文指出 >13 miss 会激增），当前作为 tunable denoise 上限参与检测

## 更贴近真实的评测链路（按帧：成像 → 背景扣除 → 检测 → 聚类 → 候选 → 匹配/跟踪）

每个 sonar 在一轮扫描（一个 `frame`）内累积一个极坐标强度图：

- command-local dense angle bins × range bins（机械范围为 local 0°..180°）
- 强度包含：
  - **静态结构**：池壁/泳道线（几何射线与墙体/泳道线交点距离 → 稳定强回波带）
  - **动态噪声**：heavy-tail speckle + weak band / ghost（可与人体簇重叠）
  - **目标回波**：随距离衰减的 blob

只有当 `frame` 扫描完成时，才运行一次：

1) background subtraction（当前为 frame-local range-bin background profile，后续阶段 4 再用真实数据校准长期背景）
2) AquaScan-like physical-aware 检测（weak echo elimination + adaptive threshold + range denoise + DBSCAN）
3) 输出候选 `cluster`：`bbox + centroid(x,y)`
4) 同一 fusion tick 的多声呐 detections 先去重，再进行一次 Mahalanobis-gated Kalman 更新

## 评测侧匹配与更新规则

在同一 `timeBucket`（时间桶）内（保持现有去重逻辑）：

- evaluator 使用真值做独立的一对一匹配；tracker 不读取真值，使用 covariance-aware Mahalanobis gating
- 每个候选点最多匹配一个 swimmer；每个 swimmer 也最多匹配一个候选点
- 只有匹配成功的候选点，才会：
  - 刷新该 swimmer 的 `lastSeen / updateTimes`（用于 AoI / 扫描频率 / 回访间隔等）
  - 作为 Kalman 跟踪的测量更新
- 未匹配的候选点计为误检（false alarm）
- swimmer 在视场内但未匹配成功，计为漏检机会（miss opportunity）

## Experiment Metrics（默认滑动窗口 10s，可切换 30s）

后续实验的主评价指标先统一为四项：

- `strictTrackAccuracy`：tracking accuracy；按 swimmer 被扫到的 scan opportunity 统计，ID 正确次数 / scan opportunity 次数。
- `avgAoISec`：Average AoI；当前 active swimmers 的平均扫描间隔，按窗口内 per-swimmer matched detection rate 的倒数计算。
- `avgScanRateHz`：每个 swimmer 平均每秒 matched detection update 次数。
- `decisionLatencyP95Ms`：策略规划调用的 wall-clock latency 第 95 百分位，记录在 benchmark `commandMetrics` 中。

其他 paper-aligned metrics（如 precision/recall/F1、MDR、meanIoU、falseAlarmsPerSec、trackingRMSEm、GOSPA、trackContinuity、p90 AoI 等）仍由 evaluator 和 run summary 保留，后续需要时可重新启用，但当前 summary/report/paper artifact 默认不再用它们做主评价。

## 可调参数（UI sliders + `constants.ts` 默认值）

你可以在 Dashboard 的 sliders 或 `constants.ts` 调参来观察趋势（随机性由 seed 固定可复现）：

- 噪声相关：`IMAGING_NOISE_STD`（以及 UI 的 `Noise Strength`）、`Speckle Prob`、`IMAGING_SPECKLE_STRENGTH`
- 阈值/聚类：`Threshold`、`DBSCAN eps/minPts`、`Median Kernel Cap (<=13)`
- 网格大小：`IMAGING_FRAME_ANGLE_BINS`、`IMAGING_RANGE_BINS`、`IMAGING_FOV_DEG`
- 匹配门限：`MATCH_GATE_RADIUS_M`、`AQUASCAN_IOU_MATCH_THRESHOLD`

验收现象（应当能观察到）：

- 调高噪声 / 调低阈值：误检上升、定位误差变大
- 调高阈值：漏检上升、首次发现时间变长
- FULL_SCAN vs BELIEF_PSO_V3：除 command throughput 外，还能观察首次发现时间、GOSPA、coverage debt 和量程自适应的差异

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

**Prerequisites:** Node.js、Python 3.10+

1. Install dependencies: `npm install`
2. Terminal A 启动 Python 策略服务：`npm run strategy-server`
3. Terminal B 启动前端模拟器：`npm run dev`

默认比较 `FULL_SCAN` 与 `BELIEF_PSO_V3`。可通过环境变量选择已注册且名称明确的 Python 策略；需要复现实验旧版时显式指定 `BELIEF_PSO_V2`：

```bash
VITE_BASELINE_STRATEGY=FULL_SCAN VITE_CANDIDATE_STRATEGY=BELIEF_PSO_V3 npm run dev
VITE_BASELINE_STRATEGY=FULL_SCAN VITE_CANDIDATE_STRATEGY=BELIEF_PSO_V2 npm run dev
```

策略服务不可用时，新 command 调度暂停，页面顶部会显示 offline；不会把失败 run 静默伪装成另一种策略。

## 如何确认评估实验使用的是哪一版策略

新实验默认主方法是 `BELIEF_PSO_V3`；`BELIEF_PSO_V2` 只作为冻结对照保留。

- UI 默认：`FULL_SCAN` vs `BELIEF_PSO_V3`。也可以通过 URL/query 或环境变量显式覆盖 `candidateStrategy` / `VITE_CANDIDATE_STRATEGY`。
- Headless config 默认：仓库内通用 benchmark config 已切到 `BELIEF_PSO_V3`。如果 config 的 `strategies` 写了 `BELIEF_PSO_V2`，就会明确跑旧版。
- 每次 headless run 的 `manifest.json` 会记录 `strategyImplementations`，其中 `implementation`、`codeVersion` 和 `parameters.iterations` 是版本证据。当前 V3 应显示 `strategies.proposed_v3:plan`、`swarmSize: 32`、`iterations: 30`；V2 应显示 `strategies.proposed_v2:plan`、`iterations: 40`。
- `runs.jsonl` 每行也包含 `strategy` 和 `strategyImplementation`；生成 summary/report 时脚本会优先把 `BELIEF_PSO_V3` 识别为 proposed method，只有旧输出不含 V3 时才回退到 V2。

论文就绪状态、实验矩阵和剩余限制见 [WORKSHOP_READINESS_REPORT.md](./WORKSHOP_READINESS_REPORT.md)。

常用论文实验命令：

```bash
npm run test:sonar-physics
npm run experiment:sonar-physics
npm run benchmark:synthetic -- configs/benchmark/synthetic/smoke.json
npm run benchmark:readiness -- --skip-gate
npm run benchmark:ablation -- --skip-gate
npm run benchmark:oracle -- --skip-gate
npm run benchmark:summary -- output/benchmarks/<run-directory>
npm run benchmark:paper -- output/benchmarks/<run-directory>
```
