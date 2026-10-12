/**
 * Durable JSON store for Tally.
 *
 * Everything lives in one file under %APPDATA%\Tally\data.json. Writes are
 * debounced and atomic (temp file + rename) so a crash or a power cut can
 * never leave a half-written file behind, and a file that fails to parse is
 * moved aside rather than overwritten.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const WRITE_DEBOUNCE_MS = 250;

const PRIORITIES = new Set(['low', 'med', 'high']);
const RECURRENCE_TYPES = new Set(['daily', 'weekdays', 'weekly', 'monthly']);
const VIEWS = new Set(['today', 'upcoming', 'all', 'done']);

function defaultData() {
  return {
    version: SCHEMA_VERSION,
    tasks: [],
    progress: {
      xp: 0,
      streak: 0,
      bestStreak: 0,
      lastDoneDay: null, // 'YYYY-MM-DD'
      totalDone: 0,
      days: {}, // 'YYYY-MM-DD' -> { tasks, xp }
    },
    settings: {
      sound: true,
      launchOnStartup: false,
      minimiseToTray: true,
      startMinimised: false,
      view: 'today',
    },
    window: { width: 460, height: 660, x: null, y: null },
  };
}

/* ------------------------------------------------------------ sanitisation */

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function isIsoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normaliseRecurrence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!RECURRENCE_TYPES.has(raw.type)) return null;
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  return { type: raw.type, days };
}

function normaliseTask(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, 500).trim();
  if (!title) return null;
  return {
    id: str(raw.id, 64) || `t${Date.now().toString(36)}${index}`,
    title,
    tags: Array.isArray(raw.tags)
      ? [...new Set(raw.tags.map((t) => str(t, 40).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
      : [],
    priority: PRIORITIES.has(raw.priority) ? raw.priority : 'low',
    due: isIsoDay(raw.due) ? raw.due : null,
    recurrence: normaliseRecurrence(raw.recurrence),
    createdAt: num(raw.createdAt, Date.now()),
    completedAt: Number.isFinite(raw.completedAt) ? raw.completedAt : null,
    xpAwarded: num(raw.xpAwarded, 0),
    order: num(raw.order, index),
  };
}

/** Coerces anything read off disk (or out of an import file) into a valid shape. */
function normalise(raw) {
  const base = defaultData();
  if (!raw || typeof raw !== 'object') return base;

  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map(normaliseTask).filter(Boolean).slice(0, 20000)
    : [];

  const rawProgress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  const days = {};
  if (rawProgress.days && typeof rawProgress.days === 'object') {
    for (const [day, entry] of Object.entries(rawProgress.days)) {
      if (!isIsoDay(day) || !entry || typeof entry !== 'object') continue;
      days[day] = { tasks: Math.max(0, num(entry.tasks)), xp: Math.max(0, num(entry.xp)) };
    }
  }

  const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const rawWindow = raw.window && typeof raw.window === 'object' ? raw.window : {};

  return {
    version: SCHEMA_VERSION,
    tasks,
    progress: {
      xp: Math.max(0, num(rawProgress.xp)),
      streak: Math.max(0, num(rawProgress.streak)),
      bestStreak: Math.max(0, num(rawProgress.bestStreak)),
      lastDoneDay: isIsoDay(rawProgress.lastDoneDay) ? rawProgress.lastDoneDay : null,
      totalDone: Math.max(0, num(rawProgress.totalDone)),
      days,
    },
    settings: {
      sound: bool(rawSettings.sound, true),
      launchOnStartup: bool(rawSettings.launchOnStartup, false),
      minimiseToTray: bool(rawSettings.minimiseToTray, true),
      startMinimised: bool(rawSettings.startMinimised, false),
      view: VIEWS.has(rawSettings.view) ? rawSettings.view : 'today',
    },
    window: {
      width: Math.max(360, Math.min(2000, num(rawWindow.width, base.window.width))),
      height: Math.max(420, Math.min(2000, num(rawWindow.height, base.window.height))),
      x: Number.isFinite(rawWindow.x) ? rawWindow.x : null,
      y: Number.isFinite(rawWindow.y) ? rawWindow.y : null,
    },
  };
}

/* -------------------------------------------------------------------- store */

class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'data.json');
    this.data = defaultData();
    this.timer = null;
    this.dirty = false;
  }

  load() {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
    } catch (err) {
      console.error('[store] could not create data directory:', err.message);
    }

    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[store] read failed:', err.message);
      this.data = defaultData();
      return this.data;
    }

    try {
      this.data = normalise(JSON.parse(text));
    } catch (err) {
      // Never silently discard: park the unreadable file next to the good one.
      const backup = path.join(this.directory, `data.corrupt-${Date.now()}.json`);
      try {
        fs.writeFileSync(backup, text);
        console.error(`[store] data.json unreadable (${err.message}); copy saved to ${backup}`);
      } catch (backupErr) {
        console.error('[store] could not back up the unreadable file:', backupErr.message);
      }
      this.data = defaultData();
    }
    return this.data;
  }

  /** Replaces the persisted document and schedules a write. */
  replace(raw) {
    this.data = normalise(raw);
    this.dirty = true;
    this.schedule();
    return this.data;
  }

  /** Shallow-merges top-level keys (used for window bounds and settings). */
  merge(patch) {
    this.data = normalise({ ...this.data, ...patch });
    this.dirty = true;
    this.schedule();
    return this.data;
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return true;

    const temp = `${this.file}.tmp`;
    try {
      const payload = JSON.stringify(this.data, null, 2);
      const handle = fs.openSync(temp, 'w');
      try {
        fs.writeFileSync(handle, payload, 'utf8');
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temp, this.file);
      this.dirty = false;
      return true;
    } catch (err) {
      console.error('[store] write failed:', err.message);
      try {
        fs.unlinkSync(temp);
      } catch {
        /* nothing to clean up */
      }
      return false;
    }
  }

  exportTo(filePath) {
    const payload = { ...this.data, exportedAt: new Date().toISOString(), exportedBy: 'Tally' };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  importFrom(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      throw new Error('That file does not look like a Tally backup.');
    }
    // Keep the live window geometry: the bounds inside a backup are not interesting.
    const imported = this.replace({ ...parsed, window: this.data.window });
    this.flush();
    return imported;
  }
}

module.exports = { Store, defaultData, normalise, SCHEMA_VERSION };
