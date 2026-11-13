import { useCallback, useEffect } from 'react';
import { useSimulation } from '../render/index.ts';
import { MAX_RATE_SECONDS_PER_SECOND } from '../sim/logistics/index.ts';
import { formatJdDate, formatRate, nearestPresetIndex, RATE_PRESETS } from './format.ts';
import { useClockState, usePolled } from './hooks.ts';

export function TimeControls() {
  const sim = useSimulation();
  const { clock } = sim;
  /** The economy only runs forward and has a top speed. */
  const economy = sim.logistics !== null;
  const maxIndex = economy
    ? RATE_PRESETS.findLastIndex((p) => p.seconds <= MAX_RATE_SECONDS_PER_SECOND)
    : RATE_PRESETS.length - 1;
  const { rate, paused } = useClockState(clock);
  const jd = usePolled(
    useCallback(() => clock.jd, [clock]),
    20,
  );
  const { date, time } = formatJdDate(jd);
  const index = nearestPresetIndex(rate);
  const sign = rate < 0 ? -1 : 1;

  const setIndex = useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(maxIndex, i));
      clock.setRate(sign * RATE_PRESETS[clamped]!.seconds);
    },
    [clock, sign, maxIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        clock.togglePaused();
      } else if (e.key === ']' || e.key === '.') setIndex(index + 1);
      else if (e.key === '[' || e.key === ',') setIndex(index - 1);
      else if (e.key === 'r' && !economy) clock.setRate(-clock.rate);
      else if (e.key === 'n' && !economy) clock.resetToNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clock, index, setIndex, economy]);

  return (
    <section className="panel time-controls" aria-label="Time controls">
      <div className="clock">
        <div className="clock__date">{date}</div>
        <div className="clock__time">{time}</div>
      </div>
      <div className="time-controls__buttons">
        {!economy && (
          <button
            type="button"
            title="Reverse time (R)"
            className={rate < 0 ? 'active' : ''}
            onClick={() => clock.setRate(-rate)}
          >
            ⇆
          </button>
        )}
        <button
          type="button"
          title="Slower ([)"
          onClick={() => setIndex(index - 1)}
          disabled={index === 0}
        >
          ◀◀
        </button>
        <button
          type="button"
          title="Play / pause (Space)"
          className="primary"
          onClick={() => clock.togglePaused()}
        >
          {paused ? '▶' : '❚❚'}
        </button>
        <button
          type="button"
          title="Faster (])"
          onClick={() => setIndex(index + 1)}
          disabled={index >= maxIndex}
        >
          ▶▶
        </button>
        {!economy && (
          <button type="button" title="Jump to now (N)" onClick={() => clock.resetToNow()}>
            Now
          </button>
        )}
      </div>
      <label className="rate">
        <input
          type="range"
          min={0}
          max={maxIndex}
          step={1}
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
        />
        <span className="rate__label">{paused ? 'Paused' : formatRate(rate)}</span>
      </label>
    </section>
  );
}
