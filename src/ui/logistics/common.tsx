import { useEffect, useState, type ReactNode } from 'react';
import { useSimulation } from '../../render/index.ts';
import type { LogisticsWorld } from '../../sim/logistics/index.ts';
import { useSelectionStore, type EntityRef } from '../../state/selectionStore.ts';

/** Re-render at a fixed cadence (panels read the live world directly while rendering). */
export function useTick(hz = 4): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((x) => x + 1), 1000 / hz);
    return () => window.clearInterval(id);
  }, [hz]);
  return n;
}

export function useWorld(): LogisticsWorld | null {
  return useSimulation().logistics;
}

/** Display name for any entity id. */
export function nameOf(world: LogisticsWorld, id: string): string {
  return (
    world.ships.get(id)?.name ??
    world.companies.get(id)?.name ??
    world.settlements.get(id)?.name ??
    (world.contracts.has(id) ? `Order ${id.replace('contract-', '#')}` : id)
  );
}

/** Clickable entity name: click selects, double-click selects and follows. */
export function EntityLink({ refTo, children }: { refTo: EntityRef; children?: ReactNode }) {
  const world = useWorld();
  const select = useSelectionStore((s) => s.select);
  const setFollow = useSelectionStore((s) => s.setFollow);
  const company = refTo.kind === 'company' ? world?.companies.get(refTo.id) : undefined;
  return (
    <button
      type="button"
      className={`link link--${refTo.kind}`}
      style={company ? { color: company.color } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        select(refTo);
      }}
      onDoubleClick={() => {
        select(refTo);
        if (refTo.kind === 'ship' || refTo.kind === 'settlement') setFollow(true);
      }}
    >
      {children ?? (world ? nameOf(world, refTo.id) : refTo.id)}
    </button>
  );
}

export function Sparkline({
  values,
  width = 220,
  height = 36,
  color = 'var(--accent)',
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2)
    return <svg width={width} height={height} className="sparkline" aria-hidden />;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-9) {
    max += 1;
    min -= 1;
  }
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * width).toFixed(1)},${(height - ((v - min) / (max - min)) * (height - 4) - 2).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg width={width} height={height} className="sparkline" role="img" aria-label="trend">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone = value >= 0.9 ? 'ok' : value >= 0.6 ? 'warn' : 'bad';
  return (
    <div className="meter" title={`${label}: ${pct}%`}>
      <span className="meter__label">{label}</span>
      <span className="meter__bar">
        <span className={`meter__fill meter__fill--${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="meter__pct">{pct}%</span>
    </div>
  );
}
