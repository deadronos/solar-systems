/**
 * Visual styling per body — presentation-only data, kept out of the sim catalog.
 * Textures are generated procedurally (see textures.ts) so the app has no binary assets.
 */
export type SurfaceStyle = 'star' | 'banded' | 'rocky' | 'earth' | 'icy' | 'cloudy';

export interface RingStyle {
  innerKm: number;
  outerKm: number;
  color: string;
  opacity: number;
}

export interface Appearance {
  color: string;
  secondary?: string;
  surface: SurfaceStyle;
  rings?: RingStyle;
}

const DEFAULT: Appearance = { color: '#9a958f', surface: 'rocky' };

const APPEARANCES: Record<string, Appearance> = {
  sun: { color: '#ffd27a', surface: 'star' },
  mercury: { color: '#9c9289', secondary: '#6e665f', surface: 'rocky' },
  venus: { color: '#e8cf9a', secondary: '#c9a96a', surface: 'cloudy' },
  earth: { color: '#2f6fb7', secondary: '#4f8a3c', surface: 'earth' },
  mars: { color: '#c1532f', secondary: '#8a3b22', surface: 'rocky' },
  jupiter: { color: '#d8b48a', secondary: '#a46f4a', surface: 'banded' },
  saturn: {
    color: '#e3cf9c',
    secondary: '#b89c66',
    surface: 'banded',
    rings: { innerKm: 66_900, outerKm: 136_775, color: '#d8c7a0', opacity: 0.85 },
  },
  uranus: {
    color: '#a6dde3',
    secondary: '#8cc8d0',
    surface: 'banded',
    rings: { innerKm: 41_800, outerKm: 51_150, color: '#8a9aa0', opacity: 0.25 },
  },
  neptune: { color: '#4a6fd6', secondary: '#3555b0', surface: 'banded' },
  pluto: { color: '#d9c3a8', secondary: '#8f6e55', surface: 'icy' },
  charon: { color: '#a29a92', surface: 'icy' },
  ceres: { color: '#8d8a86', surface: 'rocky' },
  eris: { color: '#e8e6e3', surface: 'icy' },
  haumea: { color: '#e0e0e0', surface: 'icy' },
  makemake: { color: '#c99a7a', surface: 'icy' },
  sedna: { color: '#b0533a', surface: 'icy' },
  moon: { color: '#a8a39c', secondary: '#77726c', surface: 'rocky' },
  io: { color: '#e5d36a', secondary: '#b37a2e', surface: 'rocky' },
  europa: { color: '#d9c9b0', secondary: '#9c7c5c', surface: 'icy' },
  ganymede: { color: '#9e9282', secondary: '#6b5f50', surface: 'rocky' },
  callisto: { color: '#6f6457', secondary: '#4a4138', surface: 'rocky' },
  titan: { color: '#d9a548', secondary: '#c08a30', surface: 'cloudy' },
  enceladus: { color: '#f4f6f8', surface: 'icy' },
  triton: { color: '#d6c8c0', secondary: '#b79d92', surface: 'icy' },
  iapetus: { color: '#8c8070', secondary: '#2d2722', surface: 'rocky' },
};

export const appearanceFor = (id: string): Appearance => APPEARANCES[id] ?? DEFAULT;

/** Colors for belt particle clouds. */
export const BELT_COLORS: Record<string, string> = {
  'main-belt': '#b8a58a',
  hildas: '#c9b48c',
  'jupiter-trojans': '#d49a6a',
  'kuiper-belt': '#7fa4c9',
  'scattered-disc': '#8a7fc9',
};
