import { BodyPicker } from './BodyPicker.tsx';
import { InfoPanel } from './InfoPanel.tsx';
import { LayerToggles } from './LayerToggles.tsx';
import { TimeControls } from './TimeControls.tsx';

/** DOM overlay. Reads the sim through the context API only; never touches three.js. */
export function Hud() {
  return (
    <div className="hud">
      <div className="hud__left">
        <BodyPicker />
      </div>
      <div className="hud__right">
        <InfoPanel />
        <LayerToggles />
      </div>
      <div className="hud__bottom">
        <TimeControls />
        <p className="hint">
          Drag to orbit · scroll to zoom · click a body or label to focus · Space pause · [ ] speed
          · R reverse · N now
        </p>
      </div>
    </div>
  );
}
