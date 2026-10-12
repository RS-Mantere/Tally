/**
 * XP, levels and the daily streak.
 *
 * Levels get gradually harder: 40 XP for the first, +20 for each one after.
 * The streak counts consecutive days on which at least one task was finished.
 */
'use strict';

const Game = (() => {
  const XP_BY_PRIORITY = { low: 5, med: 10, high: 20 };
  const FIRST_LEVEL_COST = 40;
  const LEVEL_STEP = 20;
  const MAX_LEVEL = 999;

  function xpFor(priority) {
    return XP_BY_PRIORITY[priority] ?? XP_BY_PRIORITY.low;
  }

  function costOfLevel(level) {
    return FIRST_LEVEL_COST + (level - 1) * LEVEL_STEP;
  }

  /** Splits a lifetime XP total into level / progress within that level. */
  function levelInfo(totalXp) {
    let level = 1;
    let remaining = Math.max(0, Math.floor(totalXp));
    let need = costOfLevel(level);

    while (remaining >= need && level < MAX_LEVEL) {
      remaining -= need;
      level += 1;
      need = costOfLevel(level);
    }

    return {
      level,
      into: remaining,
      need,
      fraction: need > 0 ? Math.min(1, remaining / need) : 1,
    };
  }

  /**
   * The streak as it stands right now. Stored streaks go stale on their own:
   * if the last finished day is older than yesterday the run is already over.
   */
  function liveStreak(progress, today = Dates.today()) {
    if (!progress.lastDoneDay) return 0;
    const gap = Dates.diffDays(progress.lastDoneDay, today);
    if (gap < 0) return progress.streak; // clock moved backwards; trust the record
    return gap <= 1 ? progress.streak : 0;
  }

  /** True when finishing a task right now would extend (not just hold) the streak. */
  function wouldExtendStreak(progress, today = Dates.today()) {
    return progress.lastDoneDay !== today;
  }

  /**
   * Applies one completed task to the progress record, in place.
   * @returns {{xp:number, levelBefore:number, levelAfter:number, leveledUp:boolean,
   *            streak:number, streakExtended:boolean}}
   */
  function award(progress, priority, today = Dates.today()) {
    const xp = xpFor(priority);
    const levelBefore = levelInfo(progress.xp).level;

    progress.xp += xp;
    progress.totalDone += 1;

    const streakExtended = progress.lastDoneDay !== today;
    if (streakExtended) {
      const gap = progress.lastDoneDay ? Dates.diffDays(progress.lastDoneDay, today) : Infinity;
      progress.streak = gap === 1 ? progress.streak + 1 : 1;
      progress.lastDoneDay = today;
    }
    progress.bestStreak = Math.max(progress.bestStreak, progress.streak);

    const day = progress.days[today] || { tasks: 0, xp: 0 };
    day.tasks += 1;
    day.xp += xp;
    progress.days[today] = day;

    const levelAfter = levelInfo(progress.xp).level;

    return {
      xp,
      levelBefore,
      levelAfter,
      leveledUp: levelAfter > levelBefore,
      streak: progress.streak,
      streakExtended,
    };
  }

  function dayTotals(progress, day = Dates.today()) {
    return progress.days[day] || { tasks: 0, xp: 0 };
  }

  return { xpFor, levelInfo, liveStreak, wouldExtendStreak, award, dayTotals, XP_BY_PRIORITY };
})();
