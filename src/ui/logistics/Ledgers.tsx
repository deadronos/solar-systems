import { useState } from 'react';
import { netWorth } from '../../sim/logistics/index.ts';
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
  if (!world) return <BodyPicker />;
  return (
    <nav className="panel ledgers" aria-label="Ledgers">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ledgers__body">
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

function Ships() {
  useTick(2);
  const world = useWorld()!;
  const filter = useSelectionStore((s) => s.companyFilter);
  const rows = [...world.ships.values()]
    .filter((s) => !filter || s.companyId === filter)
    .toSorted((a, b) => a.companyId.localeCompare(b.companyId) || a.name.localeCompare(b.name));
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Ship</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
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
          </tr>
        ))}
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
