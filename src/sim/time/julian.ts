import { J2000, SECONDS_PER_DAY } from '../constants.ts';

/** Julian date of the Unix epoch (1970-01-01 00:00 UTC). */
const UNIX_EPOCH_JD = 2_440_587.5;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

/**
 * Convert a JS Date to a Julian date.
 * Note: UTC is used as a stand-in for TDB (≈69 s difference), which is far below the
 * accuracy of the mean-element models used here.
 */
export const dateToJd = (date: Date): number => date.getTime() / MS_PER_DAY + UNIX_EPOCH_JD;

export const jdToDate = (jd: number): Date => new Date((jd - UNIX_EPOCH_JD) * MS_PER_DAY);

export const daysSinceJ2000 = (jd: number): number => jd - J2000;
