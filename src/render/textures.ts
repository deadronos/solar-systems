import { CanvasTexture, Color, SRGBColorSpace, type Texture } from 'three';
import type { Appearance } from './appearance.ts';

const cache = new Map<string, Texture>();

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Seeded value noise, enough for plausible procedural surfaces. */
function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  let s = seed;
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    s = (s * 16_807) % 2_147_483_647;
    const j = s % (i + 1);
    const t = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i]!;
  const hash = (x: number, y: number) => perm[(perm[x & 255]! + y) & 511]! / 255;
  const noise = (x: number, y: number, wrap: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const x0 = ((xi % wrap) + wrap) % wrap;
    const x1 = (x0 + 1) % wrap;
    const a = hash(x0, yi);
    const b = hash(x1, yi);
    const c = hash(x0, yi + 1);
    const d = hash(x1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x: number, y: number, octaves = 4) => {
    let v = 0;
    let amp = 0.5;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      const wrap = 8 * f;
      v += amp * noise(x * wrap, y * 8 * f, wrap);
      amp *= 0.5;
      f *= 2;
    }
    return v;
  };
}

const hashString = (s: string) => {
  let h = 2_166_136_261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16_777_619);
  return ((h >>> 0) % 2_147_483_646) + 1;
};

/** Equirectangular procedural texture for a body (cached). */
export function surfaceTexture(id: string, look: Appearance): Texture {
  const cached = cache.get(id);
  if (cached) return cached;

  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const noise = makeNoise(hashString(id));
  const c1 = new Color(look.color);
  const c2 = new Color(look.secondary ?? look.color).lerp(
    new Color('#000000'),
    look.secondary ? 0 : 0.35,
  );
  const ocean = new Color('#1d4f8f');
  const land = new Color('#4f7a3a');
  const desert = new Color('#b59a68');
  const ice = new Color('#f2f5f7');
  const tmp = new Color();

  for (let y = 0; y < h; y++) {
    const lat = y / h; // 0 = north pole
    for (let x = 0; x < w; x++) {
      const u = x / w;
      let t: number;
      switch (look.surface) {
        case 'banded': {
          const turb = noise(u, lat * 0.5, 3) * 0.15;
          t = 0.5 + 0.5 * Math.sin((lat + turb) * Math.PI * 18 + noise(u * 0.3, lat, 2) * 2);
          tmp.copy(c1).lerp(c2, t);
          break;
        }
        case 'earth': {
          const n = noise(u, lat, 5);
          const polar = Math.abs(lat - 0.5) * 2;
          if (polar > 0.86) tmp.copy(ice);
          else if (n > 0.52)
            tmp.copy(land).lerp(desert, Math.max(0, 1 - Math.abs(polar - 0.35) * 4) * 0.7);
          else tmp.copy(ocean).lerp(new Color('#0c2d5a'), 0.5 - n);
          const cloud = noise(u + 0.37, lat, 4);
          if (cloud > 0.58) tmp.lerp(ice, Math.min(1, (cloud - 0.58) * 4));
          break;
        }
        case 'cloudy':
          t = noise(u, lat, 3) * 0.6 + 0.5 * Math.sin(lat * Math.PI * 6) * 0.1;
          tmp.copy(c1).lerp(c2, t);
          break;
        case 'icy':
          t = noise(u, lat, 4);
          tmp.copy(c1).lerp(c2, t * 0.6);
          break;
        case 'star':
          t = noise(u, lat, 5);
          tmp.copy(c1).multiplyScalar(0.85 + t * 0.3);
          break;
        case 'rocky':
        default:
          t = noise(u, lat, 5);
          tmp.copy(c1).lerp(c2, Math.min(1, t * 1.2));
          break;
      }
      const o = (y * w + x) * 4;
      img.data[o] = Math.min(255, tmp.r * 255);
      img.data[o + 1] = Math.min(255, tmp.g * 255);
      img.data[o + 2] = Math.min(255, tmp.b * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  cache.set(id, tex);
  return tex;
}

/** Radial ring texture (u = radius from inner→outer), with Cassini-division-like gaps. */
export function ringTexture(id: string, color: string): Texture {
  const key = `ring:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const w = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, 1);
  const noise = makeNoise(hashString(key));
  const base = new Color(color);
  for (let x = 0; x < w; x++) {
    const r = x / w;
    let alpha = 0.35 + noise(r * 4, 0.5, 4) * 0.65;
    if (id === 'saturn') {
      // Approximate structure: faint C ring, bright B ring, Cassini division, A ring, Encke gap.
      if (r < 0.2) alpha *= 0.25;
      else if (r < 0.52) alpha *= 1;
      else if (r < 0.58) alpha *= 0.08;
      else if (r > 0.9 && r < 0.91) alpha *= 0.1;
      else alpha *= 0.7;
    }
    const o = x * 4;
    img.data[o] = base.r * 255;
    img.data[o + 1] = base.g * 255;
    img.data[o + 2] = base.b * 255;
    img.data[o + 3] = Math.min(255, alpha * 255);
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Soft radial glow sprite for the Sun. */
export function glowTexture(): Texture {
  const cached = cache.get('glow');
  if (cached) return cached;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.15, 'rgba(255,210,120,0.6)');
  g.addColorStop(0.4, 'rgba(255,170,60,0.15)');
  g.addColorStop(1, 'rgba(255,150,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  cache.set('glow', tex);
  return tex;
}
