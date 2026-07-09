const mix = (value: number) => {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
};

export const fieldHash = (seed: number, ...coordinates: number[]) => {
  let hash = mix(seed ^ 0x9e3779b9);
  for (const coordinate of coordinates) {
    hash = mix(hash ^ mix(Math.round(coordinate)));
  }
  return hash;
};

export const fieldUniform = (seed: number, ...coordinates: number[]) => (
  (fieldHash(seed, ...coordinates) + 0.5) / 0x100000000
);

export const fieldNormal = (seed: number, ...coordinates: number[]) => {
  const u1 = Math.max(1e-12, fieldUniform(seed, ...coordinates, 0x51f15e));
  const u2 = fieldUniform(seed, ...coordinates, 0xa17c9b);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};
