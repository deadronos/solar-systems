import { useEffect, useId, useRef, useState } from 'react';
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

const ECONOMY_SHORTCUTS = [
  ['Drag / scroll', 'Orbit and zoom'],
  ['Click', 'Inspect entity'],
  ['Double-click / F', 'Follow selected'],
  ['H', 'System overview'],
  ['Esc', 'Clear selection'],
  ['Alt+← / →', 'Back / forward'],
  ['Space', 'Pause / resume (outside controls)'],
  ['[ / ]', 'Slower / faster'],
] as const;

const ORRERY_SHORTCUTS = [
  ['Drag / scroll', 'Orbit and zoom'],
  ['Click', 'Focus body'],
  ['Space', 'Pause / resume (outside controls)'],
  ['[ / ]', 'Slower / faster'],
  ['R', 'Reverse time'],
  ['N', 'Jump to now'],
] as const;

function ShortcutHelp({ economy }: { economy: boolean }) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        e.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const items = economy ? ECONOMY_SHORTCUTS : ORRERY_SHORTCUTS;
  return (
    <div className="shortcuts" ref={rootRef}>
      <button
        type="button"
        className="shortcuts__trigger"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label="Keyboard and mouse shortcuts"
        title="Controls & shortcuts"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <section className="panel shortcuts__popover" id={popoverId} aria-label="Controls">
          <h2>Controls</h2>
          <dl>
            {items.map(([keys, desc]) => (
              <div key={keys} className="shortcuts__row">
                <dt>{keys}</dt>
                <dd>{desc}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

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
        <div className="hud__controls-row">
          <TimeControls />
          <ShortcutHelp economy={economy} />
        </div>
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
      </div>
    </div>
  );
}
