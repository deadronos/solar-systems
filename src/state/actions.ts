import { useSelectionStore } from './selectionStore.ts';
import { useViewStore } from './viewStore.ts';

/**
 * Focus the camera on a body and select it. Stops following any ship or settlement first,
 * otherwise the camera would stay on the followed entity (see `cameraTarget`).
 */
export function focusBody(id: string): void {
  setBodyFocus(id);
  useSelectionStore.getState().select({ kind: 'body', id });
}

function setBodyFocus(id: string): void {
  useSelectionStore.getState().setFollow(false);
  useViewStore.getState().setFocus(id);
}

/** Restore camera focus when history lands on a body without adding a selection entry. */
export function navigateSelectionHistory(direction: 'back' | 'forward'): boolean {
  const selection = useSelectionStore.getState();
  const target = (direction === 'back' ? selection.history : selection.future).at(-1);
  if (!target) return false;
  if (target.kind === 'body') setBodyFocus(target.id);
  selection[direction]();
  return true;
}
