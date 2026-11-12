import { AU_KM, jdToDate } from '../sim/index.ts';

export interface RatePreset {
  seconds: number;
  label: string;
}

/** Simulated seconds per real second. */
export const RATE_PRESETS: readonly RatePreset[] = [
  { seconds: 1, label: 'Real time' },
  { seconds: 60, label: '1 min/s' },
  { seconds: 600, label: '10 min/s' },
  { seconds: 3_600, label: '1 h/s' },
  { seconds: 21_600, label: '6 h/s' },
  { seconds: 86_400, label: '1 day/s' },
  { seconds: 604_800, label: '1 week/s' },
  { seconds: 2_629_800, label: '1 month/s' },
  { seconds: 31_557_600, label: '1 year/s' },
  { seconds: 315_576_000, label: '10 years/s' },
];

export function nearestPresetIndex(rate: number): number {
  const abs = Math.abs(rate);
  let best = 0;
  for (let i = 1; i < RATE_PRESETS.length; i++) {
    if (
      Math.abs(Math.log(RATE_PRESETS[i]!.seconds / abs)) <
      Math.abs(Math.log(RATE_PRESETS[best]!.seconds / abs))
    ) {
      best = i;
    }
  }
  return best;
}

export function formatRate(rate: number): string {
  const preset = RATE_PRESETS[nearestPresetIndex(rate)]!;
  return `${rate < 0 ? '−' : ''}${preset.label}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatJdDate(jd: number): { date: string; time: string } {
  const d = jdToDate(jd);
  if (Number.isNaN(d.getTime())) return { date: '—', time: '' };
  const y = d.getUTCFullYear();
  const year = y < 0 ? `${-y + 1} BC` : y > 9999 ? `+${y}` : String(y);
  return {
    date: `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`,
  };
}

export function formatDistance(km: number): string {
  if (km >= 0.05 * AU_KM) return `${(km / AU_KM).toFixed(km > 10 * AU_KM ? 1 : 3)} AU`;
  if (km >= 1e6) return `${(km / 1e6).toFixed(2)} million km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

export function formatPeriod(days: number): string {
  if (days >= 365.25 * 2) return `${(days / 365.25).toFixed(2)} years`;
  if (days >= 2) return `${days.toFixed(2)} days`;
  return `${(days * 24).toFixed(2)} hours`;
}

export function formatLightTime(km: number): string {
  const s = km / 299_792.458;
  if (s < 60) return `${s.toFixed(2)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} h`;
}
