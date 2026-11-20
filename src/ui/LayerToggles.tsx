import { useId, useState } from 'react';
import { useSimulation } from '../render/index.ts';
import { useSelectionStore, type Overlays } from '../state/selectionStore.ts';
import { useViewStore, type Layers } from '../state/viewStore.ts';

const LAYERS: { key: keyof Layers; label: string }[] = [
  { key: 'orbits', label: 'Orbits' },
  { key: 'moonOrbits', label: 'Moon orbits' },
  { key: 'labels', label: 'Labels' },
  { key: 'belts', label: 'Belts' },
  { key: 'stars', label: 'Stars' },
];

const OVERLAYS: { key: keyof Overlays; label: string }[] = [
  { key: 'ships', label: 'Ships' },
  { key: 'allTrajectories', label: 'All routes' },
  { key: 'tradeFlows', label: 'Trade flows' },
  { key: 'shortages', label: 'Supply status' },
];

export function LayerToggles() {
  const economy = useSimulation().logistics !== null;
  const [mapOpen, setMapOpen] = useState(false);
  const mapPanelId = useId();
  const overlays = useSelectionStore((s) => s.overlays);
  const toggleOverlay = useSelectionStore((s) => s.toggleOverlay);
  const layers = useViewStore((s) => s.layers);
  const toggle = useViewStore((s) => s.toggleLayer);
  const minPx = useViewStore((s) => s.minPixelRadius);
  const setMinPx = useViewStore((s) => s.setMinPixelRadius);

  const mapLayerControls = (
    <div className="layers__grid" id={mapPanelId}>
      {LAYERS.map(({ key, label }) => (
        <label key={key} className="toggle">
          <input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} />
          {label}
        </label>
      ))}
      <label
        className="toggle"
        title="Bodies are drawn at true size; when they would be smaller than a few pixels they are drawn as a minimum-size marker instead."
      >
        <input
          type="checkbox"
          checked={minPx === 0}
          onChange={() => setMinPx(minPx === 0 ? 2.5 : 0)}
        />
        Strict true size
      </label>
    </div>
  );

  if (!economy) {
    return (
      <section className="panel layers" aria-label="Layers">
        {mapLayerControls}
      </section>
    );
  }

  return (
    <section className="panel layers" aria-label="Layers">
      <div className="layers__grid">
        {OVERLAYS.map(({ key, label }) => (
          <label key={key} className="toggle toggle--overlay">
            <input type="checkbox" checked={overlays[key]} onChange={() => toggleOverlay(key)} />
            {label}
          </label>
        ))}
      </div>
      <div className="layers__section">
        <button
          type="button"
          className="layers__disclosure"
          aria-expanded={mapOpen}
          aria-controls={mapPanelId}
          onClick={() => setMapOpen((open) => !open)}
        >
          <span>Map layers</span>
          <span className="layers__chevron" aria-hidden="true">
            {mapOpen ? '▾' : '▸'}
          </span>
        </button>
        {mapOpen && mapLayerControls}
      </div>
    </section>
  );
}
