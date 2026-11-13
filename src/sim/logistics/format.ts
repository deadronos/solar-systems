export function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return '∞';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}₡${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}₡${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}₡${(a / 1e3).toFixed(1)}k`;
  return `${sign}₡${Math.round(a)}`;
}

export function fmtTonnes(t: number): string {
  if (t >= 1e6) return `${(t / 1e6).toFixed(2)} Mt`;
  if (t < 1) return `${t.toFixed(1)} t`;
  return `${String(Math.round(t)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} t`;
}
