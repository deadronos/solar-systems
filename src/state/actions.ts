import type { LogisticsWorld, Ship } from '../sim/logistics/index.ts';
import { useSelectionStore } from './selectionStore.ts';
import { useViewStore } from './viewStore.ts';

/**
 * Focus the camera on a body and select it. Stops following any ship or settlement first,
 * otherwise the camera would stay on the followed entity (see `cameraTarget`).
 */
export function focusBody(id: string): void {
  setBodyFocus(id);
  useSelectionStore.getState().select({ kind: 'body', id });
}

function setBodyFocus(id: string): void {
  useSelectionStore.getState().setFollow(false);
  useViewStore.getState().setFocus(id);
}

/** Restore camera focus when history lands on a body without adding a selection entry. */
export function navigateSelectionHistory(direction: 'back' | 'forward'): boolean {
  const selection = useSelectionStore.getState();
  const target = (direction === 'back' ? selection.history : selection.future).at(-1);
  if (!target) return false;
  if (target.kind === 'body') setBodyFocus(target.id);
  selection[direction]();
  return true;
}

const compareShipId = (a: Ship, b: Ship) => a.id.localeCompare(b.id);

/** Ships currently travelling (or, if none yet, waiting on a planned departure). */
export function activeShipments(
  world: LogisticsWorld,
  companyFilter: string | null = null,
): { inFlight: Ship[]; scheduled: Ship[] } {
  const inFlight: Ship[] = [];
  const scheduled: Ship[] = [];
  for (const ship of world.ships.values()) {
    if (companyFilter && ship.companyId !== companyFilter) continue;
    if (!ship.plan) continue;
    if (ship.state === 'in_transit') inFlight.push(ship);
    else if (ship.state === 'waiting') scheduled.push(ship);
  }
  return {
    inFlight: inFlight.toSorted(compareShipId),
    scheduled: scheduled.toSorted(compareShipId),
  };
}

/** Return the camera to the system overview (Sun focus, nothing selected or followed). */
export function resetOverview(): void {
  const selection = useSelectionStore.getState();
  selection.setFollow(false);
  selection.select(null);
  useViewStore.getState().setFocus('sun');
}

/** Toggle following a specific ship (selects it if not already selected). */
export function toggleFollowShip(shipId: string): void {
  const selection = useSelectionStore.getState();
  const alreadyFollowing =
    selection.follow && selection.selected?.kind === 'ship' && selection.selected.id === shipId;
  if (alreadyFollowing) {
    selection.setFollow(false);
    return;
  }
  selection.select({ kind: 'ship', id: shipId });
  selection.setFollow(true);
}

/**
 * Select and follow the next active shipment (preferring ships already in flight).
 * Repeating the action cycles through the active pool.
 */
export function followNextShipment(world: LogisticsWorld): Ship | null {
  const selection = useSelectionStore.getState();
  const { inFlight, scheduled } = activeShipments(world, selection.companyFilter);
  const pool = inFlight.length > 0 ? inFlight : scheduled;
  if (pool.length === 0) return null;

  const currentId = selection.selected?.kind === 'ship' ? selection.selected.id : null;
  const currentIndex =
    currentId && selection.follow ? pool.findIndex((s) => s.id === currentId) : -1;
  const next = pool[(currentIndex + 1) % pool.length]!;
  selection.select({ kind: 'ship', id: next.id });
  selection.setFollow(true);
  return next;
}
