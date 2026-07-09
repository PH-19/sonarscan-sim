import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const usage = () => {
  console.error([
    'Usage: node scripts/run_parallel_benchmark.mjs <config.json> [--output-dir <dir>] [--shards <n>] [--concurrency <n>]',
    '',
    'Shards are split by seed so paired strategy/scenario/count comparisons remain intact.',
  ].join('\n'));
};

const args = process.argv.slice(2);
let configArg;
let outputDirArg;
let shardCountArg;
let concurrencyArg;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--output-dir') {
    outputDirArg = args[index + 1];
    index += 1;
    continue;
  }
  if (arg === '--shards') {
    shardCountArg = Number(args[index + 1]);
    index += 1;
    continue;
  }
  if (arg === '--concurrency') {
    concurrencyArg = Number(args[index + 1]);
    index += 1;
    continue;
  }
  if (!arg.startsWith('--') && !configArg) configArg = arg;
}

if (!configArg) {
  usage();
  process.exit(2);
}

const configPath = path.resolve(process.cwd(), configArg);
const baseConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const seeds = baseConfig.seeds ?? (baseConfig.seed === undefined ? [] : [baseConfig.seed]);
if (!Array.isArray(seeds) || seeds.length === 0) {
  throw new Error('Parallel benchmark config must include seed or seeds');
}

const shardCount = Number.isInteger(shardCountArg) && shardCountArg > 0
  ? Math.min(shardCountArg, seeds.length)
  : seeds.length;
const concurrency = Number.isInteger(concurrencyArg) && concurrencyArg > 0
  ? Math.min(concurrencyArg, shardCount)
  : Math.min(shardCount, Math.max(1, Math.min(4, seeds.length)));

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.resolve(
  process.cwd(),
  outputDirArg ?? path.join(
    baseConfig.experimentOutputRoot ?? 'output/benchmarks',
    `${baseConfig.benchmarkId ?? 'benchmark'}_parallel-${timestamp}`
  )
);
const shardRoot = path.join(outputDir, '_shards');
const shardConfigDir = path.join(shardRoot, 'configs');
mkdirSync(shardConfigDir, { recursive: true });

const distributeSeeds = () => {
  const shards = Array.from({ length: shardCount }, () => []);
  seeds.forEach((seed, index) => {
    shards[index % shardCount].push(seed);
  });
  return shards.filter(shardSeeds => shardSeeds.length > 0);
};

const shardSeeds = distributeSeeds();
const shardSpecs = shardSeeds.map((seedGroup, index) => {
  const shardId = `part${String(index + 1).padStart(2, '0')}`;
  const config = {
    ...baseConfig,
    seeds: seedGroup,
  };
  delete config.seed;
  const shardConfigPath = path.join(shardConfigDir, `${shardId}.json`);
  const shardOutputDir = path.join(shardRoot, shardId);
  writeFileSync(shardConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    shardId,
    seedGroup,
    configPath: shardConfigPath,
    outputDir: shardOutputDir,
  };
});

const runShard = spec => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join('scripts', 'run_benchmark.mjs'),
    spec.configPath,
    '--skip-gate',
    '--output-dir',
    spec.outputDir,
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('exit', code => {
    if (code !== 0) {
      reject(new Error(`${spec.shardId} failed with exit code ${code}\n${stdout}\n${stderr}`));
      return;
    }
    console.log(`${spec.shardId} complete: seeds=${spec.seedGroup.join(',')}`);
    resolve({ spec, stdout, stderr });
  });
});

const runQueue = async specs => {
  const pending = [...specs];
  const running = new Set();
  const results = [];
  const launchNext = async () => {
    if (pending.length === 0) return;
    const spec = pending.shift();
    const promise = runShard(spec)
      .then(result => {
        results.push(result);
      })
      .finally(() => {
        running.delete(promise);
      });
    running.add(promise);
  };

  while (pending.length > 0 || running.size > 0) {
    while (pending.length > 0 && running.size < concurrency) {
      await launchNext();
    }
    if (running.size > 0) await Promise.race(running);
  }
  return results;
};

const appendJsonl = async (inputPath, outputStream) => {
  let lineCount = 0;
  let sawBytes = false;
  let lastByte = null;
  for await (const chunk of createReadStream(inputPath)) {
    sawBytes = true;
    for (const byte of chunk) {
      if (byte === 10) lineCount += 1;
    }
    lastByte = chunk[chunk.length - 1];
    if (!outputStream.write(chunk)) {
      await once(outputStream, 'drain');
    }
  }
  if (sawBytes && lastByte !== 10) {
    if (!outputStream.write('\n')) {
      await once(outputStream, 'drain');
    }
    lineCount += 1;
  }
  return lineCount;
};

const finishStream = async stream => {
  stream.end();
  await once(stream, 'finish');
};

const mergeOutputs = async specs => {
  const manifests = [];
  const samplesStream = createWriteStream(path.join(outputDir, 'samples.jsonl'), { flags: 'w' });
  const runsStream = createWriteStream(path.join(outputDir, 'runs.jsonl'), { flags: 'w' });
  let sampleCount = 0;
  let runCount = 0;
  for (const spec of specs) {
    const samplesPath = path.join(spec.outputDir, 'samples.jsonl');
    const runsPath = path.join(spec.outputDir, 'runs.jsonl');
    const manifestPath = path.join(spec.outputDir, 'manifest.json');
    if (!existsSync(samplesPath) || !existsSync(runsPath) || !existsSync(manifestPath)) {
      throw new Error(`Missing shard artifact for ${spec.shardId}`);
    }
    sampleCount += await appendJsonl(samplesPath, samplesStream);
    runCount += await appendJsonl(runsPath, runsStream);
    manifests.push(JSON.parse(readFileSync(manifestPath, 'utf8')));
  }
  await Promise.all([finishStream(samplesStream), finishStream(runsStream)]);

  const first = manifests[0] ?? {};
  const strategyImplementations = Object.assign(
    {},
    ...manifests.map(manifest => manifest.strategyImplementations ?? {})
  );
  const mergedConfig = {
    ...first.config,
    ...baseConfig,
    configPath,
    outputDir,
    seeds,
  };
  delete mergedConfig.seed;
  const mergedManifest = {
    ...first,
    config: mergedConfig,
    strategyImplementations,
    generatedAt: new Date().toISOString(),
    mergedFrom: specs.map(spec => path.resolve(spec.outputDir)),
    shardCount: specs.length,
    parallelConcurrency: concurrency,
    runCount,
    sampleCount,
    note: `${first.note ?? ''} Merged from seed-sharded parallel benchmark outputs.`.trim(),
  };
  writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(mergedManifest, null, 2)}\n`);
  return {
    outputDir,
    samplePath: path.join(outputDir, 'samples.jsonl'),
    runSummaryPath: path.join(outputDir, 'runs.jsonl'),
    manifestPath: path.join(outputDir, 'manifest.json'),
    runCount,
    sampleCount,
  };
};

rmSync(path.join(outputDir, 'samples.jsonl'), { force: true });
rmSync(path.join(outputDir, 'runs.jsonl'), { force: true });
rmSync(path.join(outputDir, 'manifest.json'), { force: true });

console.log(`Running ${shardSpecs.length} seed shards with concurrency=${concurrency}`);
console.log(`Output: ${outputDir}`);
await runQueue(shardSpecs);
const result = await mergeOutputs(shardSpecs);
console.log(JSON.stringify(result, null, 2));
