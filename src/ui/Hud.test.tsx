/* @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationProvider } from '../render/SimulationContext.tsx';
import { Simulation } from '../sim/index.ts';
import { DEFAULT_SCENARIO } from '../sim/logistics/index.ts';
import { followNextShipment } from '../state/actions.ts';
import { useSelectionStore } from '../state/selectionStore.ts';
import { useViewStore } from '../state/viewStore.ts';
import { Hud } from './Hud.tsx';

function resetStores() {
  useSelectionStore.setState({
    selected: null,
    history: [],
    future: [],
    follow: false,
    companyFilter: null,
    overlays: { tradeFlows: false, allTrajectories: true, shortages: false, ships: true },
    hoveredShip: null,
  });
  useViewStore.setState({
    focusId: 'sun',
    layers: { orbits: true, moonOrbits: false, labels: true, belts: true, stars: true },
    minPixelRadius: 2.5,
  });
}

afterEach(() => {
  resetStores();
  vi.unstubAllGlobals();
});

describe('HUD overview hierarchy and shipment jump', () => {
  it('starts with economy-first layer defaults', () => {
    expect(useSelectionStore.getState().overlays.allTrajectories).toBe(true);
    expect(useViewStore.getState().layers.moonOrbits).toBe(false);
  });

  it('collapses map layers behind a disclosure and opens shortcuts via the ? button', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <SimulationProvider sim={sim}>
            <Hud />
          </SimulationProvider>,
        ),
      );

      // Economy overlays are visible immediately; map layers start collapsed.
      expect(container.textContent).toContain('All routes');
      expect(container.textContent).not.toContain('Moon orbits');

      const mapDisclosure = container.querySelector<HTMLButtonElement>('.layers__disclosure')!;
      expect(mapDisclosure.getAttribute('aria-expanded')).toBe('false');
      act(() => mapDisclosure.click());
      expect(mapDisclosure.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Moon orbits');

      // Shortcuts popover opens on click and closes on Escape without clearing selection.
      act(() => {
        useSelectionStore.getState().select({ kind: 'body', id: 'earth' });
      });
      const helpBtn = container.querySelector<HTMLButtonElement>('.shortcuts__trigger')!;
      expect(helpBtn.getAttribute('aria-expanded')).toBe('false');
      act(() => helpBtn.click());
      expect(helpBtn.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('.shortcuts__popover')).not.toBeNull();

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(helpBtn.getAttribute('aria-expanded')).toBe('false');
      expect(useSelectionStore.getState().selected).toEqual({ kind: 'body', id: 'earth' });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('cycles through active shipments and follows them via Watch shipment', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
    // Advance a few days so ships have active flight plans.
    sim.logistics!.advanceTo(sim.clock.jd + 5);

    const first = followNextShipment(sim.logistics!);
    expect(first).not.toBeNull();
    expect(useSelectionStore.getState().selected).toEqual({ kind: 'ship', id: first!.id });
    expect(useSelectionStore.getState().follow).toBe(true);

    const second = followNextShipment(sim.logistics!);
    expect(second).not.toBeNull();
    if (
      [...sim.logistics!.ships.values()].filter((s) => s.state === 'in_transit' && s.plan).length >
      1
    ) {
      expect(second!.id).not.toBe(first!.id);
    }

    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <SimulationProvider sim={sim}>
            <Hud />
          </SimulationProvider>,
        ),
      );
      const watchBtn = container.querySelector<HTMLButtonElement>('.topbar__action')!;
      expect(watchBtn.disabled).toBe(false);
      expect(watchBtn.textContent).toMatch(/Watch shipment/);
      act(() => watchBtn.click());
      expect(useSelectionStore.getState().selected?.kind).toBe('ship');
      expect(useSelectionStore.getState().follow).toBe(true);

      // Overview button resets focus, selection, and follow.
      const overviewBtn = container.querySelector<HTMLButtonElement>('.topbar__action--secondary')!;
      expect(overviewBtn.disabled).toBe(false);
      act(() => overviewBtn.click());
      expect(useSelectionStore.getState().selected).toBeNull();
      expect(useSelectionStore.getState().follow).toBe(false);
      expect(useViewStore.getState().focusId).toBe('sun');
      expect(overviewBtn.disabled).toBe(true);

      // H shortcut also returns to system overview.
      act(() => {
        useViewStore.getState().setFocus('mars');
        useSelectionStore.getState().select({ kind: 'body', id: 'mars' });
      });
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
      });
      expect(useViewStore.getState().focusId).toBe('sun');
      expect(useSelectionStore.getState().selected).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('sorts in-flight ships first and supports one-tap follow in the Ships ledger', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
    sim.logistics!.advanceTo(sim.clock.jd + 5);

    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <SimulationProvider sim={sim}>
            <Hud />
          </SimulationProvider>,
        ),
      );
      const shipsTab = [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(
        (t) => t.textContent === 'Ships',
      )!;
      act(() => shipsTab.click());

      const rows = [...container.querySelectorAll<HTMLTableRowElement>('.ledger tbody tr')];
      expect(rows.length).toBeGreaterThan(0);
      const firstStatus = rows[0]!.cells[1]!.textContent ?? '';
      expect(firstStatus).toContain('in flight');

      const followBtn = rows[0]!.querySelector<HTMLButtonElement>('button.chip')!;
      expect(followBtn.getAttribute('aria-pressed')).toBe('false');
      act(() => followBtn.click());
      expect(useSelectionStore.getState().follow).toBe(true);
      expect(useSelectionStore.getState().selected?.kind).toBe('ship');
      expect(followBtn.getAttribute('aria-pressed')).toBe('true');

      act(() => followBtn.click());
      expect(useSelectionStore.getState().follow).toBe(false);
      expect(followBtn.getAttribute('aria-pressed')).toBe('false');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
