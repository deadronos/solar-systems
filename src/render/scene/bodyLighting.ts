import {
  Color,
  ShaderChunk,
  ShaderMaterial,
  Vector3,
  Vector4,
  type MeshStandardMaterial,
  type Texture,
} from 'three';
import type { AtmosphereStyle } from '../appearance.ts';

type Lighting = {
  sun: { value: Vector3 };
  polar: { value: number };
  moons: { value: Vector4[] };
};

export function createBodyLighting(polar: number, moonCount: number): Lighting {
  return {
    sun: { value: new Vector3(1, 0, 0) },
    polar: { value: polar },
    moons: { value: Array.from({ length: moonCount }, () => new Vector4()) },
  };
}

type RingShadow = { inner: number; outer: number; opacity: number; texture: Texture };

export function installBodyLighting(
  material: MeshStandardMaterial,
  lighting: Lighting,
  options: { ring?: RingShadow; ringSurfaceRadius?: number; nightLights?: boolean },
) {
  const { ring, ringSurfaceRadius, nightLights } = options;
  const moonCount = lighting.moons.value.length;
  const hasShadow = !!(ring || ringSurfaceRadius || moonCount);
  material.customProgramCacheKey = () =>
    `body-lighting:${!!ring}:${!!ringSurfaceRadius}:${!!nightLights}:${moonCount}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBodySun = lighting.sun;
    shader.uniforms.uBodyPolar = lighting.polar;
    if (moonCount) shader.uniforms.uBodyMoons = lighting.moons;
    if (ring) {
      shader.uniforms.uRingProfile = { value: ring.texture };
      shader.uniforms.uRingShape = { value: new Vector3(ring.inner, ring.outer, ring.opacity) };
    }
    shader.uniforms.uRingSurfaceRadius = { value: ringSurfaceRadius ?? 1 };

    // Distances here are in equatorial radii, independent of the floating origin
    // and the display scale used to keep distant bodies visible.
    shader.vertexShader =
      `uniform float uBodyPolar;
       uniform float uRingSurfaceRadius;
       varying vec3 vBodyPoint;\n` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vBodyPoint = ${ringSurfaceRadius ? 'position / uRingSurfaceRadius' : 'position * vec3(1.0, uBodyPolar, 1.0)'};`,
      );
    shader.fragmentShader =
      `uniform vec3 uBodySun;
       uniform float uBodyPolar;
       varying vec3 vBodyPoint;
       ${ring ? 'uniform sampler2D uRingProfile; uniform vec3 uRingShape;' : ''}
       ${moonCount ? `uniform vec4 uBodyMoons[${moonCount}];` : ''}
       ${
         hasShadow
           ? /* glsl */ `
       float bodySunVisibility() {
         float visibility = 1.0;
         ${
           ring
             ? /* glsl */ `
         if (abs(uBodySun.y) > 0.0001) {
           float t = -vBodyPoint.y / uBodySun.y;
           float ringRadius = length((vBodyPoint + t * uBodySun).xz);
           if (t > 0.0 && ringRadius > uRingShape.x && ringRadius < uRingShape.y) {
             float u = (ringRadius - uRingShape.x) / (uRingShape.y - uRingShape.x);
             visibility *= 1.0 - texture2D(uRingProfile, vec2(u, 0.5)).a * uRingShape.z;
           }
         }
         `
             : ''
         }
         ${
           ringSurfaceRadius
             ? /* glsl */ `
         vec3 stretch = vec3(1.0, 1.0 / uBodyPolar, 1.0);
         vec3 ray = normalize(uBodySun * stretch);
         vec3 origin = vBodyPoint * stretch;
         if (dot(origin, ray) < 0.0) {
           visibility *= smoothstep(0.985, 1.015, length(cross(origin, ray)));
         }
         `
             : ''
         }
         ${
           moonCount
             ? /* glsl */ `
         for (int i = 0; i < ${moonCount}; i++) {
           vec3 toMoon = uBodyMoons[i].xyz - vBodyPoint;
           float distanceAlongRay = dot(toMoon, uBodySun);
           if (distanceAlongRay > 0.0) {
             float radius = uBodyMoons[i].w;
             // Approximate the Sun's angular radius as seen from Jupiter.
             float penumbra = distanceAlongRay * 0.0009;
             float offset = length(cross(toMoon, uBodySun));
             visibility *= smoothstep(max(0.0, radius - penumbra), radius + penumbra, offset);
           }
         }
         `
             : ''
         }
         return visibility;
       }
       `
           : ''
       }
       ` + shader.fragmentShader;
    if (hasShadow) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        ShaderChunk.lights_fragment_begin.replace(
          'getPointLightInfo( pointLight, geometryPosition, directLight );',
          'getPointLightInfo( pointLight, geometryPosition, directLight );\n directLight.color *= bodySunVisibility();',
        ),
      );
    }
    if (nightLights) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         vec3 bodyNormal = normalize(vBodyPoint / vec3(1.0, uBodyPolar * uBodyPolar, 1.0));
         totalEmissiveRadiance *= 1.0 - smoothstep(-0.20, 0.03, dot(bodyNormal, uBodySun));`,
      );
    }
  };
}

export function createAtmosphereMaterial(style: AtmosphereStyle, lighting: Lighting) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSun: lighting.sun,
      uPolar: lighting.polar,
      uColor: { value: new Color(style.color) },
      uStrength: { value: style.strength },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocalNormal;
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vLocalNormal = normal;
        vViewNormal = normalMatrix * normal;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform float uPolar;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vLocalNormal;
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float cosine = max(0.0, dot(normalize(vViewNormal), normalize(vViewPosition)));
        float rim = pow(1.0 - cosine, 5.0) * smoothstep(0.0, 0.17, cosine);
        vec3 normal = normalize(vLocalNormal / vec3(1.0, uPolar, 1.0));
        float day = smoothstep(-0.28, 0.38, dot(normal, uSun));
        gl_FragColor = vec4(uColor, uStrength * rim * day);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}
