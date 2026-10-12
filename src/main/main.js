/**
 * Tally - main process.
 *
 * Owns the frameless window, the tray, the login item and the JSON store.
 * The renderer is the source of truth for task state while the app is running
 * and hands the whole document over whenever it changes; this process only
 * persists it.
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const { Store } = require('./store');

const NORMAL_MIN = { width: 380, height: 460 };
const COMPACT_SIZE = { width: 340, height: 460 };
const BOUNDS_DEBOUNCE_MS = 400;

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.ico');
const isDev = !app.isPackaged;
const startHidden = process.argv.includes('--hidden');

let store = null;
let win = null;
let tray = null;
let quitting = false;
let compact = false;
let normalBounds = null;
let boundsTimer = null;

/* ------------------------------------------------------------------- window */

function persistBounds() {
  if (!win || win.isDestroyed() || compact || win.isMinimized() || win.isMaximized()) return;
  const { width, height, x, y } = win.getBounds();
  store.merge({ window: { width, height, x, y } });
}

function queueBoundsSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistBounds, BOUNDS_DEBOUNCE_MS);
}

function createWindow() {
  const saved = store.data.window;

  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x ?? undefined,
    y: saved.y ?? undefined,
    minWidth: NORMAL_MIN.width,
    minHeight: NORMAL_MIN.height,
    frame: false,
    show: false,
    backgroundColor: '#0d0e11',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (!startHidden && !store.data.settings.startMinimised) win.show();
  });

  win.on('resize', queueBoundsSave);
  win.on('move', queueBoundsSave);

  // Closing the window parks the app in the tray instead of quitting.
  win.on('close', (event) => {
    if (quitting || !store.data.settings.minimiseToTray) return;
    event.preventDefault();
    win.webContents.send('app:before-hide');
    win.hide();
  });

  win.on('closed', () => {
    win = null;
  });

  // This app never loads remote content or opens extra windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // A compact fixed-layout window has nothing to gain from browser zoom, and
  // a stray Ctrl+scroll would wreck the layout until the user found Ctrl+0.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setZoomLevel(0);
    win.webContents.setVisualZoomLevelLimits(1, 1);
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (isDev && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.control && ['+', '=', '-', '_', '0'].includes(input.key)) event.preventDefault();
  });
}

function showWindow() {
  if (!win) {
    createWindow();
    win.once('ready-to-show', () => win.show());
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setCompact(enabled) {
  if (!win || enabled === compact) return compact;

  if (enabled) {
    normalBounds = win.getBounds();
    compact = true;
    win.setMinimumSize(300, 320);
    win.setAlwaysOnTop(true, 'floating');
    const { x, y, width } = normalBounds;
    // Keep the right edge anchored so the strip does not jump across the screen.
    win.setBounds({
      x: Math.round(x + width - COMPACT_SIZE.width),
      y,
      width: COMPACT_SIZE.width,
      height: COMPACT_SIZE.height,
    });
  } else {
    compact = false;
    win.setAlwaysOnTop(false);
    win.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height);
    if (normalBounds) win.setBounds(normalBounds);
  }

  win.webContents.send('win:compact-changed', compact);
  return compact;
}

/* --------------------------------------------------------------------- tray */

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Tally');

  const refreshMenu = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Tally', click: showWindow },
        { type: 'separator' },
        {
          label: 'Compact mode',
          type: 'checkbox',
          checked: compact,
          click: () => {
            showWindow();
            setCompact(!compact);
            refreshMenu();
          },
        },
        { type: 'separator' },
        {
          label: 'Quit Tally',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
  };

  refreshMenu();
  tray.on('click', () => {
    if (win && win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  });
  tray.on('double-click', showWindow);
}

/* ---------------------------------------------------------------------- IPC */

function applyLoginItem(enabled, startMinimised) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: startMinimised ? ['--hidden'] : [],
    });
    return { ok: true, enabled: app.getLoginItemSettings().openAtLogin };
  } catch (err) {
    console.error('[main] could not update the login item:', err.message);
    return { ok: false, error: err.message };
  }
}

function registerIpc() {
  ipcMain.handle('data:load', () => ({
    ...store.data,
    compact,
    launchOnStartupActual: app.getLoginItemSettings().openAtLogin,
  }));

  ipcMain.handle('data:save', (_event, doc) => {
    // Window bounds are owned by this process; never let the renderer stomp them.
    store.replace({ ...doc, window: store.data.window });
    return true;
  });

  ipcMain.handle('data:flush', () => store.flush());

  ipcMain.handle('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Tally data',
      defaultPath: `tally-backup-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      store.flush();
      store.exportTo(result.filePath);
      return { ok: true, filePath: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('data:import', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Tally data',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };

    const confirmed = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Replace everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Import Tally data',
      message: 'Replace your current tasks and progress?',
      detail: 'Everything currently in Tally will be overwritten by the contents of the backup. This cannot be undone.',
    });
    if (confirmed.response !== 0) return { ok: false, canceled: true };

    try {
      const data = store.importFrom(result.filePaths[0]);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('data:reveal', () => {
    shell.showItemInFolder(store.file);
    return true;
  });

  ipcMain.handle('app:launch-on-startup', (_event, { enabled, startMinimised }) =>
    applyLoginItem(enabled, startMinimised)
  );

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('win:minimise', () => {
    if (win) win.minimize();
    return true;
  });

  ipcMain.handle('win:close', () => {
    if (!win) return true;
    if (store.data.settings.minimiseToTray) win.hide();
    else {
      quitting = true;
      app.quit();
    }
    return true;
  });

  ipcMain.handle('win:compact', (_event, enabled) => setCompact(Boolean(enabled)));
}

/* -------------------------------------------------------------------- start */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.roopemantere.tally');
    Menu.setApplicationMenu(null);

    store = new Store(app.getPath('userData'));
    store.load();

    // Keep the OS login item in step with the saved preference; the user may
    // have changed it in Task Manager since the last run.
    applyLoginItem(store.data.settings.launchOnStartup, store.data.settings.startMinimised);

    registerIpc();
    createWindow();
    createTray();
  });

  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(boundsTimer);
    persistBounds();
    store?.flush();
  });

  // The tray keeps the app alive on purpose, so do not quit on last window close.
  app.on('window-all-closed', () => {
    if (!store?.data.settings.minimiseToTray) app.quit();
  });
}
