# Legacy PSO_V1 设计记录（非当前 proposed method）

> 重要：本文以下内容是早期设计记录，与当前 `strategies/pso.py` 不一致，不能用于论文方法描述。当前 proposed method 是 `BELIEF_PSO_V3`，主实现位于 `strategies/proposed_v3.py`，`strategies/proposed.py` 仅作为当前 proposed 的兼容入口；`BELIEF_PSO_V2` 冻结在 `strategies/proposed_v2.py` 用于版本对照。`PSO_V1` 当前只是历史 heuristic，正式 benchmark 不将其称为 proposed method。

> 当前实现位于 `strategies/pso.py`。TypeScript 模拟器通过 `POST /plan` 获取策略结果，协议见 `STRATEGY_INTEGRATION.md`。

## 1. 概述 (Overview)

本 PSO 策略旨在多声纳监控系统中，解决 **任务分配 (Task Allocation)** 问题。
目标是将场景中的所有已知目标（游泳者）最优地分配给 4 个角落的声纳，使得系统的整体刷新率（Frame Rate）最大化，即 **最小化所有声纳中耗时最长的那个声纳的扫描周期 (Min-Max Cycle Duration)**。这是一种典型的负载均衡优化。

---

## 2. 输入输出 (Input & Output)

### 输入 (Inputs)
PSO 模块在每一帧（或定时触发）接收以下数据：
1.  **声纳状态 (Sonars)**:
    -   数量: 固定 4 个。
    -   位置: 矩形泳池的四个角落。
    -   配置: 每个声纳覆盖 90° 的扇区（例如 S1 覆盖 0°-90°）。
2.  **目标列表 (Targets)**:
    -   **来源**: **卡尔曼滤波跟踪器 (Kalman Filter Tracks)** 的预测位置。
        -   *注意: 策略不使用“上帝视角”的真实位置 (Ground Truth)，而是使用根据历史观测推算出的估计位置，符合真实工程场景。*
    -   **数据**: 每个目标的 ID 和 二维坐标 $(x, y)$。

### 输出 (Outputs)
1.  **分配方案 (Assignments)**:
    -   格式: `Map<SonarID, TargetID[]>`
    -   描述: 每个声纳被指派需要负责的一个或多个目标列表。
    -   用途: 指导声纳的扫描规划（决定扫描范围 `minAngle`, `maxAngle` 和距离量程 `scanRange`）。

---

## 3. 算法核心设计 (Algorithm Details)

### 3.1 粒子状态表示 (State Representation)
为了将离散的分配问题映射到 PSO 的连续空间，采用了以下编码方式：
-   **粒子 (Particle)**: 一个粒子代表一种完整的全局分配方案。
-   **位置向量 (Position Vector)**: 长度等于目标数量 $N$ 的数组 `pos[N]`。
    -   `pos[j]` 的值是一个浮点数，代表第 $j$ 个目标分配给哪个声纳。
    -   解码时: `SonarIndex = round(pos[j])` (取值范围 0 ~ 3)。
-   **速度向量 (Velocity Vector)**: 长度等于 $N$ 的数组，控制搜索方向。

### 3.2 初始化 (Initialization)
1.  **可行性预检 (Eligibility Check)**:
    -   对每个目标，先计算哪些声纳在物理上能“看到”它（目标在声纳的 90° 扇区内）。
    -   如果目标在盲区（例如游出了边界），则强制分配给距离最近的声纳作为托底。
2.  **粒子初始化**:
    -   随机生成 `PSO_SWARM_SIZE` (24) 个粒子。
    -   初始位置仅在“可行声纳”集合中随机选择，避免无效搜索。

### 3.3 代价函数 (Cost Function) - 详解
代价函数（Fitness Function）是引导粒子群搜索方向的“指挥棒”。在本项目中，我们的优化目标是 **最小化系统中最忙碌声纳的扫描周期**（Min-Max Optimization）。

#### 3.3.1 从 `pos[j]` 到 声纳分配 (Decoding)
粒子位置 `pos` 是一个连续的浮点数向量，而声纳分配是离散的。映射关系如下：
-   **输入**: $pos$ 是一个长度为 $N$（目标总数）的向量。$pos[j]$ 代表第 $j$ 个目标在“声纳空间”中的位置。
-   **映射**: `SonarIndex = round(pos[j])`。
    -   例如：若 $pos[j] = 1.4$，则 `round(1.4) = 1`，目标 $j$ 分配给 $S_1$。
    -   若 $pos[j] = 1.6$，则 `round(1.6) = 2`，目标 $j$ 分配给 $S_2$。
    -   值会被截断限制在 $[0, 3]$ 范围内。
-   **物理含义**: 这种连续到离散的映射使得粒子可以在边界（如 1.5）附近“犹豫”，微小的速度更新可能导致目标从一个声纳“跳”到另一个声纳，从而瞬间改变两个声纳的负载。

#### 3.3.2 惩罚机制 (Penalty for Invalid Assignments)
并不是所有的分配都是合法的。如果目标 $j$ 位于声纳 $S_k$ 的物理盲区（例如 $S_k$ 是左上角声纳，只能看右下方向，而目标在它的背后），那么将目标分配给 $S_k$ 是无效的。
-   **判定**: 检查目标角度是否在声纳 $S_k$ 的 90° 扇区内。
-   **惩罚**: $Cost_{total} = Cost_{time} + (N_{invalid} \times 5.0s)$。
    -   每有一个无效分配，总代价这就增加 5 秒（一个巨大的值）。
    -   这迫使粒子群迅速飞离无效区域，收敛到所有分配都物理可行的解空间。

#### 3.3.3 单个声纳的耗时计算 ($T_{sonar}$)
对于每个声纳 $S_k$，其分配到了一组目标 $Targets_k$。我们需要估算它完成这一帧扫描任务需要的时间。算法 `estimateCycleDurationOptimized` 的步骤如下：

1.  **扫描区间构建**:
    -   对于 $Targets_k$ 中的每个目标，根据其角度 $\theta$ 和距离 $r$，生成一个小的扫描子扇区：$[\theta - 10^\circ, \theta + 10^\circ]$。
    -   合并所有重叠的子扇区（Merge Intervals）。例如，两个靠得很近的目标会合并成一个大的连续扇区。

2.  **时间累加**:
    声纳的运动分为两种状态，总时间是各段状态时间之和：
    -   **扫描 (Scanning)**: 在有目标的扇区内，声纳必须发射声波并等待回波。
        -   速度取决于距离：$Speed_{scan} = \frac{StepAngle}{2 \times Range / SpeedOfSound + Overhead}$。
        -   距离 $Range$ 越远，声波往返时间越长，扫描速度越慢。
        -   耗时 $t_{scan} = \frac{Width_{interval}}{Speed_{scan}}$。
    -   **空转 (Slewing)**: 在没有目标的空白扇区，声纳不发射声波，全速旋转。
        -   速度固定为最大机械转速 `SLEW_SPEED` (45°/s)。
        -   耗时 $t_{slew} = \frac{GapWidth}{SLEW_SPEED}$。

3.  **计算结果**:
    $$T_{sonar} = 2 \times (\sum t_{scan} + \sum t_{slew})$$
    （乘以 2 是因为模拟器中模拟的是往返扫描周期，或者为了保守估计）

#### 3.3.4 全局代价与优化目标
$$Cost = \max(T_{S0}, T_{S1}, T_{S2}, T_{S3}) + Penalty$$

-   **Min-Max 逻辑**:
    -   假设 $S_0$ 耗时 2s，$S_1$ 耗时 6s，$S_2$ 耗时 3s，$S_3$ 耗时 1s。
    -   系统的瓶颈是 $S_1$ (6s)。此时 $Cost = 6s$。
    -   如果 PSO 调整分配，把 $S_1$ 的一个远距离目标移给 $S_2$：
        -   $S_1$ 耗时降为 4s。
        -   $S_2$ 耗时升为 4.5s。
    -   新的瓶颈是 $S_2$ (4.5s)。此时 $Cost = 4.5s$。
    -   **结果**: 代价从 6s 降到了 4.5s，系统整体刷新率提升。

通过不断迭代，PSO 会找到一种“最均衡”的分配方式，使得最慢的那个声纳也尽可能快。

### 3.4 迭代更新 (Update Rules)
使用标准的 PSO 速度-位置更新公式，运行 `PSO_ITERATIONS` (30) 次：

$$
v_{i}^{t+1} = w \cdot v_{i}^{t} + c_1 r_1 (pBest_i - x_{i}^{t}) + c_2 r_2 (gBest - x_{i}^{t})
$$
$$
x_{i}^{t+1} = x_{i}^{t} + v_{i}^{t+1}
$$

-   **惯性权重 (w, PSO_INERTIA)**: 0.6 —— 保持原有运动趋势。
-   **认知系数 (c1, PSO_COGNITIVE)**: 1.6 —— 粒子向自己历史最优解靠拢。
-   **社会系数 (c2, PSO_SOCIAL)**: 1.6 —— 粒子向全局最优解靠拢。
-   **位置限制**: 更新后的位置被截断在 `[0, 3]` 之间。

---

## 4. 系统集成 (System Integration)

### 触发机制
-   策略不是每一帧都运行（计算量较大）。
-   **触发条件**:
    1.  时间间隔: 每 `PSO_UPDATE_INTERVAL` (0.8秒) 运行一次。
    2.  事件触发: 如果跟踪的目标数量发生变化（有新目标出现或旧目标丢失），立即触发。

### 执行流程
1.  **预测**: 更新所有卡尔曼滤波器，得到目标当前时刻的预测位置。
2.  **分配 (Run PSO)**: 运行上述 PSO 算法，得到最优分配 `optimizedAssignments`。
3.  **规划 (Plan Next Sector)**:
    -   每个声纳根据分配到的目标，动态调整扫描边界 (`minAngle`, `maxAngle`)。
    -   如果没分配到目标，则回退到默认的全扇区扫描。
    -   根据目标距离动态调整量程 (`scanRange`)，避免不必要的远距离等待。

---

## 5. 总结 (Summary)
**Naive 策略** 是“不管有沒有人，大家都扫全场”，效率低下。
**PSO 策略** 是“通过群体智能，动态地将人分配给最合适的声纳，让最忙的声纳也能尽快扫完”，从而提升整个系统的刷新率和跟踪精度。
