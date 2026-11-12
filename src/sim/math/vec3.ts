/** Minimal float64 vector/matrix helpers. The sim layer never depends on three.js. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Row-major 3x3 matrix. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function copy(out: Vec3, v: Vec3): Vec3 {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  return out;
}

export function add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export const length = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function normalize(out: Vec3, v: Vec3): Vec3 {
  const l = length(v) || 1;
  out.x = v.x / l;
  out.y = v.y / l;
  out.z = v.z / l;
  return out;
}

export function cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Build a matrix whose columns are the given basis vectors. */
export const fromColumns = (c0: Vec3, c1: Vec3, c2: Vec3): Mat3 => [
  c0.x,
  c1.x,
  c2.x,
  c0.y,
  c1.y,
  c2.y,
  c0.z,
  c1.z,
  c2.z,
];

export function transform(out: Vec3, m: Mat3, v: Vec3): Vec3 {
  const { x, y, z } = v;
  out.x = m[0] * x + m[1] * y + m[2] * z;
  out.y = m[3] * x + m[4] * y + m[5] * z;
  out.z = m[6] * x + m[7] * y + m[8] * z;
  return out;
}
