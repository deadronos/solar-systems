import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Matrix4,
  Vector3,
  type Group,
  type PerspectiveCamera,
  type Sprite,
} from 'three';
import type { BodyDefinition } from '../../sim/index.ts';
import { focusBody } from '../../state/actions.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { appearanceFor } from '../appearance.ts';
import { eclipticDirToScene, pixelsPerUnit, relativeToScene, UNITS_PER_KM } from '../coords.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { glowTexture, surfaceTexture } from '../textures.ts';
import { Rings } from './Rings.tsx';
import { PRIORITY_SCENE } from './SimDriver.tsx';

const tmpPole = new Vector3();
const tmpNode = new Vector3();
const tmpNodeNormal = new Vector3();
const tmpMeridian = new Vector3();
const tmpThird = new Vector3();
const tmpBasis = new Matrix4();
const tmpParent = new Vector3();
const tmpNdc = new Vector3();

/** Labels of children closer than this (px) to their parent on screen are hidden. */
const LABEL_MIN_SEPARATION_PX = 16;

export function Body({ def }: { def: BodyDefinition }) {
  const sim = useSimulation();
  const frame = useRenderFrame();
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);

  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const glow = useRef<Sprite>(null);

  const look = appearanceFor(def.id);
  const texture = useMemo(() => surfaceTexture(def.id, look), [def.id, look]);
  const isStar = def.kind === 'star';
  const r = def.radiusKm * UNITS_PER_KM;
  const polar = 1 - (def.flattening ?? 0);

  useFrame(() => {
    const g = group.current;
    const b = body.current;
    if (!g || !b) return;
    const eph = sim.ephemeris;
    relativeToScene(eph.position(def.id), frame.origin, g.position);

    const o = eph.orientation(def.id);
    if (o) {
      // SphereGeometry puts the texture's centre (longitude 0) on local +X and the pole on +Y,
      // with east towards −Z. Map +X to the prime meridian, +Y to the pole, +Z to meridian × pole.
      const pole = eclipticDirToScene(o.pole, tmpPole);
      const node = eclipticDirToScene(o.node, tmpNode);
      const nodeNormal = tmpNodeNormal.crossVectors(pole, node);
      const meridian = tmpMeridian
        .copy(node)
        .multiplyScalar(Math.cos(o.angle))
        .addScaledVector(nodeNormal, Math.sin(o.angle));
      tmpThird.crossVectors(meridian, pole);
      b.quaternion.setFromRotationMatrix(tmpBasis.makeBasis(meridian, pole, tmpThird));
    }

    // Keep tiny bodies visible: never draw smaller than `minPixelRadius` on screen.
    const dist = camera.position.distanceTo(g.position);
    const ppu = pixelsPerUnit(camera, dist, size.height);
    const minPx = useViewStore.getState().minPixelRadius;
    const rPx = r * ppu;
    b.scale.setScalar(minPx > 0 && rPx < minPx ? minPx / rPx : 1);

    if (glow.current) glow.current.scale.setScalar(Math.max(r * 8, 40 / ppu));

    // Position this body's DOM label (rendered by <LabelOverlay>, outside the canvas).
    const el = frame.labels.get(def.id);
    if (el) {
      let visible = useViewStore.getState().layers.labels;
      tmpNdc.copy(g.position).project(camera);
      if (visible) visible = tmpNdc.z < 1 && Math.abs(tmpNdc.x) < 1.2 && Math.abs(tmpNdc.y) < 1.2;
      if (visible && def.parentId && def.parentId !== 'sun') {
        relativeToScene(eph.position(def.parentId), frame.origin, tmpParent);
        visible = tmpParent.distanceTo(g.position) * ppu > LABEL_MIN_SEPARATION_PX;
      }
      if (visible) {
        const x = (tmpNdc.x * 0.5 + 0.5) * size.width;
        const y = (-tmpNdc.y * 0.5 + 0.5) * size.height;
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        el.style.visibility = 'visible';
      } else {
        el.style.visibility = 'hidden';
      }
    }
  }, PRIORITY_SCENE);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    focusBody(def.id);
  };

  return (
    <group ref={group}>
      <group ref={body}>
        <mesh scale={[r, r * polar, r]} onClick={onClick}>
          <sphereGeometry args={[1, 64, 32]} />
          {isStar ? (
            <meshBasicMaterial map={texture} toneMapped={false} />
          ) : (
            <meshStandardMaterial map={texture} roughness={0.95} metalness={0} />
          )}
        </mesh>
        {look.rings && <Rings bodyId={def.id} style={look.rings} />}
      </group>
      {isStar && (
        <>
          <sprite ref={glow}>
            <spriteMaterial
              map={glowTexture()}
              blending={AdditiveBlending}
              depthWrite={false}
              transparent
              toneMapped={false}
            />
          </sprite>
          <pointLight intensity={2.2} decay={0} distance={0} />
        </>
      )}
    </group>
  );
}
