import type { Vec3 } from '../../math/vec3.ts';

export type HoldLabel = 'waiting' | 'ascent' | 'descent' | 'charging' | 'docking';

/** One segment of a trip. Times are Julian dates. */
export type Leg =
  | { kind: 'hold'; bodyId: string; t0: number; t1: number; label: HoldLabel }
  | {
      kind: 'conic';
      t0: number;
      t1: number;
      /** State at t0, relative to `centralBodyId` (null = Sun, heliocentric). km, km/s. */
      r0: Vec3;
      v0: Vec3;
      mu: number;
      centralBodyId: string | null;
    }
  | {
      kind: 'torch';
      t0: number;
      t1: number;
      from: Vec3;
      to: Vec3;
      accelKmS2: number;
      vMaxKmS: number;
    }
  | { kind: 'jump'; t0: number; t1: number; from: Vec3; to: Vec3 };

export interface TrajectoryPlan {
  classId: string;
  fromSiteId: string;
  toSiteId: string;
  departJd: number;
  arriveJd: number;
  legs: Leg[];
  deltaVKmS: number;
  fuelT: number;
  /** Credits for exotic fuel (tiers 4–5). */
  exoticCost: number;
}
