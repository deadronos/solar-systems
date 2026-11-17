import { useEffect, useMemo } from 'react';
import { DoubleSide, MeshStandardMaterial, RingGeometry } from 'three';
import type { RingStyle } from '../appearance.ts';
import { UNITS_PER_KM } from '../coords.ts';
import { ringTexture } from '../textures.ts';
import { type createBodyLighting, installBodyLighting } from './bodyLighting.ts';

/** Planetary rings in the body's equatorial plane (local XZ, perpendicular to the pole). */
export function Rings({
  bodyId,
  style,
  radius,
  lighting,
}: {
  bodyId: string;
  style: RingStyle;
  radius: number;
  lighting: ReturnType<typeof createBodyLighting>;
}) {
  const inner = style.innerKm * UNITS_PER_KM;
  const outer = style.outerKm * UNITS_PER_KM;

  const geometry = useMemo(() => {
    const g = new RingGeometry(inner, outer, 256, 1);
    // Remap UVs so u runs radially inner→outer (the texture is a 1D radial profile).
    const pos = g.attributes.position!;
    const uv = g.attributes.uv!;
    for (let i = 0; i < pos.count; i++) {
      const rr = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (rr - inner) / (outer - inner), 0.5);
    }
    g.rotateX(-Math.PI / 2);
    return g;
  }, [inner, outer]);

  const texture = useMemo(() => ringTexture(bodyId, style.color), [bodyId, style.color]);

  const material = useMemo(() => {
    const result = new MeshStandardMaterial({
      map: texture,
      side: DoubleSide,
      transparent: true,
      opacity: style.opacity,
      depthWrite: false,
      roughness: 1,
    });
    installBodyLighting(result, lighting, { ringSurfaceRadius: radius });
    return result;
  }, [texture, style.opacity, lighting, radius]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry}>
      <primitive object={material} attach="material" />
    </mesh>
  );
}
