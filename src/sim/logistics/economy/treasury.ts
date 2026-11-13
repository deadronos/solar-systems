import type { Contract, Settlement } from './types.ts';

/**
 * Settlement treasury bookkeeping. Money promised to a live contract is `committed`: it
 * stays in the treasury until paid out, but no other purchase or order may spend it, so
 * paying every promise can never drive the treasury negative.
 */

/** Treasury not promised to any contract (≥ 0). Infinite for deep markets. */
export const availableFunds = (s: Settlement): number => Math.max(0, s.treasury - s.committed);

/** Promise `amount` of the treasury (call when posting a contract). */
export function commit(s: Settlement, amount: number): void {
  s.committed += amount;
}

/** Release a promise without paying it (expiry, carrier lost) or after paying it. */
export function release(s: Settlement, amount: number): void {
  s.committed = Math.max(0, s.committed - amount);
}

/**
 * What a buyer still owes on a contract: the reward, plus freight escrow until the goods
 * are loaded (escrow is paid to the pickup at loading).
 */
export const outstanding = (c: Contract): number =>
  c.reward + (c.kind === 'freight' && c.status !== 'loaded' ? c.escrowCost : 0);
