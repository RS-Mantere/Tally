/**
 * Turns a single line of typed text into a task.
 *
 *   "Renew passport !! #admin 25.9"
 *     -> { title: 'Renew passport', tags: ['admin'], priority: 'high', due: '…-09-25' }
 *
 * Tags and priority marks are recognised anywhere in the line; dates and
 * repeats only at the very end, so an ordinary title like "Read today's paper"
 * is left alone. Whatever the parser takes is shown back to the user as a
 * preview chip, so nothing disappears silently.
 */
'use strict';

const Parse = (() => {
  const WEEKDAYS = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  const WEEKDAY_ALTERNATION = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');

  const TAG_RE = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})/gu;
  const PRIORITY_RE = /(^|\s)(!{1,3})(?=\s|$)/g;

  function squash(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  /* --------------------------------------------------------------- repeats */

  const REPEAT_RULES = [
    { re: new RegExp(`\\severy\\s+((?:${WEEKDAY_ALTERNATION})(?:\\s*(?:,|and|&)\\s*(?:${WEEKDAY_ALTERNATION}))*)$`, 'i'),
      build: (m) => {
        const days = m[1]
          .toLowerCase()
          .split(/\s*(?:,|and|&)\s*/)
          .map((name) => WEEKDAYS[name])
          .filter((d) => Number.isInteger(d));
        return days.length ? { type: 'weekly', days: [...new Set(days)].sort() } : null;
      } },
    { re: /\s(?:every\s*weekdays?|each\s*weekday)$/i, build: () => ({ type: 'weekdays', days: [] }) },
    { re: /\s(?:every\s*day|daily|each\s*day)$/i, build: () => ({ type: 'daily', days: [] }) },
    { re: /\s(?:every\s*week|weekly)$/i, build: () => ({ type: 'weekly', days: [] }) },
    { re: /\s(?:every\s*month|monthly)$/i, build: () => ({ type: 'monthly', days: [] }) },
  ];

  function takeRepeat(text) {
    for (const rule of REPEAT_RULES) {
      const match = text.match(rule.re);
      if (!match) continue;
      const recurrence = rule.build(match);
      if (!recurrence) continue;
      return { recurrence, rest: text.slice(0, match.index), token: match[0].trim() };
    }
    return { recurrence: null, rest: text, token: null };
  }

  /* ----------------------------------------------------------------- dates */

  function takeDue(text, today) {
    const attempts = [
      { re: /\s(?:due\s+)?(?:today|tod)$/i, due: () => today },
      { re: /\s(?:due\s+)?(?:tomorrow|tomo|tmrw|tmr|tom)$/i, due: () => Dates.addDays(today, 1) },
      { re: /\snext\s+week$/i, due: () => Dates.addDays(today, 7) },
      { re: /\snext\s+month$/i, due: () => Dates.addMonths(today, 1) },
      { re: /\s(?:this\s+)?weekend$/i, due: () => Dates.nextWeekday(6, today) },
      {
        re: /\sin\s+(\d{1,3})\s*(days?|d|weeks?|w|months?|mo|m)$/i,
        due: (m) => {
          const n = Number(m[1]);
          const unit = m[2].toLowerCase();
          if (unit.startsWith('d')) return Dates.addDays(today, n);
          if (unit.startsWith('w')) return Dates.addDays(today, n * 7);
          return Dates.addMonths(today, n);
        },
      },
      {
        re: new RegExp(`\\s(?:due\\s+|on\\s+|next\\s+)?(${WEEKDAY_ALTERNATION})$`, 'i'),
        due: (m, raw) => {
          const target = WEEKDAYS[m[1].toLowerCase()];
          // "next fri" always means the following week, plain "fri" can mean today.
          return /next\s/i.test(raw)
            ? Dates.nextWeekdayAfter(target, today)
            : Dates.nextWeekday(target, today);
        },
      },
      {
        re: /\s(\d{4})-(\d{1,2})-(\d{1,2})$/,
        due: (m) => Dates.fromParts(Number(m[1]), Number(m[2]), Number(m[3])),
      },
      {
        // Day-first, the European way: 25.9, 25.9.2026, 25/9, 25/9/26
        re: /\s(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2}|\d{4}))?\.?$/,
        due: (m) => {
          const day = Number(m[1]);
          const month = Number(m[2]);
          let year;
          if (m[3] === undefined) {
            year = Dates.toDate(today).getFullYear();
          } else {
            year = Number(m[3]);
            if (year < 100) year += 2000;
          }
          let iso = Dates.fromParts(year, month, day);
          // A bare day.month that has already gone by means next year.
          if (iso && m[3] === undefined && Dates.diffDays(today, iso) < 0) {
            iso = Dates.fromParts(year + 1, month, day);
          }
          return iso;
        },
      },
    ];

    for (const attempt of attempts) {
      const match = text.match(attempt.re);
      if (!match) continue;
      const due = attempt.due(match, match[0]);
      if (!due) continue; // e.g. 31.2 — not a real date, leave the words alone
      return { due, rest: text.slice(0, match.index), token: match[0].trim() };
    }
    return { due: null, rest: text, token: null };
  }

  /* ----------------------------------------------------------------- entry */

  /**
   * @param {string} input   raw text from the composer
   * @param {string} [today] ISO day used as the anchor for relative dates
   */
  function line(input, today = Dates.today()) {
    let text = String(input || '').replace(/\s+/g, ' ');

    const tags = [];
    text = text.replace(TAG_RE, (_match, lead, tag) => {
      tags.push(tag.toLowerCase());
      return lead;
    });

    let priority = 'low';
    let priorityToken = null;
    text = text.replace(PRIORITY_RE, (_match, lead, marks) => {
      priority = marks.length >= 2 ? 'high' : 'med';
      priorityToken = marks;
      return lead;
    });

    const repeat = takeRepeat(text.replace(/\s+$/, ''));
    const dueResult = takeDue(repeat.rest.replace(/\s+$/, ''), today);

    return {
      title: squash(dueResult.rest),
      tags: [...new Set(tags)].slice(0, 12),
      priority,
      due: dueResult.due,
      recurrence: repeat.recurrence,
      matched: {
        tags,
        priority: priorityToken,
        due: dueResult.token,
        repeat: repeat.token,
      },
    };
  }

  /** Human-readable label for a recurrence rule. */
  function describeRepeat(recurrence) {
    if (!recurrence) return '';
    if (recurrence.type === 'daily') return 'every day';
    if (recurrence.type === 'weekdays') return 'every weekday';
    if (recurrence.type === 'monthly') return 'every month';
    if (recurrence.type === 'weekly') {
      if (!recurrence.days || !recurrence.days.length) return 'every week';
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `every ${recurrence.days.map((d) => names[d]).join(', ')}`;
    }
    return '';
  }

  /** The next due date for a repeating task once the current one is finished. */
  function nextOccurrence(recurrence, fromIso, today = Dates.today()) {
    if (!recurrence) return null;
    // Anchor on whichever is later so finishing a long-overdue habit does not
    // immediately spawn another overdue copy.
    const base = fromIso && Dates.diffDays(today, fromIso) > 0 ? fromIso : today;

    switch (recurrence.type) {
      case 'daily':
        return Dates.addDays(base, 1);
      case 'weekdays': {
        let next = Dates.addDays(base, 1);
        while (Dates.weekday(next) === 0 || Dates.weekday(next) === 6) {
          next = Dates.addDays(next, 1);
        }
        return next;
      }
      case 'monthly':
        return Dates.addMonths(base, 1);
      case 'weekly': {
        if (!recurrence.days || !recurrence.days.length) return Dates.addDays(base, 7);
        const candidates = recurrence.days.map((d) => Dates.nextWeekdayAfter(d, base));
        return candidates.sort((a, b) => Dates.diffDays(a, b))[0];
      }
      default:
        return null;
    }
  }

  return { line, describeRepeat, nextOccurrence, WEEKDAYS };
})();
