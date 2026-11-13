import { EntityLink, nameOf, useTick, useWorld } from '../common.tsx';
import { describeEvent, fmtDays, fmtGood, fmtMoney, fmtTonnes } from '../format.ts';

export function ContractInspector({ id }: { id: string }) {
  useTick(3);
  const world = useWorld()!;
  const c = world.contracts.get(id)!;
  const name = (x: string) => nameOf(world, x);
  return (
    <>
      <header className="inspector__head">
        <h1>
          {fmtTonnes(c.qty)} {fmtGood(c.good)}
        </h1>
        <span className="tag">{c.status}</span>
      </header>
      <p className="muted">
        {c.kind === 'freight'
          ? 'Freight: the buyer has already paid for the goods at the pickup; the carrier only hauls them.'
          : 'Delivery: the carrier sources the goods wherever it likes and is paid on delivery.'}
      </p>
      <dl className="kv">
        <dt>Buyer</dt>
        <dd>
          <EntityLink refTo={{ kind: 'settlement', id: c.settlementId }} />
        </dd>
        {c.pickupSettlementId && (
          <>
            <dt>Pickup</dt>
            <dd>
              <EntityLink refTo={{ kind: 'settlement', id: c.pickupSettlementId }} />
            </dd>
          </>
        )}
        <dt>{c.kind === 'freight' ? 'Fee' : 'Reward'}</dt>
        <dd>{fmtMoney(c.reward)}</dd>
        <dt>Deadline</dt>
        <dd>{c.deadlineJd > world.jd ? `in ${fmtDays(c.deadlineJd - world.jd)}` : 'passed'}</dd>
        {c.companyId && (
          <>
            <dt>Carrier</dt>
            <dd>
              <EntityLink refTo={{ kind: 'company', id: c.companyId }} />
              {c.shipId && (
                <>
                  {' '}
                  · <EntityLink refTo={{ kind: 'ship', id: c.shipId }} />
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      <h2>History</h2>
      <ul className="list list--log">
        {world.events.forEntity(id, 10).map((e) => (
          <li key={e.seq}>{describeEvent(e, name)}</li>
        ))}
      </ul>
    </>
  );
}
