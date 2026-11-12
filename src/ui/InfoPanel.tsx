import { useCallback } from 'react';
import { useSimulation } from '../render/index.ts';
import { distance, length } from '../sim/index.ts';
import { useViewStore } from '../state/viewStore.ts';
import { formatDistance, formatLightTime, formatPeriod } from './format.ts';
import { usePolled } from './hooks.ts';

const KIND_LABEL = {
  star: 'Star',
  planet: 'Planet',
  'dwarf-planet': 'Dwarf planet',
  moon: 'Moon',
  asteroid: 'Asteroid',
} as const;

export function InfoPanel() {
  const { ephemeris } = useSimulation();
  const focusId = useViewStore((s) => s.focusId);
  const def = ephemeris.get(focusId);

  const read = useCallback(() => {
    const sun = length(ephemeris.position(focusId));
    const parent = def.parentId ? length(ephemeris.localPosition(focusId)) : 0;
    const earth = ephemeris.has('earth')
      ? distance(ephemeris.position(focusId), ephemeris.position('earth'))
      : 0;
    return { sun, parent, earth };
  }, [ephemeris, focusId, def.parentId]);
  const d = usePolled(read, 8);

  const period = ephemeris.orbitalPeriodDays(focusId);
  const parentName = def.parentId ? ephemeris.get(def.parentId).name : null;

  return (
    <section className="panel info" aria-label="Selected body">
      <header>
        <h1>{def.name}</h1>
        <span className="tag">{KIND_LABEL[def.kind]}</span>
      </header>
      <dl>
        <dt>Radius</dt>
        <dd>{def.radiusKm.toLocaleString('en-US')} km</dd>
        {def.kind !== 'star' && (
          <>
            <dt>From Sun</dt>
            <dd>
              {formatDistance(d.sun)} <small>({formatLightTime(d.sun)} light)</small>
            </dd>
          </>
        )}
        {parentName && parentName !== 'Sun' && (
          <>
            <dt>From {parentName}</dt>
            <dd>{formatDistance(d.parent)}</dd>
          </>
        )}
        {focusId !== 'earth' && (
          <>
            <dt>From Earth</dt>
            <dd>{formatDistance(d.earth)}</dd>
          </>
        )}
        {period !== null && (
          <>
            <dt>Orbital period</dt>
            <dd>{formatPeriod(period)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
