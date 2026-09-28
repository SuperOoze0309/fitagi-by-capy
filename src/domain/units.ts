import type { DistanceUnit, WeightUnit } from './types';

export const KG_PER_LB = 0.45359237;

export const WEIGHT_UNITS: WeightUnit[] = ['kg', 'lb'];
export const DISTANCE_UNITS: DistanceUnit[] = ['m', 'km', 'mi'];

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB;
}

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB;
}

/** Canonical storage value. Always kg, rounded to 1 g to avoid float noise. */
export function toKg(value: number, unit: WeightUnit): number {
  const kg = unit === 'kg' ? value : lbToKg(value);
  return round(kg, 4);
}

/** Convert a stored kg value into the unit currently used for display. */
export function fromKg(kg: number, unit: WeightUnit): number {
  return unit === 'kg' ? kg : kgToLb(kg);
}

export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value;
  return from === 'kg' ? kgToLb(value) : lbToKg(value);
}

/**
 * Round a display weight to a sensible step for its unit:
 * 0.5 kg / 1 lb, which matches real plate math closely enough.
 */
export function roundDisplayWeight(value: number, unit: WeightUnit): number {
  const step = unit === 'kg' ? 0.5 : 1;
  return round(Math.round(value / step) * step, 2);
}

/** Format a display weight without trailing zeros: 60, 62.5, 577. */
export function formatNumber(value: number | null | undefined, maxDecimals = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const fixed = value.toFixed(maxDecimals);
  // Only trim zeros that belong to a fractional part. A naive /\.?0+$/ would turn
  // 500 into "5" and 1000 into "1", silently shrinking every volume readout.
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

export function formatWeight(value: number | null | undefined, unit: WeightUnit): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${formatNumber(value)} ${unit}`;
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Parse a user-typed number, tolerating a comma decimal separator. */
export function parseNumberInput(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Duration formatting.
 *
 * The unit suffixes come from the active catalogue so a Chinese user reads
 * `1 小时 15 分` and a Spanish user `1 h 15 min`. The catalogue is injected as a
 * `t` function rather than imported, because `domain/` deliberately has no
 * dependency on React or on i18n state.
 */
type Translate = (key: 'units.seconds' | 'units.minutesSeconds' | 'units.hoursMinutes', params: Record<string, string | number>) => string;

export function formatDuration(totalSeconds: number, t?: Translate): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (!t) {
    // Fallback used by tests and by any caller without a translator.
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  if (h > 0) return t('units.hoursMinutes', { hours: h, minutes: m });
  if (m > 0) return t('units.minutesSeconds', { minutes: m, seconds: s });
  return t('units.seconds', { value: s });
}

/** mm:ss or h:mm:ss, locale-neutral because it is a clock. */
export function formatClock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
