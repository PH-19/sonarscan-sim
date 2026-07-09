import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { StrategyDecision, StrategySnapshot } from '../../../types';
import { StrategyImplementation, StrategyProvider } from './StrategyProvider';

type WorkerResponse = { requestId: number; decision?: StrategyDecision; error?: string };

export class PythonWorkerStrategyProvider implements StrategyProvider {
  readonly metadata: StrategyImplementation;
  invocationCount = 0;

  private readonly worker: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (value: StrategyDecision) => void; reject: (reason: Error) => void }>();
  private workerError: Error | undefined;

  constructor(readonly strategyId: string, cwd = process.cwd()) {
    const normalized = strategyId.toUpperCase();
    const isBeliefPso = normalized.startsWith('BELIEF_PSO_');
    const isBeliefPsoV3 = normalized.startsWith('BELIEF_PSO_V3');
    const usesOnlinePso = isBeliefPso && !normalized.endsWith('NO_PSO');
    const constrainedRepairEnabled = usesOnlinePso && !normalized.endsWith('NO_CONSTRAINED_REPAIR');
    const redundantTrackingEnabled = isBeliefPso && !normalized.endsWith('NO_REDUNDANT_TRACKING');
    const reserveSearchEnabled = isBeliefPso && !normalized.endsWith('NO_RESERVE_SEARCH');
    const proposedFunctions: Record<string, string> = {
      BELIEF_PSO_V2: 'plan',
      BELIEF_PSO_NO_COVERAGE: 'plan_no_coverage',
      BELIEF_PSO_NO_UNCERTAINTY: 'plan_no_uncertainty',
      BELIEF_PSO_FIXED_RANGE: 'plan_fixed_range',
      BELIEF_PSO_NO_PSO: 'plan_no_pso',
      BELIEF_PSO_V3: 'plan',
      BELIEF_PSO_V3_NO_COVERAGE: 'plan_no_coverage',
      BELIEF_PSO_V3_NO_UNCERTAINTY: 'plan_no_uncertainty',
      BELIEF_PSO_V3_FIXED_RANGE: 'plan_fixed_range',
      BELIEF_PSO_V3_NO_PSO: 'plan_no_pso',
      BELIEF_PSO_V3_NO_CONSTRAINED_REPAIR: 'plan_no_constrained_repair',
      BELIEF_PSO_V3_NO_REDUNDANT_TRACKING: 'plan_no_redundant_tracking',
      BELIEF_PSO_V3_NO_RESERVE_SEARCH: 'plan_no_reserve_search',
    };
    const sourceFile = isBeliefPso ? (isBeliefPsoV3 ? 'proposed_v3.py' : 'proposed_v2.py') : 'pso.py';
    const source = readFileSync(path.join(cwd, 'strategies', sourceFile));
    this.metadata = {
      strategyId,
      implementationLanguage: 'python',
      implementation: isBeliefPso
        ? `strategies.${isBeliefPsoV3 ? 'proposed_v3' : 'proposed_v2'}:${proposedFunctions[normalized] ?? 'unknown'}`
        : 'strategies.pso:plan',
      codeVersion: createHash('sha256').update(source).digest('hex').slice(0, 12),
      parameters: {
        swarmSize: usesOnlinePso ? 32 : 0,
        iterations: usesOnlinePso ? (isBeliefPsoV3 ? 30 : 40) : 0,
        searchSweepDeg: isBeliefPso ? 90 : 30,
        searchAngularStepDeg: isBeliefPso ? 2.4 : 1,
        trackRoiAngularStepDeg: isBeliefPso ? 0.9 : 1,
        segmentedScanWindows: isBeliefPso,
        minRoiDeg: isBeliefPso ? 20 : 0,
        maxRoiDeg: isBeliefPso ? 85 : 0,
        segmentedGroupThresholdDeg: isBeliefPso ? 45 : 0,
        segmentWindowMinDeg: isBeliefPso ? 16 : 0,
        segmentWindowMaxDeg: isBeliefPso ? 42 : 0,
        angularSigmaMultiplier: isBeliefPso ? 1.35 : 0,
        maxAngularMarginDeg: isBeliefPso ? 26 : 0,
        rangeSigmaMultiplier: isBeliefPso ? 1.25 : 0,
        tentativeRecoveryEnabled: false,
        tentativeRecoveryConfidence: isBeliefPso ? 0.98 : 0,
        tentativeRecoveryMinAgeSec: isBeliefPso ? 8 : 0,
        tentativeRecoveryMinStalenessSec: isBeliefPso ? 2 : 0,
        tentativeRecoveryMaxStalenessSec: isBeliefPso ? 8 : 0,
        lostRecoveryMaxStalenessSec: isBeliefPso ? 35 : 0,
        maxTracksPerAvailableSonar: isBeliefPso ? 2.5 : 0,
        updateIntervalSec: 0.8,
        coverageDebt: !normalized.endsWith('NO_COVERAGE'),
        uncertaintyAware: !normalized.endsWith('NO_UNCERTAINTY'),
        adaptiveRange: !normalized.endsWith('FIXED_RANGE'),
        pso: usesOnlinePso,
        psoActivation: usesOnlinePso
          ? (constrainedRepairEnabled ? 'allConfirmedTracksWithFeasibilityRepair' : 'allConfirmedTracksWithoutConstrainedRepair')
          : 'disabled',
        psoSeededByFastAssignment: usesOnlinePso,
        psoFeasibilityRepair: constrainedRepairEnabled
          ? 'decode-stage repair enforces eligible sonars, nonempty load under saturation, and bounded group capacity'
          : 'disabled',
        psoObjectivePriority: usesOnlinePso
          ? 'identityContinuityThenAverageAoIThenMatchedScanRate'
          : 'disabled',
        psoSeedChangeBaseCost: usesOnlinePso ? 18 : 0,
        psoSeedChangeLateralCost: usesOnlinePso ? 8 : 0,
        psoPredictedRevisitQuadraticWeight: usesOnlinePso ? 0.65 : 0,
        psoPredictedRevisitTailThresholdSec: usesOnlinePso ? 6 : 0,
        psoPredictedRevisitTailWeight: usesOnlinePso ? 3.0 : 0,
        redundantTracking: redundantTrackingEnabled,
        reserveSearch: reserveSearchEnabled,
      },
    };
    this.worker = spawn('python3', ['-m', 'strategies.worker'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    readline.createInterface({ input: this.worker.stdout }).on('line', line => this.handleLine(line));
    this.worker.stderr.on('data', chunk => this.fail(new Error(`Python strategy worker: ${chunk.toString().trim()}`)));
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      if (code !== 0 && !this.workerError) this.fail(new Error(`Python strategy worker exited with code ${code}`));
    });
  }

  plan(snapshot: StrategySnapshot): Promise<StrategyDecision> {
    if (this.workerError) return Promise.reject(this.workerError);
    const requestId = this.nextRequestId++;
    this.invocationCount += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.stdin.write(`${JSON.stringify({ requestId, strategy: this.strategyId, snapshot })}\n`, error => {
        if (!error) return;
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async close() {
    if (!this.worker.killed) this.worker.kill();
  }

  private handleLine(line: string) {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      this.fail(new Error(`Invalid JSON from Python strategy worker: ${line}`));
      return;
    }
    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);
    if (response.error || !response.decision) {
      request.reject(new Error(response.error ?? 'Python strategy worker returned no decision'));
      return;
    }
    request.resolve(response.decision);
  }

  private fail(error: Error) {
    this.workerError = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
