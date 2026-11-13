import { J2000 } from '../constants.ts';
import { topologicalOrder } from '../data/catalog.ts';
import type { BodyDefinition } from '../data/types.ts';
import { equatorialToEcliptic, poleToEcliptic } from '../orbits/frames.ts';
import {
  perifocalToReference,
  positionAtEccentricAnomaly,
  positionFromElements,
  solveKepler,
} from '../orbits/kepler.ts';
import { elementRates, elementsAt, hasSecularRates, periodDays } from '../orbits/models.ts';
import { add, DEG, TAU, transform, vec3, type Mat3, type Vec3 } from '../math/vec3.ts';

export interface Orientation {
  /** Unit pole vector in the ecliptic frame. */
  pole: Vec3;
  /** Prime-meridian rotation angle about the pole (radians). */
  angle: number;
}

interface BodyRuntime {
  def: BodyDefinition;
  parent: BodyRuntime | null;
  children: BodyRuntime[];
  /** Heliocentric ecliptic J2000 position (km). */
  position: Vec3;
  /** Position relative to parent (km). */
  local: Vec3;
  /** Equator→ecliptic matrix for this body (used by its children). */
  equatorFrame: Mat3 | null;
  pole: Vec3 | null;
  spinPeriodDays: number | null;
  W0: number;
}

const scratch = vec3();

/**
 * Computes positions of a hierarchy of bodies at a given Julian date.
 * Pure: no rendering, no wall-clock. Call `update(jd)` once per frame and read positions.
 */
export class Ephemeris {
  readonly bodies: readonly BodyDefinition[];
  #runtimes: BodyRuntime[];
  #byId = new Map<string, BodyRuntime>();
  #jd = Number.NaN;

  constructor(catalog: readonly BodyDefinition[]) {
    this.bodies = topologicalOrder(catalog);
    this.#runtimes = this.bodies.map((def) => {
      const parent = def.parentId === null ? null : (this.#byId.get(def.parentId) ?? null);
      const rt: BodyRuntime = {
        def,
        parent,
        children: [],
        position: vec3(),
        local: vec3(),
        equatorFrame: null,
        pole: null,
        spinPeriodDays: null,
        W0: 0,
      };
      parent?.children.push(rt);
      this.#byId.set(def.id, rt);
      return rt;
    });
    // Resolve orientations (synchronous moons inherit their parent's pole).
    for (const rt of this.#runtimes) {
      const rot = rt.def.rotation;
      if (rot === 'synchronous') {
        rt.pole = rt.parent?.pole ?? vec3(0, 0, 1);
        rt.spinPeriodDays = rt.def.orbit ? periodDays(rt.def.orbit) : null;
      } else if (rot) {
        rt.pole = poleToEcliptic(rot.poleRaDeg, rot.poleDecDeg);
        rt.spinPeriodDays = rot.periodHours / 24;
        rt.W0 = (rot.W0Deg ?? 0) * DEG;
      }
      rt.equatorFrame = rt.pole ? equatorialToEcliptic(rt.pole) : null;
    }
  }

  get jd(): number {
    return this.#jd;
  }

  update(jd: number): void {
    this.#jd = jd;
    for (const rt of this.#runtimes) {
      const { def, parent } = rt;
      if (!def.orbit || !parent) {
        rt.local.x = rt.local.y = rt.local.z = 0;
        rt.position.x = rt.position.y = rt.position.z = 0;
        continue;
      }
      positionFromElements(elementsAt(def.orbit, jd), rt.local);
      if (def.orbitFrame === 'parentEquator' && parent.equatorFrame) {
        transform(rt.local, parent.equatorFrame, rt.local);
      }
      add(rt.position, parent.position, rt.local);
    }
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  get(id: string): BodyDefinition {
    return this.#rt(id).def;
  }

  /** Heliocentric ecliptic J2000 position in km. The returned object is live; copy to keep. */
  position(id: string): Readonly<Vec3> {
    return this.#rt(id).position;
  }

  /**
   * Heliocentric position at an arbitrary date, without touching the cached state that
   * `update()` maintains. Used for planning (km, ecliptic J2000).
   */
  positionAt(id: string, jd: number, out: Vec3): Vec3 {
    const rt = this.#rt(id);
    const { def, parent } = rt;
    if (!def.orbit || !parent) {
      out.x = out.y = out.z = 0;
      return out;
    }
    const local = positionFromElements(elementsAt(def.orbit, jd), vec3());
    if (def.orbitFrame === 'parentEquator' && parent.equatorFrame) {
      transform(local, parent.equatorFrame, local);
    }
    this.positionAt(parent.def.id, jd, out);
    return add(out, out, local);
  }

  /**
   * Heliocentric position (km) and velocity (km/s) of a body that orbits the Sun directly,
   * from one Kepler solve: the exact time derivative of the orbit model (Keplerian motion
   * plus the secular drift of every element). Returns false for other bodies.
   */
  helioStateAt(id: string, jd: number, pos: Vec3, vel: Vec3): boolean {
    const { def, parent } = this.#rt(id);
    if (!def.orbit || !parent || parent.parent !== null || def.orbitFrame === 'parentEquator') {
      return false;
    }
    const el = elementsAt(def.orbit, jd);
    const r = elementRates(def.orbit);
    const { a, e, i, Omega, omega } = el;
    const E = solveKepler(el.M, e);
    positionAtEccentricAnomaly(el, E, pos);
    const sinE = Math.sin(E);
    const cosE = Math.cos(E);
    const q = Math.sqrt(1 - e * e);
    const Ee = sinE / (1 - e * cosE); // ∂E/∂e at fixed M
    const Edot = r.n / (1 - e * cosE);
    // In-plane rate: Kepler motion plus the change of shape (ė); all per day.
    const xd = -a * sinE * Edot + r.eDot * a * (-sinE * Ee - 1);
    const yd = a * q * cosE * Edot + r.eDot * a * ((-e / q) * sinE + q * cosE * Ee);
    perifocalToReference(xd, yd, i, Omega, omega, vel);
    // Rotations of the orbit: node about the ecliptic pole, inclination about the line of
    // nodes, periapsis about the orbit normal; plus ȧ scaling.
    const si = Math.sin(i);
    const nx = Math.cos(Omega);
    const ny = Math.sin(Omega);
    const hx = si * ny;
    const hy = -si * nx;
    const hz = Math.cos(i);
    const { OmegaDot: Od, omegaDot: wd, iDot, aDot } = r;
    const s = aDot / a;
    vel.x += wd * (hy * pos.z - hz * pos.y) - Od * pos.y + iDot * (ny * pos.z) + s * pos.x;
    vel.y += wd * (hz * pos.x - hx * pos.z) + Od * pos.x - iDot * (nx * pos.z) + s * pos.y;
    vel.z += wd * (hx * pos.y - hy * pos.x) + iDot * (nx * pos.y - ny * pos.x) + s * pos.z;
    vel.x /= 86_400;
    vel.y /= 86_400;
    vel.z /= 86_400;
    return true;
  }

  /** Position relative to the parent body, in km. Live object. */
  localPosition(id: string): Readonly<Vec3> {
    return this.#rt(id).local;
  }

  children(id: string): readonly BodyDefinition[] {
    return this.#rt(id).children.map((c) => c.def);
  }

  orientation(id: string, jd = this.#jd): Orientation | null {
    const rt = this.#rt(id);
    if (!rt.pole || !rt.spinPeriodDays) return null;
    const turns = (jd - J2000) / rt.spinPeriodDays;
    return { pole: rt.pole, angle: rt.W0 + (turns - Math.floor(turns)) * TAU };
  }

  orbitalPeriodDays(id: string): number | null {
    const orbit = this.#rt(id).def.orbit;
    return orbit ? periodDays(orbit) : null;
  }

  semiMajorAxisKm(id: string, jd = this.#jd): number {
    const orbit = this.#rt(id).def.orbit;
    return orbit ? elementsAt(orbit, jd).a : 0;
  }

  orbitDrifts(id: string): boolean {
    const orbit = this.#rt(id).def.orbit;
    return orbit ? hasSecularRates(orbit) : false;
  }

  /**
   * Sample the full orbit ellipse relative to the parent (km, ecliptic frame) at `jd`.
   * Sampled uniformly in eccentric anomaly so eccentric orbits stay smooth near periapsis.
   * Returns `segments + 1` points (closed loop) as xyz triplets.
   */
  orbitPath(id: string, segments = 256, jd = this.#jd): Float64Array {
    const rt = this.#rt(id);
    const out = new Float64Array((segments + 1) * 3);
    if (!rt.def.orbit) return out;
    const el = elementsAt(rt.def.orbit, jd);
    const frame = rt.def.orbitFrame === 'parentEquator' ? (rt.parent?.equatorFrame ?? null) : null;
    for (let k = 0; k <= segments; k++) {
      positionAtEccentricAnomaly(el, (k / segments) * TAU, scratch);
      if (frame) transform(scratch, frame, scratch);
      out[k * 3] = scratch.x;
      out[k * 3 + 1] = scratch.y;
      out[k * 3 + 2] = scratch.z;
    }
    return out;
  }

  #rt(id: string): BodyRuntime {
    const rt = this.#byId.get(id);
    if (!rt) throw new Error(`Unknown body "${id}"`);
    return rt;
  }
}
