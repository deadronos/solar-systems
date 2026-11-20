import { useEffect } from 'react';
import { useSimulation } from '../../render/index.ts';
import { netWorth } from '../../sim/logistics/index.ts';
import {
  activeShipments,
  followNextShipment,
  navigateSelectionHistory,
  resetOverview,
} from '../../state/actions.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { useViewStore } from '../../state/viewStore.ts';
import { formatRate, formatRateValue } from '../format.ts';
import { EntityLink, useTick } from './common.tsx';
import { fmtMoney, fmtTonnes } from './format.ts';

/** Economy at a glance: achieved speed, trade volume, market leader, and shipment jump. */
export function TopBar() {
  useTick(2);
  const sim = useSimulation();
  const world = sim.logistics;
  const companyFilter = useSelectionStore((s) => s.companyFilter);
  const selected = useSelectionStore((s) => s.selected);
  const follow = useSelectionStore((s) => s.follow);
  const focusId = useViewStore((s) => s.focusId);
  const atOverview = !follow && selected === null && focusId === 'sun';
  useKeyboardShortcuts();
  if (!world) return null;
  const { inFlight, scheduled } = activeShipments(world, companyFilter);
  const watchable = inFlight.length + scheduled.length;
  const ranked = [...world.companies.values()]
    .filter((c) => c.status !== 'bankrupt')
    .map((c) => ({ id: c.id, worth: netWorth(world, c.id) }))
    .toSorted((a, b) => b.worth - a.worth);
  const leader = ranked[0];
  // Trend over the last month of daily net-worth samples.
  const series = leader ? (world.stats?.series('companyNetWorth', leader.id) ?? []) : [];
  const past = series.at(-31) ?? series[0];
  const trend = past && leader ? Math.sign(leader.worth - past.v) : 0;
  const lagging = sim.economyBehind;
  // Show the measured rate; name the requested preset when the economy can't keep up with it.
  const requested = sim.clock.rate;
  const achieved = sim.achievedRate || requested;
  const short = achieved < requested * 0.9;
  return (
    <header className="panel topbar" aria-label="Economy summary">
      <span
        title={`Measured simulation speed · economy on the ${sim.economyMode === 'worker' ? 'worker thread' : 'main thread'}`}
      >
        <span className="muted">Speed </span>
        {sim.clock.paused ? 'paused' : formatRateValue(achieved)}
        {!sim.clock.paused && short && <span className="muted"> of {formatRate(requested)}</span>}
        {sim.economyError ? (
          <span className="tag tag--warn" title={sim.economyError}>
            economy stopped
          </span>
        ) : (
          lagging && <span className="tag tag--warn">economy catching up</span>
        )}
      </span>
      <span>
        <span className="muted">Trade, last year </span>
        {fmtTonnes(world.stats?.tradeVolume365 ?? 0)}
      </span>
      <span>
        <span className="muted">Fleet </span>
        {world.ships.size} ships · {ranked.length} companies
      </span>
      {leader && (
        <span>
          <span className="muted">Leader </span>
          <EntityLink refTo={{ kind: 'company', id: leader.id }} /> {fmtMoney(leader.worth)}{' '}
          <span className={trend > 0 ? 'up' : trend < 0 ? 'down' : ''}>
            {trend > 0 ? '▲' : trend < 0 ? '▼' : ''}
          </span>
        </span>
      )}
      <span className="topbar__actions">
        <button
          type="button"
          className="topbar__action"
          disabled={watchable === 0}
          onClick={() => followNextShipment(world)}
          title={
            inFlight.length > 0
              ? 'Select and follow a ship in flight (click again to cycle)'
              : scheduled.length > 0
                ? 'Select and follow a ship awaiting departure'
                : 'No active shipments yet'
          }
        >
          Watch shipment{inFlight.length > 0 ? ` (${inFlight.length})` : ''}
        </button>
        <button
          type="button"
          className="topbar__action topbar__action--secondary"
          disabled={atOverview}
          onClick={resetOverview}
          title="Return to system overview (H)"
        >
          Overview
        </button>
      </span>
    </header>
  );
}

/** F follow · H overview · Esc clear · Alt+←/→ back/forward. */
function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const s = useSelectionStore.getState();
      if (e.key === 'Escape') s.select(null);
      else if ((e.key === 'f' || e.key === 'F') && s.selected) s.setFollow(!s.follow);
      else if (e.key === 'h' || e.key === 'H') resetOverview();
      else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (navigateSelectionHistory(e.key === 'ArrowLeft' ? 'back' : 'forward'))
          e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
