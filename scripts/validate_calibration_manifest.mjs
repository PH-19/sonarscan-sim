import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const manifestArg = process.argv[2];
if (!manifestArg) {
  console.error('Usage: node scripts/validate_calibration_manifest.mjs <manifest.json> [--check-files]');
  process.exit(2);
}

const manifestPath = path.resolve(process.cwd(), manifestArg);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];
const requireString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${field} must be a non-empty string`);
};
const requirePositive = (value, field) => {
  if (!Number.isFinite(value) || value <= 0) errors.push(`${field} must be positive`);
};

if (manifest.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
requireString(manifest.datasetId, 'datasetId');
if (!Array.isArray(manifest.sessions) || manifest.sessions.length < 2) {
  errors.push('sessions must contain at least one calibration and one test session');
}

const sessionIds = new Set();
const poolSplits = new Map();
for (const [index, session] of (manifest.sessions ?? []).entries()) {
  const prefix = `sessions[${index}]`;
  requireString(session.sessionId, `${prefix}.sessionId`);
  requireString(session.poolId, `${prefix}.poolId`);
  if (!['calibration', 'validation', 'test'].includes(session.split)) errors.push(`${prefix}.split is invalid`);
  requirePositive(session.poolWidthM, `${prefix}.poolWidthM`);
  requirePositive(session.poolLengthM, `${prefix}.poolLengthM`);
  requirePositive(session.sonarDepthM, `${prefix}.sonarDepthM`);
  requirePositive(session.frequencyKhz, `${prefix}.frequencyKhz`);
  requirePositive(session.sampleCount, `${prefix}.sampleCount`);
  if (sessionIds.has(session.sessionId)) errors.push(`duplicate sessionId ${session.sessionId}`);
  sessionIds.add(session.sessionId);
  const splits = poolSplits.get(session.poolId) ?? new Set();
  splits.add(session.split);
  poolSplits.set(session.poolId, splits);
  if (!Array.isArray(session.files) || session.files.length === 0) errors.push(`${prefix}.files must be non-empty`);
  if (process.argv.includes('--check-files')) {
    for (const file of session.files ?? []) {
      if (!existsSync(path.resolve(path.dirname(manifestPath), file))) errors.push(`${prefix} missing file ${file}`);
    }
  }
}

const splits = new Set((manifest.sessions ?? []).map(session => session.split));
if (!splits.has('calibration')) errors.push('manifest requires a calibration split');
if (!splits.has('test')) errors.push('manifest requires a held-out test split');
for (const [poolId, assignedSplits] of poolSplits.entries()) {
  if (assignedSplits.has('calibration') && assignedSplits.has('test')) {
    errors.push(`pool ${poolId} appears in both calibration and test; use pool-level holdout`);
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`valid calibration manifest: ${manifest.datasetId} (${manifest.sessions.length} sessions)`);
