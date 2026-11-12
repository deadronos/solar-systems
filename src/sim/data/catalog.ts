import { MINOR_BODIES } from './minorBodies.ts';
import { MOONS } from './moons.ts';
import { PLANETS, SUN } from './planets.ts';
import type { BodyDefinition } from './types.ts';

/** Every body known to the default simulation, in no particular order. */
export const DEFAULT_CATALOG: readonly BodyDefinition[] = [
  SUN,
  ...PLANETS,
  ...MINOR_BODIES,
  ...MOONS,
];

/** Sort so that every parent precedes its children. Throws on unknown parents or cycles. */
export function topologicalOrder(bodies: readonly BodyDefinition[]): BodyDefinition[] {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const ordered: BodyDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (b: BodyDefinition): void => {
    const s = state.get(b.id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`Cycle in body hierarchy at "${b.id}"`);
    state.set(b.id, 'visiting');
    if (b.parentId !== null) {
      const parent = byId.get(b.parentId);
      if (!parent) throw new Error(`Body "${b.id}" references unknown parent "${b.parentId}"`);
      visit(parent);
    }
    state.set(b.id, 'done');
    ordered.push(b);
  };

  for (const b of bodies) visit(b);
  return ordered;
}
