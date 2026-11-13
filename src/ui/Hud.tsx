import { useSimulation } from '../render/index.ts';
import { useSelectionStore } from '../state/selectionStore.ts';
import { BodyPicker } from './BodyPicker.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { LayerToggles } from './LayerToggles.tsx';
import { EventFeed } from './logistics/EventFeed.tsx';
import { Inspector } from './logistics/Inspector.tsx';
import { Ledgers } from './logistics/Ledgers.tsx';
import { TopBar } from './logistics/TopBar.tsx';
import { TimeControls } from './TimeControls.tsx';

/** DOM overlay. Reads the sim through the context API only; never touches three.js. */
export function Hud() {
  const economy = useSimulation().logistics !== null;
  const selected = useSelectionStore((s) => s.selected);
  const selectedKey = selected ? `${selected.kind}:${selected.id}` : '';
  return (
    <div className={`hud ${economy ? 'hud--economy' : ''}`}>
      {economy && (
        <div className="hud__top">
          <TopBar />
        </div>
      )}
      <div className="hud__left">
        <ErrorBoundary label="ledger">{economy ? <Ledgers /> : <BodyPicker />}</ErrorBoundary>
      </div>
      <div className="hud__right">
        {economy ? (
          <ErrorBoundary label="inspector" resetKey={selectedKey}>
            <Inspector />
          </ErrorBoundary>
        ) : (
          <InfoPanel />
        )}
        <LayerToggles />
      </div>
      <div className="hud__bottom">
        <TimeControls />
        {economy && (
          <ErrorBoundary label="activity feed">
            <EventFeed />
          </ErrorBoundary>
        )}
        <p className="hint">
          {economy
            ? 'Drag to orbit · scroll to zoom · click to inspect · double-click or F to follow · Esc clear · Alt+←/→ back/forward · Space pause · [ ] speed'
            : 'Drag to orbit · scroll to zoom · click a body or label to focus · Space pause · [ ] speed · R reverse · N now'}
        </p>
      </div>
    </div>
  );
}
