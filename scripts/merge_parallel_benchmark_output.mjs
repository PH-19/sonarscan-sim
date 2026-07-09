import { once } from 'node:events';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const [configArg, outputDirArg] = process.argv.slice(2);

if (!configArg || !outputDirArg) {
  console.error('Usage: node scripts/merge_parallel_benchmark_output.mjs <config.json> <parallel-output-dir>');
  process.exit(2);
}

const configPath = path.resolve(process.cwd(), configArg);
const outputDir = path.resolve(process.cwd(), outputDirArg);
const shardRoot = path.join(outputDir, '_shards');
const baseConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const seeds = baseConfig.seeds ?? (baseConfig.seed === undefined ? [] : [baseConfig.seed]);

if (!existsSync(shardRoot)) {
  throw new Error(`Missing shard root: ${shardRoot}`);
}

const shardDirs = readdirSync(shardRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^part\d+$/.test(entry.name))
  .map(entry => path.join(shardRoot, entry.name))
  .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

if (shardDirs.length === 0) {
  throw new Error(`No shard directories found under ${shardRoot}`);
}

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

const requiredFiles = shardDirs.flatMap(shardDir => [
  path.join(shardDir, 'runs.jsonl'),
  path.join(shardDir, 'samples.jsonl'),
  path.join(shardDir, 'manifest.json'),
]);
for (const filePath of requiredFiles) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing shard artifact: ${filePath}`);
  }
}

const runsStream = createWriteStream(path.join(outputDir, 'runs.jsonl'), { flags: 'w' });
const samplesStream = createWriteStream(path.join(outputDir, 'samples.jsonl'), { flags: 'w' });
let runCount = 0;
let sampleCount = 0;
for (const shardDir of shardDirs) {
  runCount += await appendJsonl(path.join(shardDir, 'runs.jsonl'), runsStream);
  sampleCount += await appendJsonl(path.join(shardDir, 'samples.jsonl'), samplesStream);
}
await Promise.all([finishStream(runsStream), finishStream(samplesStream)]);

const manifests = shardDirs.map(shardDir => JSON.parse(readFileSync(path.join(shardDir, 'manifest.json'), 'utf8')));
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
  mergedFrom: shardDirs.map(shardDir => path.resolve(shardDir)),
  shardCount: shardDirs.length,
  parallelConcurrency: first.parallelConcurrency ?? null,
  runCount,
  sampleCount,
  note: `${first.note ?? ''} Merged from seed-sharded parallel benchmark outputs with streaming merge.`.trim(),
};

writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(mergedManifest, null, 2)}\n`);

console.log(JSON.stringify({
  outputDir,
  samplePath: path.join(outputDir, 'samples.jsonl'),
  runSummaryPath: path.join(outputDir, 'runs.jsonl'),
  manifestPath: path.join(outputDir, 'manifest.json'),
  shardCount: shardDirs.length,
  runCount,
  sampleCount,
}, null, 2));
