import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
  }
};

const args = process.argv.slice(2);
const skipGate = args.includes('--skip-gate');
process.argv = [
  process.argv[0],
  process.argv[1],
  ...args.filter(arg => arg !== '--skip-gate'),
];

try {
  if (!skipGate) {
    run('npm', ['run', 'test:sim']);
    run('npm', ['run', 'test:strategies']);
    run('npx', ['tsc', '--noEmit']);
    run('npm', ['run', 'test:benchmark']);
  }

  const tmp = await mkdtemp(path.join(tmpdir(), 'sonarscan-benchmark-'));
  const outfile = path.join(tmp, 'run-benchmark.mjs');
  await build({
    entryPoints: [path.resolve(process.cwd(), 'services/sim/benchmark/runBenchmarkCli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    sourcemap: false,
    logLevel: 'silent',
    external: ['node:child_process', 'node:fs', 'node:path'],
  });
  await import(pathToFileURL(outfile).href);
} catch (error) {
  assert.fail(error?.stack ?? String(error));
}
