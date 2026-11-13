import { PointsMaterial, type PointsMaterialParameters } from 'three';

/** Fixed Newton iterations for Kepler's equation on the GPU (no early exit in GLSL loops). */
export const KEPLER_ITERATIONS = 10;

/**
 * Vertex attributes (scene units, scene axes):
 *  - `position`: P basis vector (a × perifocal x axis)
 *  - `aQ`:       Q basis vector (b × perifocal y axis)
 *  - `aKep`:     (mean anomaly at the epoch [rad], mean motion [rad/day], eccentricity)
 * Uniform `uDt`: days since the epoch. Keep it short (the renderer rebases the epoch) so
 * float32 never has to represent a large mean anomaly.
 */
const KEPLER_GLSL = /* glsl */ `
  float M = aKep.x + aKep.y * uDt;
  M = mod(M + PI, PI2) - PI;
  float ecc = aKep.z;
  // Danby's starting value converges for every elliptic eccentricity.
  float E = M + 0.85 * ecc * sign(sin(M));
  for (int it = 0; it < ${KEPLER_ITERATIONS}; it++) {
    E -= (E - ecc * sin(E) - M) / (1.0 - ecc * cos(E));
  }
  vec3 transformed = position * (cos(E) - ecc) + aQ * sin(E);
`;

/**
 * JavaScript mirror of the GLSL solver above (float32 rounding included), so the iteration
 * count and starting value can be tested. Keep the two in sync.
 */
export function solveKeplerFixed(M: number, e: number): number {
  const f = Math.fround;
  let E = f(M + f(0.85 * e * Math.sign(Math.sin(M))));
  for (let it = 0; it < KEPLER_ITERATIONS; it++) {
    E = f(E - f(f(E - f(e * Math.sin(E)) - M) / f(1 - f(e * Math.cos(E)))));
  }
  return E;
}

/**
 * A `PointsMaterial` whose vertices are Kepler orbits evaluated on the GPU. Everything else
 * (size, colour, opacity, logarithmic depth) comes from the stock material.
 */
export function createKeplerPointsMaterial(params: PointsMaterialParameters): {
  material: PointsMaterial;
  uniforms: { uDt: { value: number } };
} {
  const uniforms = { uDt: { value: 0 } };
  const material = new PointsMaterial(params);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDt = uniforms.uDt;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 aQ;\nattribute vec3 aKep;\nuniform float uDt;',
      )
      .replace('#include <begin_vertex>', KEPLER_GLSL);
  };
  material.customProgramCacheKey = () => 'kepler-points';
  material.userData.keplerUniforms = uniforms;
  return { material, uniforms };
}

/** The uniforms of a material made by `createKeplerPointsMaterial`. */
export const keplerUniforms = (material: PointsMaterial): { uDt: { value: number } } =>
  material.userData.keplerUniforms as { uDt: { value: number } };
