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
  | { kind: 'contractPosted'; contractId: string }
  | { kind: 'periodic' }
  | { kind: 'fleetReview' };

/** Read-only, company-scoped window on the world. The only mutation is a ship's intent text. */
export interface CompanyView {
  readonly jd: number;
  readonly company: Readonly<Company>;
  readonly personality: Personality;
  ships(): readonly Readonly<Ship>[];
  settlements(): readonly Readonly<Settlement>[];
  settlement(id: string): Readonly<Settlement> | undefined;
  openContracts(): readonly Readonly<Contract>[];
  contract(id: string): Readonly<Contract> | undefined;
  shipClass(id: string): ShipClass;
  shipClasses(): readonly ShipClass[];
  market(settlementId: string, good: GoodId): Readonly<MarketEntry>;
  ask(settlementId: string, good: GoodId): number;
  /** Price the settlement would pay for `qty`; 0 if it won't buy. */
  bid(settlementId: string, good: GoodId, qty: number): number;
  /** Tonnes the settlement will still buy. */
  demandRoom(settlementId: string, good: GoodId): number;
  estimateTrip(shipId: string, fromSiteId: string, toSiteId: string): TripEstimate | null;
  /** Heliocentric distance of a settlement from the Sun (AU). */
  distanceFromSunAU(settlementId: string): number;
  setIntent(shipId: string, text: string): void;
}

export interface CompanyController {
  decide(view: CompanyView, wake: WakeReason[]): Command[];
}
