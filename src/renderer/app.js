/**
 * Tally — renderer.
 *
 * Holds the live document, renders it and sends the whole thing back to the
 * main process on every change (where it is debounced and written atomically).
 */
'use strict';

(() => {
  const PRIORITIES = ['low', 'med', 'high'];
  const PRIORITY_MARK = { low: '—', med: '!', high: '!!' };
  const PRIORITY_NAME = { low: 'Normal', med: 'Important', high: 'Urgent' };
  const PRIORITY_RANK = { low: 0, med: 1, high: 2 };
  const UNDO_LIMIT = 20;
  const SNAPSHOT_TASK_CEILING = 4000;
  const TOAST_MS = 5200;
  const DONE_ROW_CAP = 400;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------ state */

  let doc = null;
  let view = 'today';
  let tagFilter = null;
  let selectedId = null;
  let editingId = null;
  let compact = false;

  let composerPriority = 'low';
  let composerDue = null;

  const undoStack = [];
  const animating = new Set();
  const newIds = new Set();
  let flatVisible = [];
  let toastTimer = null;
  let dayStamp = Dates.today();

  /* -------------------------------------------------------------------- dom */

  const $ = (id) => document.getElementById(id);

  const els = {
    body: document.body,
    levelBadge: $('level-badge'),
    xpTrack: $('xp-track'),
    xpFill: $('xp-fill'),
    xpText: $('xp-text'),
    streak: $('streak'),
    streakCount: $('streak-count'),
    input: $('composer-input'),
    preview: $('parse-preview'),
    prioBtn: $('btn-priority'),
    prioMark: $('prio-mark'),
    dueBtn: $('btn-due'),
    views: $('views'),
    tagbar: $('tagbar'),
    list: $('list'),
    status: $('status-text'),
    menu: $('menu'),
    toastWrap: $('toast-wrap'),
    template: $('tpl-task'),
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* ----------------------------------------------------------- persistence */

  function persist() {
    window.tally.save(structuredClone(doc)).catch((err) => {
      console.error('save failed', err);
      showToast('Could not save — check the data folder in Settings.');
    });
  }

  function snapshot() {
    if (doc.tasks.length > SNAPSHOT_TASK_CEILING) return;
    undoStack.push(JSON.stringify({ tasks: doc.tasks, progress: doc.progress }));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function undo() {
    const snap = undoStack.pop();
    if (!snap) {
      showToast('Nothing left to undo');
      return;
    }
    const previous = JSON.parse(snap);
    doc.tasks = previous.tasks;
    doc.progress = previous.progress;
    persist();
    render();
    Sound.undo();
    showToast('Undone');
  }

  /* ---------------------------------------------------------------- helpers */

  function newId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function findTask(id) {
    return doc.tasks.find((t) => t.id === id) || null;
  }

  function openTasks() {
    return doc.tasks.filter((t) => !t.completedAt);
  }

  function nodeFor(id) {
    return els.list.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  }

  function comparePriority(a, b) {
    return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  }

  /** Ascending by due date, undated last. diffDays(b, a) is a-b, so it already
   *  goes negative when `a` is the earlier one. */
  function compareDue(a, b) {
    if (a.due && b.due) return Dates.diffDays(b.due, a.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  }

  function sortGroup(tasks) {
    return tasks.slice().sort(
      (a, b) =>
        comparePriority(a, b) || compareDue(a, b) || a.order - b.order || a.createdAt - b.createdAt
    );
  }

  function sortChronological(tasks) {
    const today = Dates.today();
    const bucket = (t) => {
      if (!t.due) return 2;
      return Dates.diffDays(today, t.due) < 0 ? 0 : 1;
    };
    return tasks.slice().sort(
      (a, b) =>
        bucket(a) - bucket(b) ||
        compareDue(a, b) ||
        comparePriority(a, b) ||
        a.order - b.order ||
        a.createdAt - b.createdAt
    );
  }

  /* ------------------------------------------------------------- composer */

  function composerParse() {
    const raw = els.input.value;
    const parsed = Parse.line(raw);
    // Typed tokens win; otherwise fall back to whatever the buttons are set to.
    if (!parsed.matched.priority && composerPriority !== 'low') parsed.priority = composerPriority;
    if (!parsed.due && !parsed.recurrence && composerDue) parsed.due = composerDue;
    return parsed;
  }

  function renderPreview() {
    const raw = els.input.value.trim();
    const parsed = composerParse();
    const chips = [];

    if (parsed.priority !== 'low') {
      chips.push([`pchip is-${parsed.priority}`, PRIORITY_NAME[parsed.priority]]);
    }
    parsed.tags.forEach((tag) => chips.push(['pchip is-tag', `#${tag}`]));
    if (parsed.due) chips.push(['pchip is-due', Dates.formatHeading(parsed.due)]);
    if (parsed.recurrence) chips.push(['pchip is-repeat', Parse.describeRepeat(parsed.recurrence)]);

    const interesting = raw.length > 0 && chips.length > 0;
    els.preview.hidden = !interesting;
    if (!interesting) return;

    els.preview.replaceChildren();
    if (parsed.title) els.preview.append(el('span', null, parsed.title));
    chips.forEach(([cls, text]) => els.preview.append(el('span', cls, text)));
  }

  function syncComposerButtons() {
    els.prioMark.textContent = PRIORITY_MARK[composerPriority];
    els.prioBtn.dataset.prio = composerPriority;
    els.prioBtn.title = `Priority: ${PRIORITY_NAME[composerPriority]}`;
    els.dueBtn.classList.toggle('is-set', Boolean(composerDue));
    els.dueBtn.title = composerDue
      ? `Due ${Dates.formatFull(composerDue)}`
      : 'Due date (or type a date)';
  }

  function resetComposer() {
    els.input.value = '';
    composerPriority = 'low';
    composerDue = null;
    syncComposerButtons();
    renderPreview();
  }

  function submitComposer() {
    const parsed = composerParse();
    if (!parsed.title) {
      // A line of nothing but tags or a date is not a task.
      if (els.input.value.trim()) showToast('Give the task a name too');
      return;
    }

    snapshot();
    const orders = doc.tasks.map((t) => t.order);
    const task = {
      id: newId(),
      title: parsed.title,
      tags: parsed.tags,
      priority: parsed.priority,
      due: parsed.due,
      recurrence: parsed.recurrence,
      createdAt: Date.now(),
      completedAt: null,
      xpAwarded: 0,
      order: (orders.length ? Math.min(...orders) : 0) - 1,
    };
    doc.tasks.push(task);
    newIds.add(task.id);
    selectedId = task.id;

    const scheduled = task.due && Dates.diffDays(Dates.today(), task.due) > 0;
    // Adding from the Done view has nowhere sensible to stay.
    if (view === 'done') setView(scheduled ? 'upcoming' : 'today', { silent: true });
    if (tagFilter && !task.tags.includes(tagFilter)) tagFilter = null;

    persist();
    resetComposer();
    render();

    // Rather than yanking the user to another tab, stay put and say where it
    // went if the new task is not visible from here.
    const node = nodeFor(task.id);
    if (node) {
      node.scrollIntoView({ block: 'nearest' });
    } else {
      const where = scheduled ? 'Upcoming' : 'Today';
      const when = task.due ? ` · ${Dates.formatHeading(task.due)}` : '';
      showToast(`Added to ${where}${when}`);
    }
  }

  /* -------------------------------------------------------------- actions */

  function completeTask(id) {
    const task = findTask(id);
    if (!task || task.completedAt || animating.has(id)) return;

    snapshot();
    const today = Dates.today();
    const node = nodeFor(id);
    const result = Game.award(doc.progress, task.priority, today);

    task.completedAt = Date.now();
    task.xpAwarded = result.xp;

    if (task.recurrence) {
      const next = Parse.nextOccurrence(task.recurrence, task.due, today);
      if (next) {
        doc.tasks.push({
          ...task,
          id: newId(),
          due: next,
          completedAt: null,
          xpAwarded: 0,
          createdAt: Date.now(),
        });
      }
    }

    persist();
    renderProgress({ animate: true, result });
    renderViewCounts();
    renderStatus();

    Sound.complete();
    if (result.leveledUp) celebrateLevel(result.levelAfter);

    const label = task.recurrence
      ? `Done · +${result.xp} XP · repeats ${Parse.describeRepeat(task.recurrence)}`
      : `Done · +${result.xp} XP`;
    showToast(label, 'Undo', undo);

    if (selectedId === id) selectedId = null;
    animateOut(node, id, result.xp);
  }

  function reopenTask(id) {
    const task = findTask(id);
    if (!task || !task.completedAt) return;
    snapshot();
    task.completedAt = null;
    task.xpAwarded = 0;
    persist();
    render();
    Sound.undo();
    showToast('Back on the list');
  }

  function deleteTask(id) {
    const task = findTask(id);
    if (!task) return;
    snapshot();
    const node = nodeFor(id);
    doc.tasks = doc.tasks.filter((t) => t.id !== id);
    if (selectedId === id) selectedId = null;
    persist();
    Sound.remove();
    showToast(`Deleted “${truncate(task.title, 34)}”`, 'Undo', undo);

    renderViewCounts();
    renderStatus();
    if (node && !reducedMotion) {
      collapse(node, () => render());
    } else {
      render();
    }
  }

  function setPriority(id, priority) {
    const task = findTask(id);
    if (!task || task.priority === priority) return;
    snapshot();
    task.priority = priority;
    persist();
    render();
  }

  function setDue(id, due) {
    const task = findTask(id);
    if (!task) return;
    snapshot();
    task.due = due;
    persist();
    render();
  }

  function setRecurrence(id, recurrence) {
    const task = findTask(id);
    if (!task) return;
    snapshot();
    task.recurrence = recurrence;
    // A repeating task needs a starting point to repeat from.
    if (recurrence && !task.due) task.due = Dates.today();
    persist();
    render();
  }

  function commitRename(id, text) {
    const task = findTask(id);
    editingId = null;
    if (!task) {
      render();
      return;
    }
    const parsed = Parse.line(text);
    if (!parsed.title) {
      render();
      return;
    }
    snapshot();
    task.title = parsed.title;
    task.tags = parsed.tags;
    if (parsed.matched.priority) task.priority = parsed.priority;
    if (parsed.due) task.due = parsed.due;
    if (parsed.recurrence) task.recurrence = parsed.recurrence;
    persist();
    render();
  }

  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /* ----------------------------------------------------------- animations */

  function collapse(node, done) {
    node.style.maxHeight = `${node.offsetHeight}px`;
    node.style.minHeight = '0px';
    void node.offsetHeight; // force the starting height to stick
    node.classList.add('collapsing');
    node.style.maxHeight = '0px';
    node.style.marginBottom = '0px';
    setTimeout(done, 290);
  }

  function animateOut(node, id, xp) {
    if (!node || reducedMotion) {
      render();
      return;
    }
    animating.add(id);
    node.classList.add('completing');
    node.append(el('span', 'xp-pop', `+${xp}`));

    setTimeout(() => {
      collapse(node, () => {
        animating.delete(id);
        render();
      });
    }, 430);
  }

  function celebrateLevel(level) {
    Sound.levelUp();
    els.levelBadge.classList.remove('bump');
    void els.levelBadge.offsetWidth;
    els.levelBadge.classList.add('bump');
    showToast(`Level ${level}`);
    if (reducedMotion) return;
    const rect = els.xpTrack.getBoundingClientRect();
    Confetti.burst(rect.left + rect.width / 2, rect.bottom + 2, 110);
  }

  /* --------------------------------------------------------------- render */

  function render() {
    closeMenu();
    renderProgress();
    renderViews();
    renderTagbar();
    renderList();
    renderStatus();
  }

  function renderProgress({ animate = false, result = null } = {}) {
    const info = Game.levelInfo(doc.progress.xp);
    els.levelBadge.textContent = `LV ${info.level}`;
    els.xpFill.style.width = `${(info.fraction * 100).toFixed(2)}%`;
    els.xpText.textContent = `${info.into} / ${info.need}`;
    els.xpTrack.title = `Level ${info.level} — ${info.into} of ${info.need} XP toward level ${info.level + 1}`;

    const streak = Game.liveStreak(doc.progress);
    els.streakCount.textContent = String(streak);
    els.streak.classList.toggle('is-live', streak > 0);
    els.streak.title = streak > 0
      ? `${streak} day streak — best ${doc.progress.bestStreak}`
      : 'No streak yet: finish a task today to start one';

    if (animate) {
      els.xpTrack.classList.remove('pulse');
      void els.xpTrack.offsetWidth;
      els.xpTrack.classList.add('pulse');
      if (result && result.streakExtended) {
        els.streak.classList.remove('bump');
        void els.streak.offsetWidth;
        els.streak.classList.add('bump');
      }
    }
  }

  function renderViews() {
    for (const button of els.views.querySelectorAll('.view')) {
      button.classList.toggle('is-active', button.dataset.view === view);
    }
    renderViewCounts();
  }

  function renderViewCounts() {
    const today = Dates.today();
    const open = openTasks();
    const counts = {
      today: open.filter((t) => !t.due || Dates.diffDays(today, t.due) <= 0).length,
      upcoming: open.filter((t) => t.due && Dates.diffDays(today, t.due) > 0).length,
      all: open.length,
    };
    for (const node of els.views.querySelectorAll('[data-count]')) {
      const value = counts[node.dataset.count];
      node.textContent = value ? String(value) : '';
    }
  }

  /**
   * Tasks belonging to the current view, before the tag filter is applied.
   * The tag bar is built from exactly this set, so every chip it offers can
   * actually match something — a filter that can only return nothing is a trap.
   */
  function viewTasks() {
    const today = Dates.today();
    if (view === 'done') return doc.tasks.filter((t) => t.completedAt);
    const open = openTasks();
    if (view === 'today') return open.filter((t) => !t.due || Dates.diffDays(today, t.due) <= 0);
    if (view === 'upcoming') return open.filter((t) => t.due && Dates.diffDays(today, t.due) > 0);
    return open;
  }

  function renderTagbar() {
    const counts = new Map();
    for (const task of viewTasks()) {
      for (const tag of task.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }

    if (tagFilter && !counts.has(tagFilter)) tagFilter = null;

    if (!counts.size) {
      els.tagbar.hidden = true;
      els.tagbar.replaceChildren();
      return;
    }

    els.tagbar.hidden = false;
    els.tagbar.replaceChildren();
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    for (const [tag, count] of sorted) {
      const chip = el('button', 'tag-filter');
      chip.classList.toggle('is-active', tagFilter === tag);
      chip.append(el('span', null, `#${tag}`), el('b', null, String(count)));
      chip.addEventListener('click', () => {
        tagFilter = tagFilter === tag ? null : tag;
        render();
      });
      els.tagbar.append(chip);
    }
  }

  function buildGroups() {
    const today = Dates.today();
    const matchesTag = (t) => !tagFilter || t.tags.includes(tagFilter);
    const scoped = viewTasks().filter(matchesTag);

    if (view === 'done') {
      const done = scoped
        .slice()
        .sort((a, b) => b.completedAt - a.completedAt)
        .slice(0, DONE_ROW_CAP);

      const byDay = new Map();
      for (const task of done) {
        const day = Dates.isoDay(new Date(task.completedAt));
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(task);
      }
      return [...byDay.entries()].map(([day, tasks]) => ({
        key: day,
        title: Dates.formatHeading(day),
        note: `${tasks.reduce((sum, t) => sum + (t.xpAwarded || 0), 0)} XP`,
        tasks,
      }));
    }

    if (view === 'today') {
      const overdue = scoped.filter((t) => t.due && Dates.diffDays(today, t.due) < 0);
      const due = scoped.filter((t) => t.due && Dates.diffDays(today, t.due) === 0);
      const undated = scoped.filter((t) => !t.due);
      return [
        { key: 'overdue', title: 'Overdue', danger: true, tasks: sortGroup(overdue) },
        { key: 'today', title: 'Today', tasks: sortGroup(due) },
        { key: 'anytime', title: 'Anytime', tasks: sortGroup(undated) },
      ].filter((group) => group.tasks.length);
    }

    if (view === 'upcoming') {
      const byDay = new Map();
      for (const task of scoped) {
        if (!byDay.has(task.due)) byDay.set(task.due, []);
        byDay.get(task.due).push(task);
      }
      return [...byDay.entries()]
        .sort((a, b) => Dates.diffDays(b[0], a[0]))
        .map(([day, tasks]) => ({
          key: day,
          title: Dates.formatHeading(day),
          tasks: sortGroup(tasks),
        }));
    }

    return [{ key: 'all', title: null, tasks: sortChronological(scoped) }];
  }

  function chipFor(task) {
    const chips = [];
    for (const tag of task.tags) chips.push(['chip is-tag', `#${tag}`, null]);

    if (task.recurrence) {
      chips.push(['chip is-repeat', `↻`, Parse.describeRepeat(task.recurrence)]);
    }

    if (task.due && !task.completedAt) {
      const delta = Dates.diffDays(Dates.today(), task.due);
      const cls =
        delta < 0 ? 'chip is-due-over' : delta === 0 ? 'chip is-due-today' : 'chip';
      chips.push([cls, Dates.formatDue(task.due), Dates.formatFull(task.due)]);
    }
    return chips;
  }

  function taskNode(task) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    node.dataset.id = task.id;
    node.dataset.prio = task.priority;
    node.classList.toggle('is-selected', selectedId === task.id);
    node.classList.toggle('is-done', Boolean(task.completedAt));
    if (newIds.has(task.id)) node.classList.add('is-new');

    const main = node.querySelector('.task-main');
    const titleNode = node.querySelector('[data-role="title"]');
    const metaNode = node.querySelector('[data-role="meta"]');

    if (editingId === task.id) {
      const input = el('input', 'task-edit');
      input.type = 'text';
      input.maxLength = 480;
      input.value = task.title + task.tags.map((t) => ` #${t}`).join('');
      main.replaceChildren(input);
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(0, task.title.length);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitRename(task.id, input.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          editingId = null;
          render();
          focusComposer();
        }
        event.stopPropagation();
      });
      input.addEventListener('blur', () => {
        if (editingId === task.id) commitRename(task.id, input.value);
      });
      return node;
    }

    titleNode.textContent = task.title;
    titleNode.title = task.title;

    metaNode.replaceChildren();
    for (const [cls, text, hover] of chipFor(task)) {
      const chip = el('span', cls, text);
      if (hover) chip.title = hover;
      metaNode.append(chip);
    }
    if (task.completedAt && task.xpAwarded) {
      metaNode.append(el('span', 'done-xp', `+${task.xpAwarded}`));
    }

    const check = node.querySelector('[data-role="check"]');
    check.title = task.completedAt
      ? 'Put this back on the list'
      : `Finish · +${Game.xpFor(task.priority)} XP`;

    return node;
  }

  function renderList() {
    const groups = buildGroups();
    flatVisible = [];
    els.list.replaceChildren();

    if (!groups.length) {
      els.list.append(emptyState());
      return;
    }

    const showHeads = groups.length > 1 || Boolean(groups[0].title);

    for (const group of groups) {
      if (showHeads && group.title) {
        const head = el('div', 'group-head');
        head.classList.toggle('is-overdue', Boolean(group.danger));
        head.append(el('span', null, group.title));
        head.append(el('b', null, group.note || String(group.tasks.length)));
        els.list.append(head);
      }

      const list = el('ul', 'group-list');
      for (const task of group.tasks) {
        list.append(taskNode(task));
        flatVisible.push(task.id);
      }
      els.list.append(list);
    }

    newIds.clear();
  }

  function emptyState() {
    const wrap = el('div', 'empty');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');

    const messages = {
      today: tagFilter
        ? [`Nothing due in #${tagFilter}`, 'Clear the tag filter to see the rest.']
        : ['All clear', 'Nothing is due. Add a task above, or go and enjoy the quiet.'],
      upcoming: ['Nothing scheduled', 'Tasks with a date further out land here.'],
      all: tagFilter
        ? [`No open tasks in #${tagFilter}`, 'Clear the tag filter to see the rest.']
        : ['Empty list', 'Type a task in the box above and press Enter.'],
      done: ['Nothing finished yet', 'Completed tasks are kept here, grouped by the day you did them.'],
    };
    const [title, sub] = messages[view] || messages.all;

    const glyphs = {
      today: 'M4 12.5 L9.2 17.5 L20 6.5',
      upcoming: 'M3.5 6.5h17v14h-17zM3.5 10.5h17M8 3.5v3M16 3.5v3',
      all: 'M5 7h14M5 12h14M5 17h9',
      done: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17ZM12 8v4.6l3 2',
    };
    icon.innerHTML = `<path d="${glyphs[view] || glyphs.all}"/>`;

    wrap.append(icon, el('div', 'empty-title', title), el('div', 'empty-sub', sub));
    return wrap;
  }

  function renderStatus() {
    const open = openTasks().length;
    const totals = Game.dayTotals(doc.progress);
    const streak = Game.liveStreak(doc.progress);
    els.status.replaceChildren();

    if (view === 'done') {
      const done = doc.tasks.filter((t) => t.completedAt).length;
      els.status.append(
        el('span', null, `${done} finished all-time · best streak ${doc.progress.bestStreak} days`)
      );
      return;
    }

    if (streak > 0 && totals.tasks === 0) {
      els.status.append(
        el('span', null, `${open} open · finish one today to keep your ${streak}-day streak`)
      );
      return;
    }

    els.status.append(el('span', null, `${open} open · ${totals.tasks} done today · `));
    els.status.append(el('em', null, `+${totals.xp} XP`));
  }

  /* ----------------------------------------------------------------- views */

  function setView(next, { silent = false } = {}) {
    if (view === next) return;
    view = next;
    doc.settings.view = next;
    selectedId = null;
    if (!silent) {
      persist();
      render();
    }
  }

  /* ------------------------------------------------------------ selection */

  function moveSelection(delta) {
    if (!flatVisible.length) return;
    const index = flatVisible.indexOf(selectedId);
    const next = index === -1
      ? delta > 0 ? 0 : flatVisible.length - 1
      : Math.min(flatVisible.length - 1, Math.max(0, index + delta));
    selectedId = flatVisible[next];
    for (const node of els.list.querySelectorAll('.task')) {
      node.classList.toggle('is-selected', node.dataset.id === selectedId);
    }
    const node = nodeFor(selectedId);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  /* ----------------------------------------------------------------- toast */

  function showToast(message, actionLabel, action) {
    els.toastWrap.replaceChildren();
    clearTimeout(toastTimer);

    const toast = el('div', 'toast');
    toast.append(el('span', 'toast-msg', message));
    if (actionLabel && action) {
      const button = el('button', 'toast-action', actionLabel);
      button.addEventListener('click', () => {
        dismissToast();
        action();
      });
      toast.append(button);
    }
    els.toastWrap.append(toast);
    toastTimer = setTimeout(dismissToast, TOAST_MS);
  }

  function dismissToast() {
    clearTimeout(toastTimer);
    const toast = els.toastWrap.firstElementChild;
    if (!toast) return;
    toast.classList.add('is-out');
    setTimeout(() => toast.remove(), 200);
  }

  /* ------------------------------------------------------------------ menu */

  let menuCleanup = null;

  function closeMenu() {
    els.menu.hidden = true;
    els.menu.replaceChildren();
    if (menuCleanup) {
      menuCleanup();
      menuCleanup = null;
    }
  }

  function openMenu(anchor, items) {
    closeMenu();
    els.menu.replaceChildren();

    for (const item of items) {
      if (item.type === 'sep') {
        els.menu.append(el('div', 'menu-sep'));
      } else if (item.type === 'label') {
        els.menu.append(el('div', 'menu-label', item.text));
      } else if (item.type === 'date') {
        const row = el('div', 'menu-date');
        const input = el('input');
        input.type = 'date';
        if (item.value) input.value = item.value;
        input.addEventListener('change', () => {
          if (!input.value) return;
          closeMenu();
          item.onPick(input.value);
        });
        row.append(input);
        els.menu.append(row);
      } else {
        const button = el('button', 'menu-item');
        button.classList.toggle('is-active', Boolean(item.active));
        button.classList.toggle('is-danger', Boolean(item.danger));
        button.append(el('span', null, item.text));
        if (item.key) button.append(el('span', 'key', item.key));
        button.addEventListener('click', () => {
          closeMenu();
          item.onClick();
        });
        els.menu.append(button);
      }
    }

    els.menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const box = els.menu.getBoundingClientRect();
    const left = Math.min(Math.max(6, rect.left), window.innerWidth - box.width - 6);
    const below = rect.bottom + 5;
    const top = below + box.height > window.innerHeight - 6
      ? Math.max(6, rect.top - box.height - 5)
      : below;
    els.menu.style.left = `${Math.round(left)}px`;
    els.menu.style.top = `${Math.round(top)}px`;

    const onPointerDown = (event) => {
      if (!els.menu.contains(event.target)) closeMenu();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeMenu();
        focusComposer();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    menuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  function dateMenuItems(current, onPick) {
    const today = Dates.today();
    const options = [
      ['Today', today],
      ['Tomorrow', Dates.addDays(today, 1)],
      ['This weekend', Dates.nextWeekday(6, today)],
      ['Next week', Dates.addDays(today, 7)],
    ];
    const items = [{ type: 'label', text: 'Due' }];
    for (const [text, iso] of options) {
      items.push({
        text,
        key: Dates.formatDue(iso, today),
        active: current === iso,
        onClick: () => onPick(iso),
      });
    }
    items.push({ type: 'date', value: current, onPick });
    if (current) {
      items.push({ type: 'sep' }, { text: 'No date', onClick: () => onPick(null) });
    }
    return items;
  }

  function repeatMenuItems(current, onPick) {
    const key = (rec) => (rec ? `${rec.type}:${(rec.days || []).join(',')}` : 'none');
    const currentKey = key(current);
    const options = [
      ['Does not repeat', null],
      ['Every day', { type: 'daily', days: [] }],
      ['Every weekday', { type: 'weekdays', days: [] }],
      ['Every week', { type: 'weekly', days: [] }],
      ['Every month', { type: 'monthly', days: [] }],
    ];
    return [
      { type: 'label', text: 'Repeat' },
      ...options.map(([text, value]) => ({
        text,
        active: key(value) === currentKey,
        onClick: () => onPick(value),
      })),
    ];
  }

  function openTaskMenu(anchor, task) {
    openMenu(anchor, [
      { text: 'Rename', key: 'F2', onClick: () => { editingId = task.id; render(); } },
      {
        text: 'Due date…',
        key: task.due ? Dates.formatDue(task.due) : '',
        onClick: () =>
          openMenu(anchor, dateMenuItems(task.due, (iso) => setDue(task.id, iso))),
      },
      {
        text: 'Repeat…',
        key: task.recurrence ? Parse.describeRepeat(task.recurrence) : '',
        onClick: () =>
          openMenu(anchor, repeatMenuItems(task.recurrence, (rec) => setRecurrence(task.id, rec))),
      },
      { type: 'sep' },
      { type: 'label', text: 'Priority' },
      ...PRIORITIES.map((priority) => ({
        text: PRIORITY_NAME[priority],
        key: `+${Game.xpFor(priority)} XP`,
        active: task.priority === priority,
        onClick: () => setPriority(task.id, priority),
      })),
      { type: 'sep' },
      { text: 'Delete', key: 'Del', danger: true, onClick: () => deleteTask(task.id) },
    ]);
  }

  /* ---------------------------------------------------------------- sheets */

  function openSheet(id) {
    closeMenu();
    if (id === 'settings-sheet') syncSettings();
    $(id).hidden = false;
  }

  function closeSheets() {
    for (const sheet of document.querySelectorAll('.sheet')) sheet.hidden = true;
    focusComposer();
  }

  function anySheetOpen() {
    return [...document.querySelectorAll('.sheet')].some((sheet) => !sheet.hidden);
  }

  function syncSettings() {
    $('set-sound').checked = doc.settings.sound;
    $('set-tray').checked = doc.settings.minimiseToTray;
    $('set-startup').checked = doc.settings.launchOnStartup;
    $('set-start-min').checked = doc.settings.startMinimised;
    $('set-start-min').disabled = !doc.settings.launchOnStartup;

    const streak = Game.liveStreak(doc.progress);
    $('stat-total').textContent = String(doc.progress.totalDone);
    $('stat-xp').textContent = String(doc.progress.xp);
    $('stat-streak').textContent = `${streak} ${streak === 1 ? 'day' : 'days'}`;
    $('stat-best').textContent = `${doc.progress.bestStreak} ${doc.progress.bestStreak === 1 ? 'day' : 'days'}`;
  }

  /* --------------------------------------------------------------- binding */

  function focusComposer() {
    if (anySheetOpen() || editingId) return;
    els.input.focus();
  }

  function bindComposer() {
    els.input.addEventListener('input', renderPreview);

    els.prioBtn.addEventListener('click', () => {
      composerPriority = PRIORITIES[(PRIORITIES.indexOf(composerPriority) + 1) % 3];
      syncComposerButtons();
      renderPreview();
      els.input.focus();
    });

    els.dueBtn.addEventListener('click', () => {
      openMenu(
        els.dueBtn,
        dateMenuItems(composerDue, (iso) => {
          composerDue = iso;
          syncComposerButtons();
          renderPreview();
          els.input.focus();
        })
      );
    });
  }

  function bindList() {
    els.list.addEventListener('click', (event) => {
      const row = event.target.closest('.task');
      if (!row) {
        selectedId = null;
        for (const node of els.list.querySelectorAll('.task')) node.classList.remove('is-selected');
        return;
      }
      const id = row.dataset.id;
      const task = findTask(id);
      if (!task) return;

      if (event.target.closest('[data-role="check"]')) {
        if (task.completedAt) reopenTask(id);
        else completeTask(id);
        return;
      }
      if (event.target.closest('[data-role="more"]')) {
        openTaskMenu(event.target.closest('[data-role="more"]'), task);
        return;
      }
      if (event.target.closest('[data-role="prio"]')) {
        setPriority(id, PRIORITIES[(PRIORITIES.indexOf(task.priority) + 1) % 3]);
        return;
      }

      selectedId = id;
      for (const node of els.list.querySelectorAll('.task')) {
        node.classList.toggle('is-selected', node.dataset.id === id);
      }
    });

    els.list.addEventListener('dblclick', (event) => {
      const row = event.target.closest('.task');
      if (!row || event.target.closest('button')) return;
      const task = findTask(row.dataset.id);
      if (!task || task.completedAt) return;
      editingId = task.id;
      render();
    });

    els.list.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.task');
      if (!row) return;
      const task = findTask(row.dataset.id);
      if (!task || task.completedAt) return;
      event.preventDefault();
      selectedId = task.id;
      render();
      openTaskMenu(row.querySelector('[data-role="more"]') || row, task);
    });
  }

  function bindViews() {
    els.views.addEventListener('click', (event) => {
      const button = event.target.closest('.view');
      if (!button) return;
      setView(button.dataset.view);
      focusComposer();
    });
  }

  function bindChrome() {
    $('btn-min').addEventListener('click', () => window.tally.minimise());
    $('btn-close').addEventListener('click', () => window.tally.close());
    $('btn-compact').addEventListener('click', () => window.tally.setCompact(!compact));
    $('btn-settings').addEventListener('click', () => openSheet('settings-sheet'));
    $('btn-help').addEventListener('click', () => openSheet('help-sheet'));

    for (const button of document.querySelectorAll('[data-close]')) {
      button.addEventListener('click', closeSheets);
    }
  }

  function bindSettings() {
    $('set-sound').addEventListener('change', (event) => {
      doc.settings.sound = event.target.checked;
      Sound.setEnabled(doc.settings.sound);
      persist();
      if (doc.settings.sound) Sound.complete();
    });

    $('set-tray').addEventListener('change', (event) => {
      doc.settings.minimiseToTray = event.target.checked;
      persist();
    });

    $('set-startup').addEventListener('change', async (event) => {
      doc.settings.launchOnStartup = event.target.checked;
      $('set-start-min').disabled = !doc.settings.launchOnStartup;
      persist();
      const result = await window.tally.setLaunchOnStartup(
        doc.settings.launchOnStartup,
        doc.settings.startMinimised
      );
      if (!result.ok) {
        doc.settings.launchOnStartup = false;
        syncSettings();
        persist();
        showToast('Windows refused the startup change');
      }
    });

    $('set-start-min').addEventListener('change', async (event) => {
      doc.settings.startMinimised = event.target.checked;
      persist();
      if (doc.settings.launchOnStartup) {
        await window.tally.setLaunchOnStartup(true, doc.settings.startMinimised);
      }
    });

    $('btn-export').addEventListener('click', async () => {
      const result = await window.tally.exportData();
      if (result.ok) showToast('Exported');
      else if (!result.canceled) showToast(`Export failed: ${result.error}`);
    });

    $('btn-import').addEventListener('click', async () => {
      const result = await window.tally.importData();
      if (result.canceled) return;
      if (!result.ok) {
        showToast(`Import failed: ${result.error}`);
        return;
      }
      doc = result.data;
      undoStack.length = 0;
      view = doc.settings.view;
      tagFilter = null;
      selectedId = null;
      Sound.setEnabled(doc.settings.sound);
      syncSettings();
      render();
      showToast('Imported');
    });

    $('btn-reveal').addEventListener('click', () => window.tally.revealDataFolder());
  }

  function bindKeys() {
    document.addEventListener('keydown', (event) => {
      if (editingId) return;

      if (anySheetOpen()) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSheets();
        }
        return;
      }

      const composerEmpty = els.input.value.length === 0;
      const ctrl = event.ctrlKey || event.metaKey;

      if (ctrl && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if (ctrl && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.tally.setCompact(!compact);
        return;
      }
      if (ctrl && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        setView(['today', 'upcoming', 'all', 'done'][Number(event.key) - 1]);
        return;
      }
      if (ctrl) return;

      // Alt rather than a bare digit, so a task can still start with a number.
      if (event.altKey && ['1', '2', '3'].includes(event.key) && selectedId) {
        event.preventDefault();
        setPriority(selectedId, PRIORITIES[Number(event.key) - 1]);
        return;
      }
      if (event.altKey) return;

      if (event.key === 'F1') {
        event.preventDefault();
        openSheet('help-sheet');
        return;
      }

      switch (event.key) {
        case 'Enter':
          event.preventDefault();
          if (!composerEmpty) submitComposer();
          else if (selectedId) {
            const task = findTask(selectedId);
            if (task && task.completedAt) reopenTask(selectedId);
            else if (task) completeTask(selectedId);
          }
          return;

        case 'ArrowDown':
          event.preventDefault();
          moveSelection(1);
          return;

        case 'ArrowUp':
          event.preventDefault();
          moveSelection(-1);
          return;

        case ' ':
          if (composerEmpty && selectedId) {
            event.preventDefault();
            const task = findTask(selectedId);
            if (task && !task.completedAt) completeTask(selectedId);
          }
          return;

        case 'Delete':
          if (composerEmpty && selectedId) {
            event.preventDefault();
            deleteTask(selectedId);
          }
          return;

        case 'F2':
          if (selectedId) {
            const task = findTask(selectedId);
            if (task && !task.completedAt) {
              event.preventDefault();
              editingId = selectedId;
              render();
            }
          }
          return;

        case 'Escape':
          event.preventDefault();
          if (!composerEmpty) {
            resetComposer();
          } else if (selectedId) {
            selectedId = null;
            for (const node of els.list.querySelectorAll('.task')) {
              node.classList.remove('is-selected');
            }
          }
          dismissToast();
          focusComposer();
          return;

        default:
          break;
      }
    });

    // Typing anywhere goes into the composer: the shortest possible path to a task.
    document.addEventListener('keypress', (event) => {
      if (anySheetOpen() || editingId) return;
      if (document.activeElement === els.input) return;
      if (event.target.tagName === 'INPUT') return;
      if (event.key.length === 1) els.input.focus();
    });

    // Ctrl+scroll zoom would break this fixed, compact layout.
    document.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey) event.preventDefault();
      },
      { passive: false }
    );

    els.list.addEventListener('mousedown', (event) => {
      // Keep the composer focused so typing always lands there.
      if (!event.target.closest('button') && !event.target.closest('input')) {
        setTimeout(focusComposer, 0);
      }
    });
  }

  /* ------------------------------------------------------ day rollover ---- */

  function watchDayChange() {
    setInterval(() => {
      const now = Dates.today();
      if (now === dayStamp) return;
      dayStamp = now;
      render();
    }, 30000);
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    doc = await window.tally.load();
    compact = Boolean(doc.compact);
    els.body.classList.toggle('compact', compact);
    $('btn-compact').classList.toggle('is-on', compact);

    // Trust Windows over our own record if they have drifted apart.
    if (typeof doc.launchOnStartupActual === 'boolean'
      && doc.launchOnStartupActual !== doc.settings.launchOnStartup) {
      doc.settings.launchOnStartup = doc.launchOnStartupActual;
    }
    delete doc.compact;
    delete doc.launchOnStartupActual;

    view = doc.settings.view;
    Sound.setEnabled(doc.settings.sound);
    Confetti.attach($('confetti'));

    bindComposer();
    bindList();
    bindViews();
    bindChrome();
    bindSettings();
    bindKeys();
    watchDayChange();

    window.tally.onCompactChanged((enabled) => {
      compact = enabled;
      els.body.classList.toggle('compact', enabled);
      $('btn-compact').classList.toggle('is-on', enabled);
      closeMenu();
    });

    window.tally.onBeforeHide(() => {
      window.tally.flush();
    });

    window.addEventListener('beforeunload', () => window.tally.flush());

    // Paint as soon as the data is in hand. Anything else (the version string)
    // can land afterwards — the window is already on screen by now, and waiting
    // on another round trip would show a stale "LV 1 · 0 XP" in the meantime.
    syncComposerButtons();
    render();
    els.body.classList.remove('booting');
    focusComposer();

    window.tally.appVersion().then((version) => {
      $('version-line').textContent = `Tally ${version} — saved automatically as you go`;
    });
  }

  // Never leave the window blank, whatever happens during boot.
  setTimeout(() => els.body.classList.remove('booting'), 3000);

  boot().catch((err) => {
    console.error(err);
    els.body.classList.remove('booting');
    document.body.append(el('pre', null, `Tally failed to start:\n${err.stack || err}`));
  });
})();
