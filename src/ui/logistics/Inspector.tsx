import { useSelectionStore } from '../../state/selectionStore.ts';
import { InfoPanel } from '../InfoPanel.tsx';
import { useWorld } from './common.tsx';
import { CompanyInspector } from './inspectors/CompanyInspector.tsx';
import { ContractInspector } from './inspectors/ContractInspector.tsx';
import { SettlementInspector } from './inspectors/SettlementInspector.tsx';
import { ShipInspector } from './inspectors/ShipInspector.tsx';

/** Right-hand inspector: shows whatever is selected, with back/forward and follow controls. */
export function Inspector() {
  const world = useWorld();
  const selected = useSelectionStore((s) => s.selected);
  const history = useSelectionStore((s) => s.history);
  const future = useSelectionStore((s) => s.future);
  const back = useSelectionStore((s) => s.back);
  const forward = useSelectionStore((s) => s.forward);
  const follow = useSelectionStore((s) => s.follow);
  const setFollow = useSelectionStore((s) => s.setFollow);
  const select = useSelectionStore((s) => s.select);

  if (!world || !selected || selected.kind === 'body') return <InfoPanel />;

  const exists =
    (selected.kind === 'ship' && world.ships.has(selected.id)) ||
    (selected.kind === 'company' && world.companies.has(selected.id)) ||
    (selected.kind === 'settlement' && world.settlements.has(selected.id)) ||
    (selected.kind === 'contract' && world.contracts.has(selected.id));
  const followable = selected.kind === 'ship' || selected.kind === 'settlement';

  return (
    <section className="panel inspector" aria-label="Inspector">
      <div className="inspector__nav">
        <button type="button" disabled={history.length === 0} onClick={back} title="Back (Alt+←)">
          ←
        </button>
        <button
          type="button"
          disabled={future.length === 0}
          onClick={forward}
          title="Forward (Alt+→)"
        >
          →
        </button>
        <span className="inspector__kind">{selected.kind}</span>
        {followable && exists && (
          <button
            type="button"
            className={follow ? 'active' : ''}
            onClick={() => setFollow(!follow)}
            title="Follow with the camera (F)"
          >
            {follow ? 'Following' : 'Follow'}
          </button>
        )}
        <button type="button" onClick={() => select(null)} title="Close (Esc)">
          ✕
        </button>
      </div>
      {!exists && <p className="muted">This {selected.kind} no longer exists.</p>}
      {exists && selected.kind === 'ship' && <ShipInspector id={selected.id} />}
      {exists && selected.kind === 'company' && <CompanyInspector id={selected.id} />}
      {exists && selected.kind === 'settlement' && <SettlementInspector id={selected.id} />}
      {exists && selected.kind === 'contract' && <ContractInspector id={selected.id} />}
    </section>
  );
}
