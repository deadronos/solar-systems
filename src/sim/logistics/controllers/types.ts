import type { Command } from '../core/commands.ts';
import type {
  Company,
  Contract,
  GoodId,
  MarketEntry,
  Personality,
  Settlement,
  Ship,
  ShipClass,
} from '../economy/types.ts';
import type { TripEstimate } from '../navigation/planner.ts';

export type WakeReason =
  | { kind: 'shipIdle'; shipId: string }
  | { kind: 'shipArrived'; shipId: string }
  | { kind: 'periodic' }
  | { kind: 'fleetReview' };

export type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

/** Read-only, company-scoped data for a single controller decision. */
export interface CompanyView {
  readonly jd: number;
  readonly dockingFee: number;
  readonly company: DeepReadonly<Company>;
  readonly personality: DeepReadonly<Personality>;
  ships(): readonly DeepReadonly<Ship>[];
  settlements(): readonly DeepReadonly<Settlement>[];
  settlement(id: string): DeepReadonly<Settlement> | undefined;
  openContracts(): readonly DeepReadonly<Contract>[];
  contract(id: string): DeepReadonly<Contract> | undefined;
  shipClass(id: string): Readonly<ShipClass>;
  shipClasses(): readonly Readonly<ShipClass>[];
  market(settlementId: string, good: GoodId): DeepReadonly<MarketEntry>;
  ask(settlementId: string, good: GoodId): number;
  /** Price the settlement would pay for `qty`; 0 if it won't buy. */
  bid(settlementId: string, good: GoodId, qty: number): number;
  /** Tonnes the settlement will still buy. */
  demandRoom(settlementId: string, good: GoodId): number;
  estimateTrip(shipId: string, fromSiteId: string, toSiteId: string): Readonly<TripEstimate> | null;
  /** Effective fuel price per tonne for `qty` at a site (emergency premium when the depot is dry). */
  fuelPrice(siteId: string, qty: number): number;
  /** Heliocentric distance of a settlement from the Sun (AU). */
  distanceFromSunAU(settlementId: string): number;
}

export interface CompanyController {
  decide(view: CompanyView, wake: WakeReason[]): Command[];
}
