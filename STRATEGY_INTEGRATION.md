# Python 策略接入

## 边界

Python 只负责“下一轮怎么扫”，不负责推进仿真时间。

- TypeScript：游泳者运动、声呐机械运动、ping/frame、成像噪声、检测、匹配、Kalman 跟踪、指标。
- Python：根据声呐状态和 Kalman 轨迹，返回每个声呐的扫描角度上下界、量程和目标分配。

这个边界避免 Python RPC 延迟改变声学和机械时间模型，也保证不同策略共享完全相同的模拟器与随机场景。

## 请求与响应

前端每 0.8 秒仿真时间向 `POST /plan` 发送：

```json
{
  "strategy": "BELIEF_PSO_V2",
  "snapshot": {
    "simulationTime": 12.4,
    "seed": 1337,
    "pool": {"width": 20, "length": 50},
    "physics": {
      "speedOfSound": 1500,
      "slewSpeed": 45,
      "scanStepAngle": 0.9,
      "processingOverheadSec": 0.002,
      "scanStepOverheadSec": 0.005,
      "receiveGuardFactor": 1.1,
      "samplesPerBeam": 256,
      "samplePeriodSec": 0.000005,
      "tdmaSlotCount": 4,
      "maxRange": 50
    },
    "sonars": [],
    "tracks": []
  }
}
```

Python 返回：

```json
{
  "strategy": "BELIEF_PSO_V2",
  "generatedAt": 12.4,
  "plans": [
    {
      "sonarId": "S1",
      "minLocalAngle": 72,
      "maxLocalAngle": 98,
      "range": 24,
      "assignedTargetIds": ["T0001"],
      "action": "TRACK_ROI"
    }
  ]
}
```

所有 command bounds 都是 local mechanical degrees。TypeScript 会校验 `[minLocalAngle,maxLocalAngle]`、range 和 action；planner 不能修改 current angle。正在执行的 command 不会被 RPC 中途截断，下一条 command 只使用完成后的新鲜 decision。

## 新增一个 baseline

1. 在 `strategies/` 新建 Python 文件，实现 `plan(snapshot: dict) -> dict`。
2. 在 `strategies/__init__.py` 的 `STRATEGIES` 中注册名称。
3. 为策略添加确定性测试；随机算法必须由请求中的 `seed` 和仿真时间桶派生随机种子。
4. 用环境变量选择比较的两个策略，不需要修改 TypeScript：

```bash
VITE_BASELINE_STRATEGY=NAIVE \
VITE_CANDIDATE_STRATEGY=MY_STRATEGY \
npm run dev
```

当前 UI 固定同时运行两个比较槽。指标字段仍使用历史名称 `*Naive` 和 `*Optimized`，实际分别表示 baseline 槽和 candidate 槽。若要一次显示三个及以上策略，需要将 `SimulationMetrics` 和 Dashboard 从固定字段改为 `Record<strategyName, metrics>`；策略服务协议本身无需修改。

## 修改模拟器其余部分时的规则

- 新策略需要更多输入：先扩展 `StrategySnapshot`，再在 `getStrategySnapshot()` 填充。不要把 ground truth swimmer 位置传给策略，策略只能使用 `tracks`。
- 新策略需要新的动作：扩展 `SonarStrategyPlan` 和 `applyStrategyDecision()`；机械执行仍放在 `SimulationEngine.update()`。
- 调整声学或机械参数：只改 TypeScript 常量。请求会把实际 physics 参数传给 Python，策略不要复制这些值。
- 调整当前 proposed optimizer 超参数：改 `strategies/proposed_v3.py`；`strategies/proposed.py` 是当前 proposed method 的兼容入口，`strategies/proposed_v2.py` 是冻结的 previous proposed 版本。这些属于策略，不应再放回 `constants.ts`。
- 批量实验：固定 `seed`、场景生成和检测参数，仅改变策略名称；否则 baseline 不可公平比较。
- `TRUTH_LOOKAHEAD_ORACLE` 是 TypeScript headless benchmark 的特殊诊断 provider，不在 Python `STRATEGIES` 中注册，也不能由 UI/HTTP 在线调用。它的 truth supplier 与普通 `StrategySnapshot` 严格隔离。

## 验证

```bash
npm run test:strategies
npm run build
```

HTTP 联调可在启动策略服务后向 `http://127.0.0.1:8765/plan` 发送请求。Vite 开发服务器将 `/api/strategy/*` 代理到该地址。
