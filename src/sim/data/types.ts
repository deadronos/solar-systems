import type { OrbitModel } from '../orbits/models.ts';

export type BodyKind = 'star' | 'planet' | 'dwarf-planet' | 'moon' | 'asteroid';

/**
 * Rotation pole + spin. The pole is the *positive* pole (right-hand rule w.r.t. spin), so
 * `periodHours` is always positive. For Venus/Uranus/Pluto this is the IAU "south" pole.
 */
export interface RotationModel {
  poleRaDeg: number;
  poleDecDeg: number;
  periodHours: number;
  /** Prime meridian angle at J2000 (deg). */
  W0Deg?: number;
}

export type OrbitFrame =
  /** Elements referenced to the J2000 ecliptic. */
  | 'ecliptic'
  /** Elements referenced to the parent body's equator (most regular moons). */
  | 'parentEquator';

export interface BodyDefinition {
  id: string;
  name: string;
  kind: BodyKind;
  parentId: string | null;
  /** Mean (volumetric) radius in km. */
  radiusKm: number;
  /** Polar flattening f = (a − c) / a. */
  flattening?: number;
  /** GM in km³/s² (optional, informational). */
  gm?: number;
  orbit?: OrbitModel;
  orbitFrame?: OrbitFrame;
  /** Explicit spin, or 'synchronous' for tidally locked moons (pole = parent pole). */
  rotation?: RotationModel | 'synchronous';
}
