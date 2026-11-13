import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  InstancedBufferAttribute,
  type InterleavedBufferAttribute,
  type PerspectiveCamera,
} from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { TAU, type BodyDefinition } from '../../sim/index.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { pixelsPerUnit, relativeToScene, UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { PRIORITY_SCENE } from './SimDriver.tsx';

/** Enough segments that chord error stays well below planet radii even at 30 AU. */
const SEGMENTS = 1024;
/** Orbits fade out between these on-screen sizes (px, semi-major axis) instead of popping. */
const FADE_START_PX = 20;
const FADE_END_PX = 8;
/** Line width in CSS pixels: 1 px lines all but vanish on high-DPR screens. */
const LINE_WIDTH_PX = 1.5;
/** Opacity of the orbit just ahead of the body, relative to just behind it. */
const AHEAD_OPACITY = 0.15;

interface OrbitUniforms {
  uBodyPhase: { value: number };
  uFade: { value: number };
}

/**
 * A fat orbit line whose opacity trails the body: brightest just behind it, fading towards the
 * point just ahead, so the direction of motion reads at a glance. Each segment endpoint carries
 * its eccentric anomaly as a fraction of a turn (`aPhaseStart/End`); `uBodyPhase` is the body's.
 */
function createOrbitLine(color: string, opacity: number): Line2 {
  const geometry = new LineGeometry();
  geometry.setPositions(new Float32Array((SEGMENTS + 1) * 3));
  const start = new Float32Array(SEGMENTS);
  const end = new Float32Array(SEGMENTS);
  for (let k = 0; k < SEGMENTS; k++) {
    start[k] = k / SEGMENTS;
    end[k] = (k + 1) / SEGMENTS;
  }
  geometry.setAttribute('aPhaseStart', new InstancedBufferAttribute(start, 1));
  geometry.setAttribute('aPhaseEnd', new InstancedBufferAttribute(end, 1));

  const material = new LineMaterial({
    color,
    linewidth: LINE_WIDTH_PX,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const uniforms: OrbitUniforms = { uBodyPhase: { value: 0 }, uFade: { value: 1 } };
  material.userData = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'attribute float aPhaseStart;\nattribute float aPhaseEnd;\nvarying float vPhase;\nvoid main() {\n  vPhase = ( position.y < 0.5 ) ? aPhaseStart : aPhaseEnd;',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform float uBodyPhase;\nuniform float uFade;\nvarying float vPhase;\nvoid main() {',
      )
      .replace(
        'float alpha = opacity;',
        `float trail = fract( uBodyPhase - vPhase );
float alpha = opacity * uFade * mix( 1.0, ${AHEAD_OPACITY.toFixed(3)}, pow( trail, 0.8 ) );`,
      );
  };
  material.customProgramCacheKey = () => 'orbit-trail';
  return new Line2(geometry, material);
}

export function OrbitPath({ def, color }: { def: BodyDefinition; color: string }) {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const lastJd = useRef(Number.NaN);
  const isMoon = def.kind === 'moon';

  const ref = useRef<Line2>(null);
  const line = useMemo(() => createOrbitLine(color, isMoon ? 0.4 : 0.55), [color, isMoon]);

  useEffect(
    () => () => {
      line.geometry.dispose();
      line.material.dispose();
    },
    [line],
  );

  useFrame(() => {
    const l = ref.current;
    if (!l) return;
    const { layers } = useViewStore.getState();
    const enabled = layers.orbits && (!isMoon || layers.moonOrbits);
    if (!enabled || !def.parentId) {
      l.visible = false;
      return;
    }
    const eph = sim.ephemeris;
    relativeToScene(eph.position(def.parentId), frame.origin, l.position);

    // Fade orbits out as they shrink on screen, rather than hiding them abruptly.
    const semiMajor = eph.semiMajorAxisKm(def.id) * UNITS_PER_KM;
    const ppu = pixelsPerUnit(camera, camera.position.distanceTo(l.position), size.height);
    const t = (semiMajor * ppu - FADE_END_PX) / (FADE_START_PX - FADE_END_PX);
    const fade = Math.min(1, Math.max(0, t));
    l.visible = fade > 0;
    if (!l.visible) return;

    const material = l.material;
    const uniforms = material.userData as OrbitUniforms;
    uniforms.uFade.value = fade * fade * (3 - 2 * fade);
    uniforms.uBodyPhase.value = (eph.eccentricAnomaly(def.id) ?? 0) / TAU;
    material.resolution.set(size.width, size.height);

    // Rebuild geometry on first use and when secular drift has accumulated.
    const period = eph.orbitalPeriodDays(def.id) ?? 1;
    const stale =
      Number.isNaN(lastJd.current) ||
      (eph.orbitDrifts(def.id) && Math.abs(eph.jd - lastJd.current) > period / 8);
    if (stale) {
      lastJd.current = eph.jd;
      const pts = eph.orbitPath(def.id, SEGMENTS);
      // Segment k runs from sample k to k + 1: [startXYZ, endXYZ] interleaved, in place.
      const attr = l.geometry.attributes.instanceStart as InterleavedBufferAttribute;
      const arr = attr.data.array as Float32Array;
      for (let k = 0; k < SEGMENTS; k++) {
        for (let j = 0; j < 2; j++) {
          const p = (k + j) * 3;
          const o = k * 6 + j * 3;
          arr[o] = pts[p]! * UNITS_PER_KM;
          arr[o + 1] = pts[p + 2]! * UNITS_PER_KM;
          arr[o + 2] = -pts[p + 1]! * UNITS_PER_KM;
        }
      }
      attr.data.needsUpdate = true;
      l.geometry.computeBoundingSphere();
    }
  }, PRIORITY_SCENE);

  return <primitive ref={ref} object={line} frustumCulled={false} />;
}
