export type SeededRng = {
  next: () => number; // [0, 1)
  nextInt: (maxExclusive: number) => number;
  nextRange: (minInclusive: number, maxExclusive: number) => number;
  nextNormal: (mean?: number, stdDev?: number) => number;
  fork: (salt: number) => SeededRng;
};

const UINT32_MAX_PLUS_1 = 0x1_0000_0000;

export const createLCGRng = (seed: number): SeededRng => {
  let state = (seed >>> 0) || 1;

  const nextUint32 = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };

  const next = () => nextUint32() / UINT32_MAX_PLUS_1;

  const nextInt = (maxExclusive: number) => {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
    return Math.floor(next() * maxExclusive);
  };

  const nextRange = (minInclusive: number, maxExclusive: number) => {
    if (maxExclusive <= minInclusive) return minInclusive;
    return minInclusive + next() * (maxExclusive - minInclusive);
  };

  const nextNormal = (mean = 0, stdDev = 1) => {
    const u1 = Math.max(1e-12, next());
    const u2 = Math.max(1e-12, next());
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    return mean + z0 * stdDev;
  };

  const fork = (salt: number) => createLCGRng((nextUint32() ^ (salt >>> 0)) >>> 0);

  return { next, nextInt, nextRange, nextNormal, fork };
};

// FNV-1a 32-bit hash
export const hashStringToUint32 = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const seededNormalFromKey = (
  key: string,
  mean = 0,
  stdDev = 1
): number => {
  const rng = createLCGRng(hashStringToUint32(key));
  return rng.nextNormal(mean, stdDev);
};

