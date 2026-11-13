import { cargoMass } from '../../../sim/logistics/index.ts';
import { EntityLink, nameOf, useTick, useWorld } from '../common.tsx';
import { describeEvent, fmtDays, fmtGood, fmtMoney, fmtTonnes } from '../format.ts';

const STATE = {
  docked: 'Docked',
  waiting: 'Waiting for launch window',
  in_transit: 'In flight',
  building: 'Under construction',
} as const;
const TIER = ['', 'Chemical', 'Nuclear / ion', 'Fusion torch', 'Antimatter', 'Jump drive'];

export function ShipInspector({ id }: { id: string }) {
  useTick(4);
  const world = useWorld()!;
  const ship = world.ships.get(id);
  if (!ship) return <p className="muted">This ship no longer exists.</p>;
  const cls = world.shipClassOf(ship);
  const cargo = Object.entries(ship.cargo).filter(([, q]) => (q ?? 0) > 0);
  const plan = ship.plan;
  const name = (x: string) => nameOf(world, x);
  return (
    <>
      <header className="inspector__head">
        <h1>{ship.name}</h1>
        <EntityLink refTo={{ kind: 'company', id: ship.companyId }} />
      </header>
      <p className="intent">{ship.intent}</p>
      <dl className="kv">
        <dt>Class</dt>
        <dd>
          {cls.name} · T{cls.tier} {TIER[cls.tier]}
        </dd>
        <dt>Status</dt>
        <dd>{STATE[ship.state]}</dd>
        {ship.siteId && (
          <>
            <dt>At</dt>
            <dd>
              <EntityLink refTo={{ kind: 'settlement', id: ship.siteId }} />
            </dd>
          </>
        )}
        {plan && (
          <>
            <dt>Route</dt>
            <dd>
              <EntityLink refTo={{ kind: 'settlement', id: plan.fromSiteId }} /> →{' '}
              <EntityLink refTo={{ kind: 'settlement', id: plan.toSiteId }} />
            </dd>
            <dt>{ship.state === 'waiting' ? 'Departs in' : 'Arrives in'}</dt>
            <dd>
              {fmtDays(
                Math.max(0, (ship.state === 'waiting' ? plan.departJd : plan.arriveJd) - world.jd),
              )}
            </dd>
            <dt>Δv / fuel</dt>
            <dd>
              {plan.deltaVKmS.toFixed(1)} km/s ·{' '}
              {plan.exoticCost > 0 ? fmtMoney(plan.exoticCost) : fmtTonnes(plan.fuelT)}
            </dd>
          </>
        )}
        <dt>Hold</dt>
        <dd>
          {fmtTonnes(cargoMass(ship))} / {fmtTonnes(cls.cargoT)}
        </dd>
        {ship.contractId && (
          <>
            <dt>Order</dt>
            <dd>
              <EntityLink refTo={{ kind: 'contract', id: ship.contractId }} />
            </dd>
          </>
        )}
        <dt>Lifetime</dt>
        <dd>
          {ship.stats.trips} trips · {fmtMoney(ship.stats.revenue - ship.stats.costs)} net
        </dd>
      </dl>
      {cargo.length > 0 && (
        <>
          <h2>Cargo</h2>
          <ul className="list">
            {cargo.map(([g, q]) => (
              <li key={g}>
                {fmtTonnes(q ?? 0)} {fmtGood(g)}
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Log</h2>
      <ul className="list list--log">
        {world.events.forEntity(id, 8).map((e) => (
          <li key={e.seq}>{describeEvent(e, name)}</li>
        ))}
      </ul>
    </>
  );
}
