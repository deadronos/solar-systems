import { useMemo } from 'react';
import { useSimulation } from '../render/index.ts';
import type { BodyDefinition } from '../sim/index.ts';
import { useViewStore } from '../state/viewStore.ts';

function Item({ def, depth }: { def: BodyDefinition; depth: number }) {
  const focusId = useViewStore((s) => s.focusId);
  const setFocus = useViewStore((s) => s.setFocus);
  return (
    <li>
      <button
        type="button"
        className={`picker__item ${focusId === def.id ? 'active' : ''}`}
        style={{ paddingLeft: `${0.6 + depth * 0.9}rem` }}
        onClick={() => setFocus(def.id)}
      >
        {def.name}
      </button>
    </li>
  );
}

export function BodyPicker() {
  const { ephemeris } = useSimulation();

  const groups = useMemo(() => {
    const bodies = ephemeris.bodies;
    const childrenOf = (id: string) => bodies.filter((b) => b.parentId === id);
    const flatten = (
      defs: BodyDefinition[],
      depth: number,
    ): { def: BodyDefinition; depth: number }[] =>
      defs.flatMap((def) => [{ def, depth }, ...flatten(childrenOf(def.id), depth + 1)]);
    const sunKids = childrenOf('sun');
    return [
      {
        title: 'Star',
        items: bodies.filter((b) => b.kind === 'star').map((def) => ({ def, depth: 0 })),
      },
      {
        title: 'Planets & moons',
        items: flatten(
          sunKids.filter((b) => b.kind === 'planet'),
          0,
        ),
      },
      {
        title: 'Dwarf planets & asteroids',
        items: flatten(
          sunKids.filter((b) => b.kind === 'dwarf-planet' || b.kind === 'asteroid'),
          0,
        ),
      },
    ];
  }, [ephemeris]);

  return (
    <nav className="panel picker" aria-label="Bodies">
      {groups.map((g) => (
        <div key={g.title} className="picker__group">
          <h2>{g.title}</h2>
          <ul>
            {g.items.map(({ def, depth }) => (
              <Item key={def.id} def={def} depth={depth} />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
