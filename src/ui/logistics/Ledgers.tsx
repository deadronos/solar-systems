import { useId, useState, type KeyboardEvent } from 'react';
import { netWorth } from '../../sim/logistics/index.ts';
import { toggleFollowShip } from '../../state/actions.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { BodyPicker } from '../BodyPicker.tsx';
import { EntityLink, useTick, useWorld } from './common.tsx';
import { fmtGood, fmtMoney, fmtTonnes, orderValue } from './format.ts';

type Tab = 'bodies' | 'companies' | 'settlements' | 'ships' | 'contracts';
const TABS: { id: Tab; label: string }[] = [
  { id: 'companies', label: 'Companies' },
  { id: 'settlements', label: 'Places' },
  { id: 'ships', label: 'Ships' },
  { id: 'contracts', label: 'Orders' },
  { id: 'bodies', label: 'Bodies' },
];

/** Tycoon-style ledgers: sortable-at-a-glance lists of everything in the economy. */
export function Ledgers() {
  const world = useWorld();
  const [tab, setTab] = useState<Tab>(world ? 'companies' : 'bodies');
  const id = useId();
  if (!world) return <BodyPicker />;

  const navigateTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (index + TABS.length - 1) % TABS.length;
        break;
      case 'ArrowRight':
        next = (index + 1) % TABS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = TABS[next]!;
    setTab(target.id);
    document.getElementById(`${id}-${target.id}`)?.focus();
  };
  return (
    <nav className="panel ledgers" aria-label="Ledgers">
      <div className="tabs" role="tablist" aria-label="Ledger views">
        {TABS.map((t, index) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${id}-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onKeyDown={(event) => navigateTab(event, index)}
            className={`tab ${tab === t.id ? 'tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        className="ledgers__body"
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        tabIndex={0}
      >
        {tab === 'bodies' && <BodyPicker embedded />}
        {tab === 'companies' && <Companies />}
        {tab === 'settlements' && <Settlements />}
        {tab === 'ships' && <Ships />}
        {tab === 'contracts' && <Contracts />}
      </div>
    </nav>
  );
}

function Companies() {
  useTick(2);
  const world = useWorld()!;
  const filter = useSelectionStore((s) => s.companyFilter);
  const setFilter = useSelectionStore((s) => s.setCompanyFilter);
  const rows = [...world.companies.values()]
    .map((c) => ({ c, worth: netWorth(world, c.id) }))
    .toSorted(
      (a, b) =>
        Number(a.c.status === 'bankrupt') - Number(b.c.status === 'bankrupt') || b.worth - a.worth,
    );
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Company</th>
          <th className="num">Worth</th>
          <th className="num">Ships</th>
          <th aria-label="Map filter" />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ c, worth }) => (
          <tr key={c.id} className={c.status !== 'active' ? `row--${c.status}` : ''}>
            <td>
              <EntityLink refTo={{ kind: 'company', id: c.id }} />
              {c.status !== 'active' && <span className="tag tag--warn">{c.status}</span>}
            </td>
            <td className="num">{fmtMoney(worth)}</td>
            <td className="num">{c.shipIds.length}</td>
            <td>
              <button
                type="button"
                className={`chip ${filter === c.id ? 'chip--on' : ''}`}
                title="Show only this company on the map"
                aria-label={`Filter map to ${c.name}`}
                aria-pressed={filter === c.id}
                onClick={() => setFilter(filter === c.id ? null : c.id)}
              >
                ◉
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Settlements() {
  useTick(2);
  const world = useWorld()!;
  const rows = [...world.settlements.values()].toSorted((a, b) => b.population - a.population);
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Place</th>
          <th className="num">People</th>
          <th className="num">Supply</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id}>
            <td>
              <EntityLink refTo={{ kind: 'settlement', id: s.id }} />
            </td>
            <td className="num">
              {s.isDeepMarket ? '—' : Math.round(s.population).toLocaleString('en-US')}
            </td>
            <td className="num">
              {s.isDeepMarket ? (
                <span className="tag">market</span>
              ) : (
                <span
                  className={`dot dot--${s.inShortage ? 'bad' : s.satisfaction.survival < 0.97 ? 'warn' : 'ok'}`}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const STATE_LABEL = {
  docked: 'docked',
  waiting: 'waiting',
  in_transit: 'in flight',
  building: 'building',
} as const;

const STATE_ORDER = {
  in_transit: 0,
  waiting: 1,
  docked: 2,
  building: 3,
} as const;

function Ships() {
  useTick(2);
  const world = useWorld()!;
  const filter = useSelectionStore((s) => s.companyFilter);
  const selected = useSelectionStore((s) => s.selected);
  const follow = useSelectionStore((s) => s.follow);
  const rows = [...world.ships.values()]
    .filter((s) => !filter || s.companyId === filter)
    .toSorted(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.companyId.localeCompare(b.companyId) ||
        a.name.localeCompare(b.name),
    );
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Ship</th>
          <th>Status</th>
          <th aria-label="Follow" />
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const following = follow && selected?.kind === 'ship' && selected.id === s.id;
          return (
            <tr key={s.id}>
              <td>
                <span
                  className="swatch"
                  style={{ background: world.companies.get(s.companyId)?.color }}
                />
                <EntityLink refTo={{ kind: 'ship', id: s.id }} />
              </td>
              <td className="muted">
                {STATE_LABEL[s.state]}
                {s.state === 'in_transit' && s.plan
                  ? ` → ${world.settlements.get(s.plan.toSiteId)?.name}`
                  : ''}
              </td>
              <td>
                <button
                  type="button"
                  className={`chip ${following ? 'chip--on' : ''}`}
                  title={following ? `Stop following ${s.name}` : `Follow ${s.name}`}
                  aria-label={`Follow ${s.name}`}
                  aria-pressed={following}
                  onClick={() => toggleFollowShip(s.id)}
                >
                  ◎
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Contracts() {
  useTick(2);
  const world = useWorld()!;
  const rows = [...world.contracts.values()]
    .filter((c) => c.status === 'open' || c.status === 'accepted' || c.status === 'loaded')
    .toSorted((a, b) => orderValue(b) - orderValue(a));
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Order</th>
          <th className="num">Reward</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={2} className="muted">
              No open orders
            </td>
          </tr>
        )}
        {rows.map((c) => (
          <tr key={c.id}>
            <td>
              <EntityLink refTo={{ kind: 'contract', id: c.id }}>
                {fmtTonnes(c.qty)} {fmtGood(c.good)} {c.kind === 'export' ? 'from' : '→'}{' '}
                {world.settlements.get(c.settlementId)?.name}
              </EntityLink>
              <span className={`tag ${c.status === 'open' ? '' : 'tag--ok'}`}>{c.status}</span>
            </td>
            <td className="num">{fmtMoney(orderValue(c))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
