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
  /**
   * GM in km³/s². The trip planner needs it for every body a settlement sits on or orbits
   * (surface Δv, planet-centred transfers); bodies without it count as massless.
   */
  gm?: number;
  orbit?: OrbitModel;
  orbitFrame?: OrbitFrame;
  /** Explicit spin, or 'synchronous' for tidally locked moons (pole = parent pole). */
  rotation?: RotationModel | 'synchronous';
  /**
   * Child (moon) that this body's `orbit` is the barycenter with: JPL's "Earth" elements
   * describe the Earth–Moon barycenter. The ephemeris offsets this body by `−μ·r_partner`,
   * with `μ = GM_partner / (GM + GM_partner)`, so both bodies need `gm`. The partner's own
   * orbit stays relative to this body's centre.
   */
  barycentricPartner?: string;
}
