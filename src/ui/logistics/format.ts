import { fmtMoney, fmtTonnes, type LogisticsEvent } from '../../sim/logistics/index.ts';

export { fmtMoney, fmtTonnes };

export function fmtDays(d: number): string {
  if (d < 1) return `${Math.round(d * 24)} h`;
  if (d < 10) return `${d.toFixed(1)} d`;
  if (d < 730) return `${Math.round(d)} d`;
  return `${(d / 365.25).toFixed(1)} yr`;
}

export const fmtGood = (g: string) => g.replaceAll('_', ' ');

/** Plain-language one-liner for the activity feed. `name` resolves ids to display names. */
export function describeEvent(e: LogisticsEvent, name: (id: string) => string): string {
  switch (e.type) {
    case 'CargoBought':
      return `${name(e.shipId)} bought ${fmtTonnes(e.qty)} ${fmtGood(e.good)} at ${name(e.settlementId)} (${fmtMoney(e.price)}/t)`;
    case 'CargoSold':
      return `${name(e.shipId)} sold ${fmtTonnes(e.qty)} ${fmtGood(e.good)} at ${name(e.settlementId)} (${fmtMoney(e.price)}/t)`;
    case 'ShipDeparted':
      return `${name(e.shipId)} departed${e.fromSiteId ? ` ${name(e.fromSiteId)}` : ''} for ${name(e.toSiteId)}`;
    case 'ShipArrived':
      return `${name(e.shipId)} arrived at ${name(e.settlementId)}`;
    case 'ShipIdle':
      return `${name(e.shipId)} is idle${e.settlementId ? ` at ${name(e.settlementId)}` : ''}`;
    case 'FuelPurchased':
      return `${name(e.shipId)} fuelled up at ${name(e.settlementId)} (${fmtMoney(e.cost)})`;
    case 'ContractPosted':
      return `${name(e.settlementId)} wants ${fmtTonnes(e.qty)} ${fmtGood(e.good)} — ${e.kind}, ${fmtMoney(e.reward)}`;
    case 'ContractAccepted':
      return `${name(e.companyId)} took the ${name(e.settlementId)} order with ${name(e.shipId)}`;
    case 'ContractCompleted':
      return `${name(e.shipId)} delivered ${fmtTonnes(e.qty)} ${fmtGood(e.good)} to ${name(e.settlementId)} (+${fmtMoney(e.reward)})`;
    case 'ContractExpired':
      return `An order from ${name(e.settlementId)} expired${e.penalty > 0 && e.companyId ? ` — ${name(e.companyId)} fined ${fmtMoney(e.penalty)}` : ''}`;
    case 'ContractAbandoned':
      return `${name(e.companyId)} abandoned an order to ${name(e.settlementId)} (−${fmtMoney(e.penalty)})`;
    case 'ShipOrdered':
      return `${name(e.companyId)} ordered a new ship at ${name(e.settlementId)} (${fmtMoney(e.price)})`;
    case 'ShipDelivered':
      return `${name(e.shipId)} was delivered at ${name(e.settlementId)}`;
    case 'ShipSold':
      return `${name(e.companyId)} sold ${name(e.shipId)} (${fmtMoney(e.value)})`;
    case 'ShipRemoved':
      return `${name(e.shipId)} left service`;
    case 'LocalShuttle':
      return `${name(e.settlementId)} shuttled ${fmtTonnes(e.qty)} ${fmtGood(e.good)} from ${name(e.pickupSettlementId)}`;
    case 'PriceChanged':
      return `${fmtGood(e.good)} at ${name(e.settlementId)}: ${fmtMoney(e.from)} → ${fmtMoney(e.to)}/t`;
    case 'Shortage':
      return `${name(e.settlementId)} is short of survival supplies`;
    case 'ShortageResolved':
      return `${name(e.settlementId)} recovered from its shortage`;
    case 'PopulationMilestone':
      return `${name(e.settlementId)} reached ${e.population.toLocaleString('en-US')} people`;
    case 'HousingExpanded':
      return `${name(e.settlementId)} expanded housing to ${e.capacity.toLocaleString('en-US')}`;
    case 'CompanyFounded':
      return `${name(e.companyId)} entered the market`;
    case 'CompanyInDistress':
      return `${name(e.companyId)} is in financial distress (${fmtMoney(e.cash)})`;
    case 'CompanyRecovered':
      return `${name(e.companyId)} recovered`;
    case 'CompanyBankrupt':
      return `${name(e.companyId)} went bankrupt`;
    case 'CommandRejected':
      return `${name(e.companyId)}: ${e.command} refused (${e.reason})`;
  }
}

/** The entity an event is mainly about (for click-to-select in the feed). */
export function primaryEntity(
  e: LogisticsEvent,
): { kind: 'ship' | 'company' | 'settlement' | 'contract'; id: string } | null {
  if ('shipId' in e && e.shipId) return { kind: 'ship', id: e.shipId };
  if ('contractId' in e && e.contractId) return { kind: 'contract', id: e.contractId };
  if ('companyId' in e && e.companyId) return { kind: 'company', id: e.companyId };
  if ('settlementId' in e && e.settlementId) return { kind: 'settlement', id: e.settlementId };
  return null;
}
