/**
 * Local-time date helpers. Dates are stored as 'YYYY-MM-DD' strings so that a
 * task due "today" stays due today regardless of timezone maths.
 */
'use strict';

const Dates = (() => {
  const DAY_MS = 86400000;
  const LOCALE = 'en-GB'; // day-first, short month names

  function isoDay(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function today() {
    return isoDay(new Date());
  }

  /** 'YYYY-MM-DD' -> Date at local midnight. */
  function toDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(iso, n) {
    const date = toDate(iso);
    date.setDate(date.getDate() + n);
    return isoDay(date);
  }

  function addMonths(iso, n) {
    const date = toDate(iso);
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + n);
    // Clamp 31 Jan + 1 month to the end of February rather than rolling over.
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
    return isoDay(date);
  }

  /** Whole days from `a` to `b`; positive when `b` is later. */
  function diffDays(a, b) {
    return Math.round((toDate(b) - toDate(a)) / DAY_MS);
  }

  function weekday(iso) {
    return toDate(iso).getDay(); // 0 = Sunday
  }

  /** Builds a valid ISO day, or null if the calendar rejects it (e.g. 31 Feb). */
  function fromParts(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return isoDay(date);
  }

  /** Next occurrence of a weekday, counting today as a match. */
  function nextWeekday(target, from = today()) {
    const delta = (target - weekday(from) + 7) % 7;
    return addDays(from, delta);
  }

  /** Next occurrence of a weekday, always strictly in the future. */
  function nextWeekdayAfter(target, from = today()) {
    const delta = (target - weekday(from) + 7) % 7;
    return addDays(from, delta === 0 ? 7 : delta);
  }

  /** Short label for a due chip: Today / Tomorrow / Fri 19 Sep / 19 Sep 2027. */
  function formatDue(iso, base = today()) {
    const delta = diffDays(base, iso);
    if (delta === 0) return 'Today';
    if (delta === 1) return 'Tomorrow';
    if (delta === -1) return 'Yesterday';
    const date = toDate(iso);
    if (delta < 0 && delta > -7) {
      return date.toLocaleDateString(LOCALE, { weekday: 'short' });
    }
    if (delta > 0 && delta < 7) {
      return date.toLocaleDateString(LOCALE, { weekday: 'short' });
    }
    const sameYear = date.getFullYear() === toDate(base).getFullYear();
    return date.toLocaleDateString(
      LOCALE,
      sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }
    );
  }

  /** Longer label used for group headings. */
  function formatHeading(iso, base = today()) {
    const delta = diffDays(base, iso);
    if (delta === 0) return 'Today';
    if (delta === 1) return 'Tomorrow';
    if (delta === -1) return 'Yesterday';
    const date = toDate(iso);
    const sameYear = date.getFullYear() === toDate(base).getFullYear();
    return date.toLocaleDateString(LOCALE, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  }

  function formatFull(iso) {
    return toDate(iso).toLocaleDateString(LOCALE, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  return {
    isoDay,
    today,
    toDate,
    addDays,
    addMonths,
    diffDays,
    weekday,
    fromParts,
    nextWeekday,
    nextWeekdayAfter,
    formatDue,
    formatHeading,
    formatFull,
  };
})();
