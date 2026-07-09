import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BenchmarkConfig } from './BenchmarkConfig';
import { HeadlessRunner } from '../headless/HeadlessRunner';
import { SimulatorState } from './MetricsRecorder';

const usage = () => {
  console.error('Usage: node scripts/run_benchmark.mjs <config.json> [--output-dir <dir>] [--skip-gate]');
};

const git = (args: string[]) => {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
};

const simulatorState = (): SimulatorState => {
  const status = git(['status', '--short']);
  return {
    gitCommit: git(['rev-parse', '--short', 'HEAD']),
    gitDirty: status.length > 0,
    gitStatusShort: status,
  };
};

const args = process.argv.slice(2);
let configArg: string | undefined;
let outputDir: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--output-dir') {
    outputDir = args[i + 1];
    i += 1;
    continue;
  }
  if (arg === '--skip-gate') continue;
  if (!arg.startsWith('--') && !configArg) configArg = arg;
}
if (!configArg || outputDir === '') {
  usage();
  process.exit(2);
}
const configPath = path.resolve(process.cwd(), configArg);
const raw = JSON.parse(readFileSync(configPath, 'utf8')) as BenchmarkConfig;
raw.configPath = configPath;
if (outputDir) raw.outputDir = outputDir;

const result = await new HeadlessRunner().run(raw, simulatorState());
console.log(JSON.stringify(result, null, 2));
