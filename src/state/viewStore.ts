import { create } from 'zustand';

export interface Layers {
  orbits: boolean;
  moonOrbits: boolean;
  labels: boolean;
  belts: boolean;
  stars: boolean;
}

export interface ViewState {
  /** Body the camera orbits; it is also the floating origin of the scene. */
  focusId: string;
  layers: Layers;
  /**
   * Minimum on-screen radius (px) for bodies. 0 = strict true scale (most bodies are
   * sub-pixel at system scale). Distances are never exaggerated.
   */
  minPixelRadius: number;
  setFocus(id: string): void;
  toggleLayer(layer: keyof Layers): void;
  setMinPixelRadius(px: number): void;
}

/** UI/view state only. Simulation state lives in the sim layer (see SimClock). */
export const useViewStore = create<ViewState>()((set) => ({
  focusId: 'sun',
  layers: { orbits: true, moonOrbits: true, labels: true, belts: true, stars: true },
  minPixelRadius: 2.5,
  setFocus: (focusId) => set({ focusId }),
  toggleLayer: (layer) => set((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } })),
  setMinPixelRadius: (minPixelRadius) => set({ minPixelRadius }),
}));
