import { useSelectionStore } from './selectionStore.ts';
import { useViewStore } from './viewStore.ts';

/**
 * Focus the camera on a body and select it. Stops following any ship or settlement first,
 * otherwise the camera would stay on the followed entity (see `cameraTarget`).
 */
export function focusBody(id: string): void {
  const selection = useSelectionStore.getState();
  selection.setFollow(false);
  useViewStore.getState().setFocus(id);
  selection.select({ kind: 'body', id });
}
