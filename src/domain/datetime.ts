/**
 * Small date/time helpers. Everything the user sees is local time; everything
 * we store is an ISO-8601 UTC string.
 *
 * Locale-aware *display* helpers take the active BCP-47 tag as an optional last
 * argument. When it is omitted the runtime default is used, which keeps this
 * module usable from tests and from non-React callers.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(date: Date): string {
  return date.toISOString();
}

/** Local calendar day key, YYYY-MM-DD. Always locale-independent. */
export function localDateKey(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfLocalDay(input: string | Date): Date {
  const d = typeof input === 'string' ? new Date(input) : new Date(input.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(input: Date, days: number): Date {
  const d = new Date(input.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** Monday-based start of the local week. */
export function startOfLocalWeek(input: Date): Date {
  const d = startOfLocalDay(input);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  return addDays(d, -dow);
}

export function formatTime(input: string, intlTag?: string): string {
  return new Date(input).toLocaleTimeString(intlTag, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(input: string, intlTag?: string): string {
  return new Date(input).toLocaleDateString(intlTag, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(input: string, intlTag?: string): string {
  return `${formatDate(input, intlTag)} · ${formatTime(input, intlTag)}`;
}

/**
 * Short weekday names, Sunday first, in the locale's own language.
 *
 * Built from `Intl` rather than seven catalogue keys: the names already exist in
 * every locale the platform ships, and a reminder schedule is the last place that
 * should be translated by hand.
 */
export function weekdayNames(intlTag?: string): string[] {
  const formatter = new Intl.DateTimeFormat(intlTag, { weekday: 'short' });
  // 2026-03-01 is a Sunday, so index 0 is Sunday and it matches `Date.getDay()`.
  return Array.from({ length: 7 }, (_, weekday) =>
    formatter.format(new Date(2026, 2, 1 + weekday)),
  );
}

/** `"HH:MM"` in the locale's clock convention. */
export function formatTimeOfDay(time: string, intlTag?: string): string {
  const [hour, minute] = time.split(':').map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return time;
  return new Date(2026, 2, 1, hour, minute).toLocaleTimeString(intlTag, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * "Today" / "Yesterday" / a localised date, used as History group headers.
 *
 * The two relative labels are passed in rather than looked up, so this module
 * stays free of i18n state; callers that have a translator supply them.
 */
export function formatDayLabel(
  dateKey: string,
  options: { today?: string; yesterday?: string; intlTag?: string } = {},
): string {
  const todayKey = localDateKey(new Date());
  const yesterdayKey = localDateKey(addDays(new Date(), -1));
  if (dateKey === todayKey) return options.today ?? 'Today';
  if (dateKey === yesterdayKey) return options.yesterday ?? 'Yesterday';

  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(options.intlTag, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: y === new Date().getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Relative time such as "3h ago", localised through `Intl.RelativeTimeFormat`.
 *
 * Falls back to a plain English-ish form only when the runtime lacks the API,
 * which no supported target does.
 */export function formatRelative(input: string, intlTag?: string): string {
  const then = new Date(input).getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return '—';

  const rtf =
    typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
      ? new Intl.RelativeTimeFormat(intlTag, { numeric: 'auto', style: 'narrow' })
      : null;

  if (diffMin < 60) return rtf ? rtf.format(-diffMin, 'minute') : `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return rtf ? rtf.format(-diffH, 'hour') : `${diffH}h`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 30) return rtf ? rtf.format(-diffD, 'day') : `${diffD}d`;
  return formatDate(input, intlTag);
}

/** `datetime-local` input value (local wall clock, no timezone suffix). */
export function toDateTimeLocalValue(input: string): string {
  const d = new Date(input);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function fromDateTimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}
