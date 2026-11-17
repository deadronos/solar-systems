import { useId, useState } from 'react';
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

const MOBILE_PANELS = [
  { id: 'ledgers', label: 'Ledgers' },
  { id: 'details', label: 'Details' },
  { id: 'layers', label: 'Layers' },
  { id: 'activity', label: 'Activity' },
] as const;

type MobilePanel = (typeof MOBILE_PANELS)[number]['id'];

/** DOM overlay. Reads the sim through the context API only; never touches three.js. */
export function Hud() {
  const panelId = useId();
  const [mobilePanel, setMobilePanel] = useState<MobilePanel | null>(null);
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
      {economy && (
        <nav className="hud__mobile-nav" aria-label="Map panels">
          {MOBILE_PANELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-controls={`${panelId}-${id}`}
              aria-expanded={mobilePanel === id}
              onClick={() => setMobilePanel((open) => (open === id ? null : id))}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      <div
        className="hud__left"
        id={`${panelId}-ledgers`}
        data-mobile-open={mobilePanel === 'ledgers'}
      >
        <ErrorBoundary label="ledger">{economy ? <Ledgers /> : <BodyPicker />}</ErrorBoundary>
      </div>
      <div className="hud__right">
        <div
          className="hud__drawer"
          id={`${panelId}-details`}
          data-mobile-open={mobilePanel === 'details'}
        >
          {economy ? (
            <ErrorBoundary label="inspector" resetKey={selectedKey}>
              <Inspector />
            </ErrorBoundary>
          ) : (
            <InfoPanel />
          )}
        </div>
        <div
          className="hud__drawer"
          id={`${panelId}-layers`}
          data-mobile-open={mobilePanel === 'layers'}
        >
          <LayerToggles />
        </div>
      </div>
      <div className="hud__bottom">
        <TimeControls />
        {economy && (
          <div
            className="hud__drawer"
            id={`${panelId}-activity`}
            data-mobile-open={mobilePanel === 'activity'}
          >
            <ErrorBoundary label="activity feed">
              <EventFeed />
            </ErrorBoundary>
          </div>
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
