import type { CSSProperties } from 'react';
import type { LogisticsWorld } from '../../sim/logistics/index.ts';
import { useSelectionStore, type EntityRef } from '../../state/selectionStore.ts';
import { useRenderFrame, useSimulation } from '../SimulationContext.tsx';
import { usePolledKeyed } from './usePolled.ts';

export const shipLabelKey = (id: string) => `ship:${id}`;
export const settlementLabelKey = (id: string) => `settlement:${id}`;

const isSel = (sel: EntityRef | null, kind: EntityRef['kind'], id: string) =>
  sel?.kind === kind && sel.id === id;

/**
 * DOM markers for settlements, and labels for the selected and hovered ship (positioned every
 * frame by the scene layers via the shared label registry). Every other ship is a point drawn
 * by `ShipLayer`, which also picks ships under the pointer. Clicking selects; double-clicking
 * selects and follows.
 */
export function LogisticsOverlay() {
  const sim = useSimulation();
  const world = sim.logistics;
  if (!world) return null;
  return <Markers world={world} />;
}

function Markers({ world }: { world: LogisticsWorld }) {
  const selectedShip = useSelectionStore((s) =>
    s.selected?.kind === 'ship' ? s.selected.id : null,
  );
  const hoveredShip = useSelectionStore((s) => s.hoveredShip);
  // Re-render when a labelled ship appears or goes (it may not exist yet in the replica).
  usePolledKeyed(
    () => [selectedShip, hoveredShip].filter((id) => id && world.ships.has(id)),
    (v) => v.join(','),
  );
  const ids = [...new Set([selectedShip, hoveredShip])].filter((id) => id !== null);
  const settlements = [...world.settlements.values()];
  return (
    <div className="label-layer" aria-label="Logistics markers">
      {settlements.map((s) => (
        <Marker
          key={s.id}
          refTo={{ kind: 'settlement', id: s.id }}
          labelKey={settlementLabelKey(s.id)}
        >
          <span className={`site-marker site-marker--${s.site.kind}`}>{s.name}</span>
        </Marker>
      ))}
      {ids.map((id) => {
        const ship = world.ships.get(id);
        const company = ship ? world.companies.get(ship.companyId) : undefined;
        if (!ship) return null;
        return (
          <Marker
            key={id}
            refTo={{ kind: 'ship', id }}
            labelKey={shipLabelKey(id)}
            hovered={id === hoveredShip}
            title={`${ship.name} — ${company?.name ?? ''}`}
          >
            <span
              className="ship-marker"
              style={{ '--c': company?.color ?? '#fff' } as CSSProperties}
            />
            <span className="ship-marker__name">{ship.name}</span>
          </Marker>
        );
      })}
    </div>
  );
}

function Marker({
  refTo,
  labelKey,
  title,
  hovered = false,
  children,
}: {
  refTo: EntityRef;
  labelKey: string;
  title?: string;
  hovered?: boolean;
  children: React.ReactNode;
}) {
  const frame = useRenderFrame();
  const selected = useSelectionStore((s) => isSel(s.selected, refTo.kind, refTo.id));
  const select = useSelectionStore((s) => s.select);
  const setFollow = useSelectionStore((s) => s.setFollow);
  return (
    <button
      type="button"
      title={title}
      className={`marker marker--${refTo.kind} ${selected ? 'marker--selected' : ''} ${hovered ? 'marker--hovered' : ''}`}
      style={{ visibility: 'hidden' }}
      ref={(el) => {
        if (!el) return;
        frame.labels.set(labelKey, el);
        return () => {
          frame.labels.delete(labelKey);
        };
      }}
      onClick={() => select(refTo)}
      onDoubleClick={() => {
        select(refTo);
        setFollow(true);
      }}
    >
      {children}
    </button>
  );
}
