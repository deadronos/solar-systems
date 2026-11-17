/* @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SimulationProvider } from '../../render/SimulationContext.tsx';
import { Simulation } from '../../sim/index.ts';
import { DEFAULT_SCENARIO } from '../../sim/logistics/index.ts';
import { TimeControls } from '../TimeControls.tsx';
import { Ledgers } from './Ledgers.tsx';

const press = (target: HTMLElement, key: string, code = key) => {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event));
  return event.defaultPrevented;
};

it('keeps native Space activation on a tab and moves focus with ledger navigation keys', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const sim = new Simulation({ scenario: DEFAULT_SCENARIO });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <SimulationProvider sim={sim}>
          <Ledgers />
          <TimeControls />
        </SimulationProvider>,
      ),
    );
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    const expectSelected = (index: number) => {
      expect(document.activeElement).toBe(tabs[index]);
      expect(tabs.map((t) => t.tabIndex)).toEqual(tabs.map((_, i) => (i === index ? 0 : -1)));
      expect(tabs[index]!.getAttribute('aria-selected')).toBe('true');
    };

    tabs[0]!.focus();
    expect(press(tabs[0]!, ' ', 'Space')).toBe(false);
    expect(sim.clock.paused).toBe(false);
    expect(press(tabs[0]!, 'ArrowLeft')).toBe(true);
    expectSelected(4);
    press(tabs[4]!, 'Home');
    expectSelected(0);
    press(tabs[0]!, 'ArrowRight');
    expectSelected(1);
    press(tabs[1]!, 'End');
    expectSelected(4);
    expect(container.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(
      tabs[4]!.id,
    );
    expect(press(document.body, ' ', 'Space')).toBe(true);
    expect(sim.clock.paused).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
