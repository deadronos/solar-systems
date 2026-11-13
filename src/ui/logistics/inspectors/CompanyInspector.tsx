import { netWorth } from '../../../sim/logistics/index.ts';
import { useSelectionStore } from '../../../state/selectionStore.ts';
import { EntityLink, nameOf, Sparkline, useTick, useWorld } from '../common.tsx';
import { describeEvent, fmtGood, fmtMoney, fmtTonnes, orderValue } from '../format.ts';

export function CompanyInspector({ id }: { id: string }) {
  useTick(3);
  const world = useWorld()!;
  const filter = useSelectionStore((s) => s.companyFilter);
  const setFilter = useSelectionStore((s) => s.setCompanyFilter);
  const c = world.companies.get(id);
  if (!c) return <p className="muted">This company no longer exists.</p>;
  const p = world.personalities.get(c.personalityId);
  const worth = world.stats?.series('companyNetWorth', id).map((x) => x.v) ?? [];
  const contracts = [...world.contracts.values()].filter(
    (x) => x.companyId === id && (x.status === 'accepted' || x.status === 'loaded'),
  );
  const name = (x: string) => nameOf(world, x);
  return (
    <>
      <header className="inspector__head">
        <h1 style={{ color: c.color }}>{c.name}</h1>
        <span className={`tag ${c.status === 'active' ? '' : 'tag--warn'}`}>{c.status}</span>
      </header>
      {p && (
        <p className="muted">
          <strong>{p.name}.</strong> {p.description}
        </p>
      )}
      <dl className="kv">
        <dt>Cash</dt>
        <dd>{fmtMoney(c.cash)}</dd>
        <dt>Net worth</dt>
        <dd>{fmtMoney(netWorth(world, id))}</dd>
        <dt>Revenue / costs</dt>
        <dd>
          {fmtMoney(c.stats.revenue)} / {fmtMoney(c.stats.costs)}
        </dd>
        <dt>Trades · orders</dt>
        <dd>
          {c.stats.tradesCompleted} · {c.stats.contractsCompleted}
        </dd>
      </dl>
      {worth.length > 1 && <Sparkline values={worth} color={c.color} />}
      <button
        type="button"
        className={`chip ${filter === id ? 'chip--on' : ''}`}
        onClick={() => setFilter(filter === id ? null : id)}
      >
        {filter === id ? 'Showing only this company' : 'Show only this company on the map'}
      </button>
      <h2>Fleet ({c.shipIds.length})</h2>
      <ul className="list">
        {c.shipIds.map((sid) => {
          const sh = world.ships.get(sid);
          if (!sh) return null;
          return (
            <li key={sid}>
              <EntityLink refTo={{ kind: 'ship', id: sid }} />{' '}
              <span className="muted small">{sh.intent}</span>
            </li>
          );
        })}
      </ul>
      {contracts.length > 0 && (
        <>
          <h2>Active orders</h2>
          <ul className="list">
            {contracts.map((x) => (
              <li key={x.id}>
                <EntityLink refTo={{ kind: 'contract', id: x.id }}>
                  {fmtTonnes(x.qty)} {fmtGood(x.good)} {x.kind === 'export' ? 'from' : '→'}{' '}
                  {name(x.settlementId)} · {fmtMoney(orderValue(x))}
                </EntityLink>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Recent decisions</h2>
      <ul className="list list--log">
        {world.events
          .forEntity(id, 10)
          .filter((e) => e.type !== 'CommandRejected')
          .map((e) => (
            <li key={e.seq}>{describeEvent(e, name)}</li>
          ))}
      </ul>
    </>
  );
}
