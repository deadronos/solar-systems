import type { BodyDefinition } from '../sim/index.ts';
import { useViewStore } from '../state/viewStore.ts';
import { useRenderFrame, useSimulation } from './SimulationContext.tsx';

/**
 * One absolutely-positioned DOM layer holding every body label. The scene positions the
 * elements each frame via the shared `RenderFrame.labels` registry, so labels cost no React
 * renders and no extra React roots.
 */
export function LabelOverlay() {
  const { ephemeris } = useSimulation();
  return (
    <div className="label-layer" aria-hidden="false">
      {ephemeris.bodies.map((def) => (
        <Label key={def.id} def={def} />
      ))}
    </div>
  );
}

function Label({ def }: { def: BodyDefinition }) {
  const frame = useRenderFrame();
  const setFocus = useViewStore((s) => s.setFocus);
  return (
    <button
      type="button"
      ref={(el) => {
        if (!el) return;
        frame.labels.set(def.id, el);
        return () => {
          frame.labels.delete(def.id);
        };
      }}
      className={`body-label body-label--${def.kind}`}
      style={{ visibility: 'hidden' }}
      onClick={() => setFocus(def.id)}
    >
      {def.name}
    </button>
  );
}
