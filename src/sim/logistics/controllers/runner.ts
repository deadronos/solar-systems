import { TICK_DAYS } from '../core/time.ts';
import { sortedIds, type LogisticsWorld } from '../core/world.ts';
import { AiBrain } from './aiBrain.ts';
import { FLEET_REVIEW_DAYS } from './timing.ts';
import type { CompanyController, WakeReason } from './types.ts';
import { createCompanyView } from './view.ts';

/** Controllers are woken at least once per this many days. */
const PERIODIC_DAYS = 1;

/**
 * Wire controllers into the tick loop: collect wake reasons from events, then let each
 * company decide once per tick in id order. New companies get a controller from `factory`.
 */
export function installControllers(
  world: LogisticsWorld,
  factory: (companyId: string) => CompanyController = () => new AiBrain(),
): void {
  for (const id of sortedIds(world.companies)) world.setController(id, factory(id));
  const pending = new Map<string, WakeReason[]>();
  const push = (companyId: string, r: WakeReason) => {
    let list = pending.get(companyId);
    if (!list) pending.set(companyId, (list = []));
    list.push(r);
  };
  world.events.subscribe((e) => {
    switch (e.type) {
      case 'ShipIdle':
      case 'ShipDelivered':
        push(e.companyId, { kind: 'shipIdle', shipId: e.shipId });
        break;
      case 'ShipArrived':
        push(e.companyId, { kind: 'shipArrived', shipId: e.shipId });
        break;
      case 'CompanyFounded':
        if (!world.controllers.has(e.companyId))
          world.setController(e.companyId, factory(e.companyId));
        break;
      default:
        break;
    }
  });

  world.addPhase('controllers', (w) => {
    const tick = Math.round((w.jd - w.config.startJd) / TICK_DAYS);
    const periodic = tick % Math.round(PERIODIC_DAYS / TICK_DAYS) === 0;
    const fleet = tick % Math.round(FLEET_REVIEW_DAYS / TICK_DAYS) === 0;
    for (const id of sortedIds(w.companies)) {
      const company = w.companies.get(id)!;
      const controller = w.controllers.get(id);
      if (!controller || company.status === 'bankrupt') continue;
      const reasons = pending.get(id) ?? [];
      pending.delete(id);
      if (periodic) reasons.push({ kind: 'periodic' });
      if (fleet) reasons.push({ kind: 'fleetReview' });
      if (reasons.length === 0) continue;
      w.issue(id, controller.decide(createCompanyView(w, id), reasons));
    }
  });
}
