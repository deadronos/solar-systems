import { askPrice, GOOD_IDS } from '../../../sim/logistics/index.ts';
import { EntityLink, Meter, Sparkline, useTick, useWorld } from '../common.tsx';
import { fmtGood, fmtMoney, fmtTonnes } from '../format.ts';

export function SettlementInspector({ id }: { id: string }) {
  useTick(3);
  const world = useWorld()!;
  const s = world.settlements.get(id);
  if (!s) return <p className="muted">This place no longer exists.</p>;
  const stats = world.stats;
  const pop = stats?.series('settlementPopulation', id).map((x) => x.v) ?? [];
  const goods = GOOD_IDS.filter((g) => {
    const e = s.market[g];
    return s.isDeepMarket || e.targetStock > 0 || e.stock > 0;
  });
  const docked = [...world.ships.values()].filter(
    (sh) => sh.siteId === id && sh.state !== 'in_transit',
  );
  const inbound = [...world.ships.values()].filter(
    (sh) => sh.state === 'in_transit' && sh.plan?.toSiteId === id,
  );
  const orders = [...world.contracts.values()].filter(
    (c) =>
      c.settlementId === id &&
      (c.status === 'open' || c.status === 'accepted' || c.status === 'loaded'),
  );
  const produces = s.facilities
    .map((f) => world.recipes.get(f.recipeId))
    .filter(Boolean)
    .map((r) => r!.name);

  return (
    <>
      <header className="inspector__head">
        <h1>{s.name}</h1>
        <span className="tag">
          {s.site.kind === 'orbit' ? 'orbital' : 'surface'} ·{' '}
          {world.ephemeris.get(s.site.bodyId).name}
        </span>
      </header>
      <p className="muted">{s.description}</p>
      {!s.isDeepMarket && (
        <>
          <dl className="kv">
            <dt>Population</dt>
            <dd>
              {Math.round(s.population).toLocaleString('en-US')} /{' '}
              {Math.round(s.housingCapacity).toLocaleString('en-US')}
            </dd>
            <dt>Treasury</dt>
            <dd>{fmtMoney(s.treasury)}</dd>
          </dl>
          {pop.length > 1 && <Sparkline values={pop} />}
          <Meter label="Survival" value={s.satisfaction.survival} />
          <Meter label="Basic" value={s.satisfaction.basic} />
          <Meter label="Comfort" value={s.satisfaction.comfort} />
          {produces.length > 0 && <p className="muted small">Facilities: {produces.join(', ')}</p>}
        </>
      )}
      <h2>Market</h2>
      <table className="ledger market">
        <thead>
          <tr>
            <th>Good</th>
            <th className="num">Stock</th>
            <th className="num">Price</th>
            <th aria-label="Trend" />
          </tr>
        </thead>
        <tbody>
          {goods.map((g) => {
            const e = s.market[g];
            const base = world.goods.get(g)?.basePrice ?? 1;
            const ratio = e.price / base;
            const trend =
              stats
                ?.series(`price:${g}`, id)
                .slice(-60)
                .map((x) => x.v) ?? [];
            return (
              <tr key={g}>
                <td>{fmtGood(g)}</td>
                <td className="num">
                  {s.isDeepMarket ? '∞' : fmtTonnes(e.stock)}
                  {!s.isDeepMarket && e.targetStock > 0 && (
                    <span className="muted"> / {fmtTonnes(e.targetStock)}</span>
                  )}
                </td>
                <td className={`num ${ratio > 1.5 ? 'hot' : ratio < 0.6 ? 'cold' : ''}`}>
                  {fmtMoney(askPrice(e, world.constants.markets))}
                </td>
                <td>{trend.length > 1 && <Sparkline values={trend} width={48} height={14} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {orders.length > 0 && (
        <>
          <h2>Orders</h2>
          <ul className="list">
            {orders.map((c) => (
              <li key={c.id}>
                <EntityLink refTo={{ kind: 'contract', id: c.id }}>
                  {fmtTonnes(c.qty)} {fmtGood(c.good)} · {fmtMoney(c.reward)}
                </EntityLink>{' '}
                <span className="tag">{c.status}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(docked.length > 0 || inbound.length > 0) && (
        <>
          <h2>Ships</h2>
          <ul className="list">
            {docked.map((sh) => (
              <li key={sh.id}>
                <EntityLink refTo={{ kind: 'ship', id: sh.id }} />{' '}
                <span className="muted">docked</span>
              </li>
            ))}
            {inbound.map((sh) => (
              <li key={sh.id}>
                <EntityLink refTo={{ kind: 'ship', id: sh.id }} />{' '}
                <span className="muted">inbound</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
