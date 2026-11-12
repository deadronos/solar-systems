import { Canvas } from '@react-three/fiber';
import { ACESFilmicToneMapping } from 'three';
import { appearanceFor } from '../appearance.ts';
import { useSimulation } from '../SimulationContext.tsx';
import { BeltPoints } from './BeltPoints.tsx';
import { Body } from './Body.tsx';
import { CameraRig } from './CameraRig.tsx';
import { OrbitPath } from './OrbitPath.tsx';
import { SimDriver } from './SimDriver.tsx';
import { Starfield } from './Starfield.tsx';

function SceneContents() {
  const sim = useSimulation();
  const bodies = sim.ephemeris.bodies;
  return (
    <>
      <SimDriver />
      <CameraRig />
      <ambientLight intensity={0.035} />
      <Starfield />
      {bodies.map((def) => (
        <Body key={def.id} def={def} />
      ))}
      {bodies
        .filter((def) => def.orbit)
        .map((def) => (
          <OrbitPath key={`orbit-${def.id}`} def={def} color={appearanceFor(def.id).color} />
        ))}
      {sim.belts.map((belt) => (
        <BeltPoints key={belt.def.id} belt={belt} />
      ))}
    </>
  );
}

/** The R3F canvas. Contexts (simulation) are bridged into the R3F tree automatically in v9. */
export function SolarSystemScene() {
  return (
    <Canvas
      className="scene"
      dpr={[1, 2]}
      gl={{ logarithmicDepthBuffer: true, antialias: true, toneMapping: ACESFilmicToneMapping }}
      camera={{ fov: 45, near: 1e-7, far: 1e8, position: [0, 220, 420] }}
    >
      <color attach="background" args={['#020308']} />
      <SceneContents />
    </Canvas>
  );
}
