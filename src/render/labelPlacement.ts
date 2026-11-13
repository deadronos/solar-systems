import { Vector3, type Camera } from 'three';

const ndc = new Vector3();

/**
 * Position a DOM marker over a scene point (or hide it when off-screen / not visible).
 * `dx`/`dy` offset the marker in CSS pixels (used to stack markers at the same place).
 */
export function placeLabel(
  el: HTMLElement,
  scenePos: Vector3,
  camera: Camera,
  size: { width: number; height: number },
  visible: boolean,
  dx = 0,
  dy = 0,
): void {
  if (visible) {
    ndc.copy(scenePos).project(camera);
    visible = ndc.z < 1 && Math.abs(ndc.x) < 1.2 && Math.abs(ndc.y) < 1.2;
  }
  if (!visible) {
    if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
    return;
  }
  const x = (ndc.x * 0.5 + 0.5) * size.width + dx;
  const y = (-ndc.y * 0.5 + 0.5) * size.height + dy;
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
}
