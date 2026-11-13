import type { LogisticsWorld } from '../core/world.ts';
import type { Company, Settlement, Ship } from './types.ts';

/**
 * Money accounting (#11). Money inside the economy is company cash plus colony treasuries.
 * Every payment between those accounts goes through the helpers below, so money is conserved
 * except on the ledger lines, where it enters or leaves the economy:
 *
 * - `stipend`: the Earth charter stipend to colonies.
 * - `charter`: the Earth charter's bounty to colonies on exports sold to Earth.
 * - `earth`: trade with a deep market (Earth Exchange): it is outside the economy, so what
 *   it pays in is a source and what it takes out is a sink.
 * - `shipyard`: the Earth-made share of ship purchases (sink), and resale (source).
 * - `entrants`: seed capital of new companies.
 */
export const LEDGER_LINES = ['stipend', 'charter', 'earth', 'shipyard', 'entrants'] as const;
export type LedgerLine = (typeof LEDGER_LINES)[number];
/** Net money each line has brought into the economy since the start (negative: taken out). */
export type Ledger = Record<LedgerLine, number>;

export const emptyLedger = (): Ledger => ({
  stipend: 0,
  charter: 0,
  earth: 0,
  shipyard: 0,
  entrants: 0,
});

/** Record money entering (`amount > 0`) or leaving the economy on a ledger line. */
export function external(world: LogisticsWorld, line: LedgerLine, amount: number): void {
  world.ledger[line] += amount;
}

/**
 * Add `amount` (negative to take) to a settlement's treasury. A deep market's treasury is
 * infinite and outside the economy, so the flow is booked on the `earth` line instead.
 */
export function creditSettlement(world: LogisticsWorld, s: Settlement, amount: number): void {
  if (s.isDeepMarket) {
    world.ledger.earth -= amount;
    return;
  }
  s.treasury += amount;
}

/** Take `amount` from a company (allowed to go negative: distress) and pay it to `to`. */
export function companyPays(
  world: LogisticsWorld,
  company: Company,
  ship: Ship | null,
  to: Settlement,
  amount: number,
): void {
  company.cash -= amount;
  company.stats.costs += amount;
  if (ship) ship.stats.costs += amount;
  creditSettlement(world, to, amount);
}

/**
 * A company buys a ship at `yard`: the yard's share of the price is local wages and work,
 * and the rest pays for Earth-made parts, leaving the economy.
 */
export function buyShip(
  world: LogisticsWorld,
  company: Company,
  yard: Settlement,
  price: number,
): void {
  const local = price * world.constants.ships.shipyardShare;
  companyPays(world, company, null, yard, local);
  company.cash -= price - local;
  company.stats.costs += price - local;
  external(world, 'shipyard', -(price - local));
}

/** Money held inside the economy: all company cash plus every finite treasury. */
export function moneySupply(world: LogisticsWorld): number {
  let total = 0;
  for (const c of world.companies.values()) total += c.cash;
  for (const s of world.settlements.values()) if (!s.isDeepMarket) total += s.treasury;
  return total;
}

/** Net money all ledger lines have brought in; equals the change in `moneySupply`. */
export function ledgerTotal(ledger: Ledger): number {
  let total = 0;
  for (const line of LEDGER_LINES) total += ledger[line];
  return total;
}
