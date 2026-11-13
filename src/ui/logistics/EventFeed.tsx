import { useState } from 'react';
import type { EventType, LogisticsEvent } from '../../sim/logistics/index.ts';
import { useSelectionStore } from '../../state/selectionStore.ts';
import { formatJdDate } from '../format.ts';
import { nameOf, useTick, useWorld } from './common.tsx';
import { describeEvent, primaryEntity } from './format.ts';

type Group = 'all' | 'trade' | 'orders' | 'fleet' | 'places';
const GROUPS: Record<Exclude<Group, 'all'>, EventType[]> = {
  trade: ['CargoBought', 'CargoSold', 'LocalShuttle'],
  orders: [
    'ContractPosted',
    'ContractAccepted',
    'ContractCompleted',
    'ContractExpired',
    'ContractAbandoned',
    'SellOrderFilled',
  ],
  fleet: [
    'ShipOrdered',
    'ShipDelivered',
    'ShipSold',
    'ShipRemoved',
    'CompanyFounded',
    'CompanyInDistress',
    'CompanyRecovered',
    'CompanyBankrupt',
  ],
  places: [
    'Shortage',
    'ShortageResolved',
    'PopulationMilestone',
    'HousingExpanded',
    'InvestmentDecision',
    'FacilityBuilt',
    'InvestmentAbandoned',
  ],
};
/** Noise kept out of the feed by default. */
const HIDDEN = new Set<EventType>([
  'PriceChanged',
  'ShipIdle',
  'ShipIntentChanged',
  'FuelPurchased',
  'CommandRejected',
  'ShipDeparted',
  'ShipArrived',
]);

export function EventFeed() {
  useTick(3);
  const world = useWorld();
  const [group, setGroup] = useState<Group>('all');
  const companyFilter = useSelectionStore((s) => s.companyFilter);
  const select = useSelectionStore((s) => s.select);
  if (!world) return null;
  const filter = (e: LogisticsEvent) =>
    (group === 'all' ? !HIDDEN.has(e.type) : GROUPS[group].includes(e.type)) &&
    (!companyFilter || ('companyId' in e && e.companyId === companyFilter));
  const events = world.events.recent(40, filter);
  const name = (id: string) => nameOf(world, id);
  return (
    <section className="panel feed" aria-label="Activity feed">
      <div className="feed__head">
        <strong>Activity</strong>
        {(['all', 'trade', 'orders', 'fleet', 'places'] as Group[]).map((g) => (
          <button
            key={g}
            type="button"
            className={`chip ${group === g ? 'chip--on' : ''}`}
            onClick={() => setGroup(g)}
          >
            {g}
          </button>
        ))}
        {companyFilter && <span className="tag">{name(companyFilter)} only</span>}
      </div>
      <ol className="feed__list">
        {events.map((e) => {
          const target = primaryEntity(e);
          return (
            <li key={e.seq}>
              <button
                type="button"
                className="feed__item"
                disabled={!target}
                onClick={() => target && select(target)}
              >
                <span className="feed__date">{formatJdDate(e.jd).date}</span>{' '}
                {describeEvent(e, name)}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
