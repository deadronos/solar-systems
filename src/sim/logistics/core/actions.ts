import { spawnEntrant } from '../economy/companies.ts';
import { expireContract } from '../economy/contracts.ts';
import { arrive, deliverShip, depart } from './commands.ts';
import type { LogisticsWorld } from './world.ts';

/** Data queued by the economy for a future tick. */
export type ScheduledAction =
  | { kind: 'depart'; shipId: string }
  | { kind: 'arrive'; shipId: string }
  | { kind: 'expireContract'; contractId: string }
  | { kind: 'deliverShip'; shipId: string; siteId: string }
  | { kind: 'spawnEntrant' };

export function dispatchAction(world: LogisticsWorld, action: ScheduledAction): void {
  switch (action.kind) {
    case 'depart':
      return depart(world, action.shipId);
    case 'arrive':
      return arrive(world, action.shipId);
    case 'expireContract':
      return expireContract(world, action.contractId);
    case 'deliverShip':
      return deliverShip(world, action.shipId, action.siteId);
    case 'spawnEntrant':
      spawnEntrant(world);
      return;
  }
}
