import {
  AU_KM,
  DAYS_PER_JULIAN_CENTURY,
  GAUSS_MEAN_MOTION_DEG_PER_DAY,
  J2000,
} from '../constants.ts';
import { DEG } from '../math/vec3.ts';
import type { KeplerElements } from './kepler.ts';

/**
 * JPL "Keplerian Elements for Approximate Positions of the Major Planets"
 * (E.M. Standish, Table 1, valid 1800–2050 AD). Angles in degrees, rates per Julian century.
 * Reference frame: J2000 ecliptic & equinox, heliocentric.
 */
export interface JplApproxOrbit {
  kind: 'jplApprox';
  /** [a (AU), e, I, L (mean longitude), ϖ (longitude of perihelion), Ω] */
  elements: readonly [number, number, number, number, number, number];
  /** Rates of the above per Julian century. */
  rates: readonly [number, number, number, number, number, number];
}

/**
 * Mean elements at an epoch with uniform mean motion and optional secular precession
 * of the node and periapsis. Angles in degrees, distances in km.
 */
export interface MeanElementsOrbit {
  kind: 'meanElements';
  epochJd: number;
  aKm: number;
  e: number;
  iDeg: number;
  OmegaDeg: number;
  omegaDeg: number;
  /** Mean anomaly at epoch. */
  M0Deg: number;
  /** Sidereal orbital period (days). */
  periodDays: number;
  /** Secular nodal rate (deg/day). Negative = regression. */
  OmegaRateDegPerDay?: number;
  /** Secular rate of the argument of periapsis (deg/day). */
  omegaRateDegPerDay?: number;
}

export type OrbitModel = JplApproxOrbit | MeanElementsOrbit;

/** Osculating elements of an orbit model at a Julian date. */
export function elementsAt(model: OrbitModel, jd: number): KeplerElements {
  switch (model.kind) {
    case 'jplApprox': {
      const T = (jd - J2000) / DAYS_PER_JULIAN_CENTURY;
      const [a0, e0, I0, L0, w0, O0] = model.elements;
      const [aR, eR, IR, LR, wR, OR] = model.rates;
      const varpi = w0 + wR * T;
      const Omega = O0 + OR * T;
      return {
        a: (a0 + aR * T) * AU_KM,
        e: e0 + eR * T,
        i: (I0 + IR * T) * DEG,
        Omega: Omega * DEG,
        omega: (varpi - Omega) * DEG,
        M: (L0 + LR * T - varpi) * DEG,
      };
    }
    case 'meanElements': {
      const dt = jd - model.epochJd;
      return {
        a: model.aKm,
        e: model.e,
        i: model.iDeg * DEG,
        Omega: (model.OmegaDeg + (model.OmegaRateDegPerDay ?? 0) * dt) * DEG,
        omega: (model.omegaDeg + (model.omegaRateDegPerDay ?? 0) * dt) * DEG,
        M: (model.M0Deg + (360 / model.periodDays) * dt) * DEG,
      };
    }
  }
}

/** Time derivatives of an orbit model's elements, per day (km, rad). */
export interface ElementRates {
  aDot: number;
  eDot: number;
  iDot: number;
  OmegaDot: number;
  omegaDot: number;
  /** Mean motion (dM/dt). */
  n: number;
}

export function elementRates(model: OrbitModel): ElementRates {
  switch (model.kind) {
    case 'jplApprox': {
      // Per-century rates of a, e, I, L, ϖ, Ω → M = L − ϖ, ω = ϖ − Ω.
      const [aR, eR, IR, LR, wR, OR] = model.rates;
      const k = DEG / DAYS_PER_JULIAN_CENTURY;
      return {
        aDot: (aR * AU_KM) / DAYS_PER_JULIAN_CENTURY,
        eDot: eR / DAYS_PER_JULIAN_CENTURY,
        iDot: IR * k,
        OmegaDot: OR * k,
        omegaDot: (wR - OR) * k,
        n: (LR - wR) * k,
      };
    }
    case 'meanElements':
      return {
        aDot: 0,
        eDot: 0,
        iDot: 0,
        OmegaDot: (model.OmegaRateDegPerDay ?? 0) * DEG,
        omegaDot: (model.omegaRateDegPerDay ?? 0) * DEG,
        n: (360 / model.periodDays) * DEG,
      };
  }
}

/** Sidereal orbital period in days. */
export function periodDays(model: OrbitModel): number {
  switch (model.kind) {
    case 'jplApprox': {
      // Mean longitude rate minus perihelion rate gives the anomalistic period; close enough.
      const LR = model.rates[3];
      return (360 / LR) * DAYS_PER_JULIAN_CENTURY;
    }
    case 'meanElements':
      return model.periodDays;
  }
}

/** Whether the model's orbit shape/orientation drifts over time. */
export function hasSecularRates(model: OrbitModel): boolean {
  return model.kind === 'jplApprox' || !!model.OmegaRateDegPerDay || !!model.omegaRateDegPerDay;
}

/** Helper for heliocentric small bodies given in AU; period derived from Kepler's third law. */
export function heliocentric(params: {
  epochJd: number;
  aAU: number;
  e: number;
  iDeg: number;
  OmegaDeg: number;
  omegaDeg: number;
  M0Deg: number;
}): MeanElementsOrbit {
  const { aAU, ...rest } = params;
  return {
    kind: 'meanElements',
    ...rest,
    aKm: aAU * AU_KM,
    periodDays: 360 / (GAUSS_MEAN_MOTION_DEG_PER_DAY / aAU ** 1.5),
  };
}
