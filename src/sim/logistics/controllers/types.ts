import type { Command } from '../core/commands.ts';
import type {
  Company,
  Contract,
  EconomyConstants,
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
  readonly ai: Readonly<EconomyConstants['ai']>;
  readonly sourceReserveFraction: number;
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
  /**
   * Unit price to buy `qty` tonnes here (default 0: the first tonne). Large orders walk up
   * the price curve, so they pay more per tonne (see `quoteBuy`).
   */
  ask(settlementId: string, good: GoodId, qty?: number): number;
  /**
   * Unit price the settlement would pay for `qty`; 0 if it won't buy. Large orders walk down
   * the price curve. With `incomingT`, the price once that many more tonnes have landed
   * first (see `quoteSell`).
   */
  bid(settlementId: string, good: GoodId, qty: number, incomingT?: number): number;
  /**
   * Tonnes of a good aboard other companies' ships bound for a settlement (in transit or
   * waiting to depart): public tracking data, like real-world AIS. Excludes own ships.
   */
  inbound(settlementId: string, good: GoodId): number;
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
