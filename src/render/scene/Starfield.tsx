import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  ShaderMaterial,
  type Group,
} from 'three';
import { useViewStore } from '../../state/viewStore.ts';
import { decodeBrightStars, milkyWayPoints } from '../stars.ts';

const RADIUS = 5e6; // far beyond the solar system, inside the camera far plane
const MILKY_WAY_POINTS = 40_000;
/** Shared by both materials and set each frame: point sizes are in device pixels. */
const pixelRatio = { value: 1 };

/** Ecliptic unit directions → scene positions on the sky sphere (y-up axis swap). */
function skyPositions(dir: Float32Array): Float32Array {
  const pos = new Float32Array(dir.length);
  for (let i = 0; i < dir.length; i += 3) {
    pos[i] = dir[i]! * RADIUS;
    pos[i + 1] = dir[i + 2]! * RADIUS;
    pos[i + 2] = -dir[i + 1]! * RADIUS;
  }
  return pos;
}

const LOGDEPTH_VERTEX = '#include <common>\n#include <logdepthbuf_pars_vertex>';

/** Point sizes from magnitude (brighter = larger), round soft discs, B−V tints. */
const STAR_VERTEX = `${LOGDEPTH_VERTEX}
attribute float aMag;
attribute vec3 aColor;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = clamp( 1.5 - 0.12 * aMag, 0.55, 1.0 );
  gl_PointSize = clamp( 7.0 * pow( 10.0, -0.18 * ( aMag + 1.0 ) ), 1.8, 8.0 ) * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  #include <logdepthbuf_vertex>
}`;

const STAR_FRAGMENT = `#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float a = smoothstep( 1.0, 0.25, d ) * vAlpha;
  if ( a <= 0.0 ) discard;
  gl_FragColor = vec4( vColor, a );
}`;

/** Faint additive glow for the Milky Way cloud. */
const GLOW_VERTEX = `${LOGDEPTH_VERTEX}
attribute float aWeight;
uniform float uPixelRatio;
varying float vWeight;
void main() {
  vWeight = aWeight;
  gl_PointSize = 14.0 * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  #include <logdepthbuf_vertex>
}`;

const GLOW_FRAGMENT = `#include <common>
#include <logdepthbuf_pars_fragment>
varying float vWeight;
void main() {
  #include <logdepthbuf_fragment>
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float a = ( 1.0 - smoothstep( 0.0, 1.0, d ) ) * vWeight * 0.045;
  gl_FragColor = vec4( vec3( 0.78, 0.8, 0.92 ) * a, 1.0 );
}`;

/**
 * The real sky: the ~9,100 stars of the Yale Bright Star Catalogue (to V ≈ 6.5), sized by
 * magnitude and tinted by B−V, over a faint procedural Milky Way. The sphere follows the
 * camera, so it is effectively at infinity.
 */
export function Starfield() {
  const ref = useRef<Group>(null);
  const visible = useViewStore((s) => s.layers.stars);
  const gl = useThree((s) => s.gl);

  const { stars, glow } = useMemo(() => {
    const catalog = decodeBrightStars();
    const starGeometry = new BufferGeometry();
    starGeometry.setAttribute('position', new BufferAttribute(skyPositions(catalog.dir), 3));
    starGeometry.setAttribute('aMag', new BufferAttribute(catalog.mag, 1));
    starGeometry.setAttribute('aColor', new BufferAttribute(catalog.color, 3));
    const starMaterial = new ShaderMaterial({
      uniforms: { uPixelRatio: pixelRatio },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });

    const milkyWay = milkyWayPoints(MILKY_WAY_POINTS);
    const glowGeometry = new BufferGeometry();
    glowGeometry.setAttribute('position', new BufferAttribute(skyPositions(milkyWay.dir), 3));
    glowGeometry.setAttribute('aWeight', new BufferAttribute(milkyWay.weight, 1));
    const glowMaterial = new ShaderMaterial({
      uniforms: { uPixelRatio: pixelRatio },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return {
      stars: { geometry: starGeometry, material: starMaterial },
      glow: { geometry: glowGeometry, material: glowMaterial },
    };
  }, []);

  useEffect(
    () => () => {
      for (const part of [stars, glow]) {
        part.geometry.dispose();
        part.material.dispose();
      }
    },
    [stars, glow],
  );

  useFrame(({ camera }) => {
    ref.current?.position.copy(camera.position);
    pixelRatio.value = gl.getPixelRatio();
  });

  return (
    <group ref={ref} visible={visible}>
      <points
        geometry={glow.geometry}
        material={glow.material}
        frustumCulled={false}
        renderOrder={-2}
      />
      <points
        geometry={stars.geometry}
        material={stars.material}
        frustumCulled={false}
        renderOrder={-1}
      />
    </group>
  );
}
