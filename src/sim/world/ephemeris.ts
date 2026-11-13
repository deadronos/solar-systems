import { J2000 } from '../constants.ts';
import { topologicalOrder } from '../data/catalog.ts';
import type { BodyDefinition } from '../data/types.ts';
import { equatorialToEcliptic, iauNode, poleToEcliptic } from '../orbits/frames.ts';
import {
  perifocalToReference,
  positionAtEccentricAnomaly,
  positionFromElements,
  solveKepler,
} from '../orbits/kepler.ts';
import { elementRates, elementsAt, hasSecularRates, periodDays } from '../orbits/models.ts';
import { add, cross, DEG, TAU, transform, vec3, type Mat3, type Vec3 } from '../math/vec3.ts';

export interface Orientation {
  /** Unit pole vector in the ecliptic frame. */
  pole: Vec3;
  /**
   * Unit reference axis in the equator plane that `angle` is measured from: IAU's ascending
   * node of the body's equator on the ICRF equator (`iauNode`), so `W0Deg` keeps its meaning.
   */
  node: Vec3;
  /**
   * Prime-meridian angle about the pole (radians), from `node` towards `pole × node`. For a
   * synchronous moon the prime meridian points at its parent (sub-parent point at 0° longitude).
   */
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
  /** Equator-plane axes for the meridian angle: `iauNode(pole)` and `pole × node`. */
  node: Vec3 | null;
  nodeNormal: Vec3 | null;
  spinPeriodDays: number | null;
  W0: number;
  /** Moon whose barycenter with this body `def.orbit` describes, and its mass fraction μ. */
  partner: BodyRuntime | null;
  partnerMassRatio: number;
  /** Orbiting ancestors from the root down, ending with this body (for `positionAt`). */
  chain: BodyRuntime[];
}

const scratch = vec3();
const partnerScratch = vec3();
const orientScratch = vec3();
const localScratch = vec3();
const partnerA = vec3();
const partnerB = vec3();
/** Half-step (days) for the partner's finite-difference velocity in `helioStateAt`. */
const PARTNER_FD_DAYS = 0.01;

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
        node: null,
        nodeNormal: null,
        spinPeriodDays: null,
        W0: 0,
        partner: null,
        partnerMassRatio: 0,
        chain: [],
      };
      if (def.orbit && parent) rt.chain = [...parent.chain, rt];
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
      const f = rt.pole ? equatorialToEcliptic(rt.pole) : null;
      rt.equatorFrame = f;
      rt.node = rt.pole ? iauNode(rt.pole) : null;
      rt.nodeNormal = rt.pole && rt.node ? cross(vec3(), rt.pole, rt.node) : null;
    }
    for (const rt of this.#runtimes) {
      const partnerId = rt.def.barycentricPartner;
      if (partnerId === undefined) continue;
      const partner = rt.children.find((c) => c.def.id === partnerId);
      const gm = rt.def.gm;
      const gmPartner = partner?.def.gm;
      if (!partner?.def.orbit || partner.def.barycentricPartner || !gm || !gmPartner) {
        throw new Error(
          `Body "${rt.def.id}": barycentricPartner "${partnerId}" must be an orbiting child, and both need gm`,
        );
      }
      rt.partner = partner;
      rt.partnerMassRatio = gmPartner / (gm + gmPartner);
    }
  }

  /**
   * Position relative to the parent (km, ecliptic) at `jd`, including the barycentric offset
   * for a body with a partner. Writes `out` only.
   */
  #localAt(rt: BodyRuntime, jd: number, out: Vec3): Vec3 {
    const { def, parent } = rt;
    positionFromElements(elementsAt(def.orbit!, jd), out);
    if (def.orbitFrame === 'parentEquator' && parent?.equatorFrame) {
      transform(out, parent.equatorFrame, out);
    }
    if (rt.partner) {
      const p = this.#localAt(rt.partner, jd, partnerScratch);
      const mu = rt.partnerMassRatio;
      out.x -= mu * p.x;
      out.y -= mu * p.y;
      out.z -= mu * p.z;
    }
    return out;
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
      this.#localAt(rt, jd, rt.local);
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
    // Sum the local offsets from the root down: the same order (and bits) as `update`.
    out.x = out.y = out.z = 0;
    for (const rt of this.#rt(id).chain) add(out, out, this.#localAt(rt, jd, localScratch));
    return out;
  }

  /**
   * Heliocentric position (km) and velocity (km/s) of a body that orbits the Sun directly,
   * from one Kepler solve: the exact time derivative of the orbit model (Keplerian motion
   * plus the secular drift of every element). Returns false for other bodies.
   */
  helioStateAt(id: string, jd: number, pos: Vec3, vel: Vec3): boolean {
    const rt = this.#rt(id);
    const { def, parent } = rt;
    if (!def.orbit || !parent || parent.parent !== null || def.orbitFrame === 'parentEquator') {
      return false;
    }
    const el = elementsAt(def.orbit, jd);
    const r = elementRates(def.orbit, jd);
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
    if (rt.partner) {
      // Barycentric offset: −μ·r_partner, and −μ·v_partner by central difference (the
      // partner's velocity is ~1 km/s, so the difference error is far below 1 mm/s).
      const mu = rt.partnerMassRatio;
      const p = this.#localAt(rt.partner, jd, partnerScratch);
      pos.x -= mu * p.x;
      pos.y -= mu * p.y;
      pos.z -= mu * p.z;
      const before = this.#localAt(rt.partner, jd - PARTNER_FD_DAYS, partnerA);
      const after = this.#localAt(rt.partner, jd + PARTNER_FD_DAYS, partnerB);
      const k = mu / ((jd + PARTNER_FD_DAYS - (jd - PARTNER_FD_DAYS)) * 86_400);
      vel.x -= k * (after.x - before.x);
      vel.y -= k * (after.y - before.y);
      vel.z -= k * (after.z - before.z);
    }
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
    const { pole, node, nodeNormal } = rt;
    if (!pole || !node || !nodeNormal || !rt.spinPeriodDays) return null;
    if (rt.def.rotation === 'synchronous' && rt.def.orbit && rt.parent) {
      // Face the parent: the angle of the direction to it, projected on the equator plane.
      // Eccentricity and inclination then show up as libration.
      const toParent = this.#localAt(rt, jd, orientScratch);
      const x = -(toParent.x * node.x + toParent.y * node.y + toParent.z * node.z);
      const y = -(
        toParent.x * nodeNormal.x +
        toParent.y * nodeNormal.y +
        toParent.z * nodeNormal.z
      );
      return { pole, node, angle: Math.atan2(y, x) };
    }
    const turns = (jd - J2000) / rt.spinPeriodDays;
    return { pole, node, angle: rt.W0 + (turns - Math.floor(turns)) * TAU };
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
