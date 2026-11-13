import { create } from 'zustand';

export type EntityKind = 'body' | 'settlement' | 'ship' | 'company' | 'contract';

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

export interface Overlays {
  tradeFlows: boolean;
  allTrajectories: boolean;
  shortages: boolean;
  ships: boolean;
}

export interface SelectionState {
  selected: EntityRef | null;
  /** Previously selected entities (most recent last). */
  history: EntityRef[];
  /** Entities to return to after going back (most recent last). */
  future: EntityRef[];
  /** Camera follows the selected entity (floating origin = its position). */
  follow: boolean;
  companyFilter: string | null;
  overlays: Overlays;
  select(ref: EntityRef | null): void;
  back(): void;
  forward(): void;
  setFollow(follow: boolean): void;
  setCompanyFilter(id: string | null): void;
  toggleOverlay(key: keyof Overlays): void;
}

const same = (a: EntityRef | null, b: EntityRef | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;
const MAX_HISTORY = 50;

/** Selection & inspection state (RTS-style), with browser-like back/forward. */
export const useSelectionStore = create<SelectionState>()((set) => ({
  selected: null,
  history: [],
  future: [],
  follow: false,
  companyFilter: null,
  overlays: { tradeFlows: false, allTrajectories: false, shortages: false, ships: true },
  select: (ref) =>
    set((s) => {
      if (same(s.selected, ref)) return s;
      const history = s.selected ? [...s.history, s.selected].slice(-MAX_HISTORY) : s.history;
      return { selected: ref, history, future: [], follow: ref ? s.follow : false };
    }),
  back: () =>
    set((s) => {
      const prev = s.history.at(-1);
      if (!prev) return s;
      return {
        selected: prev,
        history: s.history.slice(0, -1),
        future: s.selected ? [...s.future, s.selected] : s.future,
      };
    }),
  forward: () =>
    set((s) => {
      const next = s.future.at(-1);
      if (!next) return s;
      return {
        selected: next,
        future: s.future.slice(0, -1),
        history: s.selected ? [...s.history, s.selected] : s.history,
      };
    }),
  setFollow: (follow) => set({ follow }),
  setCompanyFilter: (companyFilter) => set({ companyFilter }),
  toggleOverlay: (key) => set((s) => ({ overlays: { ...s.overlays, [key]: !s.overlays[key] } })),
}));
