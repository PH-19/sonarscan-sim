export type KalmanStateCV2D = {
  x: [number, number, number, number]; // [x, y, vx, vy]
  P: number[]; // 4x4 row-major
  t: number; // state timestamp (sim time seconds)
};

const makeIdentity4 = () => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

export const createCV2D = (initial: {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  posVar?: number;
  velVar?: number;
}): KalmanStateCV2D => {
  const posVar = initial.posVar ?? 25; // (m^2)
  const velVar = initial.velVar ?? 4; // (m/s)^2

  const P = [
    posVar, 0, 0, 0,
    0, posVar, 0, 0,
    0, 0, velVar, 0,
    0, 0, 0, velVar,
  ];

  return {
    x: [initial.x, initial.y, initial.vx, initial.vy],
    P,
    t: initial.t,
  };
};

const mat4Mul = (a: number[], b: number[]) => {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
};

const mat4Transpose = (m: number[]) => [
  m[0], m[4], m[8], m[12],
  m[1], m[5], m[9], m[13],
  m[2], m[6], m[10], m[14],
  m[3], m[7], m[11], m[15],
];

const addMat4 = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);

export const predictCV2D = (state: KalmanStateCV2D, toTime: number, sigmaAccel: number) => {
  const dt = toTime - state.t;
  if (!(dt > 0)) {
    state.t = toTime;
    return state;
  }

  const [x, y, vx, vy] = state.x;

  // x = F x
  const nx = x + vx * dt;
  const ny = y + vy * dt;
  const nvx = vx;
  const nvy = vy;
  state.x = [nx, ny, nvx, nvy];

  // P = F P F^T + Q
  const F = [
    1, 0, dt, 0,
    0, 1, 0, dt,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];

  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt2 * dt2;
  const sa2 = sigmaAccel * sigmaAccel;

  const q11 = (dt4 / 4) * sa2;
  const q13 = (dt3 / 2) * sa2;
  const q33 = dt2 * sa2;

  const Q = [
    q11, 0, q13, 0,
    0, q11, 0, q13,
    q13, 0, q33, 0,
    0, q13, 0, q33,
  ];

  const FP = mat4Mul(F, state.P);
  const Ft = mat4Transpose(F);
  state.P = addMat4(mat4Mul(FP, Ft), Q);

  state.t = toTime;
  return state;
};

const invert2x2 = (a00: number, a01: number, a10: number, a11: number) => {
  const det = a00 * a11 - a01 * a10;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return {
    i00: a11 * invDet,
    i01: -a01 * invDet,
    i10: -a10 * invDet,
    i11: a00 * invDet,
  };
};

export const updateCV2D = (state: KalmanStateCV2D, z: { x: number; y: number }, sigmaMeas: number) => {
  const R = sigmaMeas * sigmaMeas;
  const P = state.P;

  // Innovation y = z - Hx where H picks position
  const y0 = z.x - state.x[0];
  const y1 = z.y - state.x[1];

  // S = HPH^T + R
  const s00 = P[0] + R;
  const s01 = P[1];
  const s10 = P[4];
  const s11 = P[5] + R;
  const invS = invert2x2(s00, s01, s10, s11);
  if (!invS) return state;

  // K = P H^T S^-1, with PH^T being first two columns of P
  const ph0 = [P[0], P[1]];
  const ph1 = [P[4], P[5]];
  const ph2 = [P[8], P[9]];
  const ph3 = [P[12], P[13]];

  const k0 = [
    ph0[0] * invS.i00 + ph0[1] * invS.i10,
    ph0[0] * invS.i01 + ph0[1] * invS.i11,
  ];
  const k1 = [
    ph1[0] * invS.i00 + ph1[1] * invS.i10,
    ph1[0] * invS.i01 + ph1[1] * invS.i11,
  ];
  const k2 = [
    ph2[0] * invS.i00 + ph2[1] * invS.i10,
    ph2[0] * invS.i01 + ph2[1] * invS.i11,
  ];
  const k3 = [
    ph3[0] * invS.i00 + ph3[1] * invS.i10,
    ph3[0] * invS.i01 + ph3[1] * invS.i11,
  ];

  // x = x + K y
  state.x = [
    state.x[0] + k0[0] * y0 + k0[1] * y1,
    state.x[1] + k1[0] * y0 + k1[1] * y1,
    state.x[2] + k2[0] * y0 + k2[1] * y1,
    state.x[3] + k3[0] * y0 + k3[1] * y1,
  ];

  // P = (I - K H) P = P - K (H P), where HP are first two rows of P
  const hp0 = [P[0], P[1], P[2], P[3]];
  const hp1 = [P[4], P[5], P[6], P[7]];

  const K = [k0, k1, k2, k3];
  const Pnew = new Array<number>(16);
  for (let i = 0; i < 4; i++) {
    const ki0 = K[i][0];
    const ki1 = K[i][1];
    for (let j = 0; j < 4; j++) {
      const correction = ki0 * hp0[j] + ki1 * hp1[j];
      Pnew[i * 4 + j] = P[i * 4 + j] - correction;
    }
  }

  state.P = Pnew;
  return state;
};

export const getPositionCV2D = (state: KalmanStateCV2D) => ({ x: state.x[0], y: state.x[1] });

