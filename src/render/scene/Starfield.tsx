import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, type Points } from 'three';
import { useViewStore } from '../../state/viewStore.ts';

const COUNT = 9_000;
const RADIUS = 5e6; // far beyond the solar system, inside the camera far plane

/** Background stars on a sphere that follows the camera (effectively at infinity). */
export function Starfield() {
  const ref = useRef<Points>(null);
  const visible = useViewStore((s) => s.layers.stars);

  const geometry = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    let seed = 42;
    const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    for (let i = 0; i < COUNT; i++) {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos.set([RADIUS * s * Math.cos(t), RADIUS * u, RADIUS * s * Math.sin(t)], i * 3);
      // Magnitude-like distribution: most stars faint, a few bright; slight colour temperature.
      const b = 0.25 + rnd() ** 6 * 0.75;
      const warm = rnd();
      col.set([b * (0.85 + warm * 0.15), b * 0.9, b * (1 - warm * 0.2)], i * 3);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    return g;
  }, []);

  useFrame(({ camera }) => {
    ref.current?.position.copy(camera.position);
  });

  return (
    <points ref={ref} geometry={geometry} visible={visible} frustumCulled={false}>
      <pointsMaterial size={1.4} sizeAttenuation={false} vertexColors depthWrite={false} />
    </points>
  );
}
