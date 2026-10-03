'use strict';
// Оболочка VRCast Bridge для Linux: то же, что WebView2-окно на Windows —
// окно со страницей сервера, трей, диалоги выхода, выбор области и подсветка.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// AppArmor в Ubuntu 24.04 запрещает песочнице Chromium без suid-помощника.
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'), 'VRCastBridge');
// Тот же порядок, что у сервера: переменная окружения, порт из настроек, 4717.
const savedPort = () => { try { const v = Number(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).port); return v >= 1024 && v <= 65400 ? v : 0; } catch { return 0; } };
// Порт могут сменить в настройках на ходу, поэтому адрес считаем каждый раз.
const currentPort = () => Number(process.env.VRCAST_PORT) || savedPort() || 4717;
const urlBase = () => `http://127.0.0.1:${currentPort()}/`;
const GEOMETRY_FILE = path.join(DATA_DIR, 'window.txt');
const ICON = path.join(ROOT, 'launcher', 'assets', 'vrcast-icon.png');
const MEDIA_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'];

let win = null, tray = null, serverChild = null;
let exiting = false, exitRequested = false, trayHintShown = false, broadcasting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

async function api(route, options = {}) {
  const response = await fetch(`${urlBase()}${route}`, { signal: AbortSignal.timeout(2500), ...options });
  return response.json();
}
const serverUp = () => api('api/status?logs=0').then(() => true, () => false);

async function readState() {
  try {
    const root = await api('api/status?logs=0');
    const current = root.currentTemplate;
    return { running: root.running === true, closeToTray: root.config?.closeToTray !== false,
      unsavedList: current && current.dirty === true ? current.name : null };
  } catch { return null; }
}

async function ensureServer() {
  if (await serverUp()) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'vrcast.log.stdout'), 'a');
  // Электрон сам умеет быть Node: отдельная установка Node.js не нужна.
  serverChild = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  serverChild.on('exit', () => { serverChild = null; });
  for (let i = 0; i < 100 && !(await serverUp()); i++) await new Promise(resolve => setTimeout(resolve, 200));
}

function restoreGeometry(options) {
  try {
    const [x, y, width, height, maximized] = fs.readFileSync(GEOMETRY_FILE, 'utf8').split(',').map(Number);
    if (width < options.minWidth || height < options.minHeight) return;
    const area = { x, y, width, height };
    const visible = screen.getAllDisplays().some(({ workArea: w }) =>
      x < w.x + w.width && x + width > w.x && y < w.y + w.height && y + height > w.y);
    if (visible) Object.assign(options, area, { maximized: maximized === 1 });
  } catch {}
}

function saveGeometry() {
  if (!win) return;
  try {
    const b = win.getNormalBounds();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GEOMETRY_FILE, `${b.x},${b.y},${b.width},${b.height},${win.isMaximized() ? 1 : 0}`);
  } catch {}
}

const pageEvent = name => win?.webContents.executeJavaScript(`document.dispatchEvent(new Event('${name}'))`).catch(() => {});
const addFiles = paths => win?.webContents.executeJavaScript(`window.addLocalFiles(${JSON.stringify(paths)})`).catch(() => {});

function createWindow() {
  const options = { width: 1180, height: 760, minWidth: 980, minHeight: 640, maximized: false };
  restoreGeometry(options);
  win = new BrowserWindow({
    ...options, title: 'VRCast Bridge', icon: ICON, backgroundColor: '#0e0c18', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, devTools: false },
  });
  win.setMenu(null);
  if (options.maximized) win.maximize();
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0;display:grid;place-items:center;'
    + 'background:#0e0c18;color:#c9c2e8;font:15px system-ui,sans-serif}</style>VRCast Bridge запускается…'));

  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(urlBase()) || url.startsWith('data:')) return;
    event.preventDefault();
    if (url.startsWith('vrcast://select-region')) selectRegion();
    else if (url.startsWith('vrcast://pick-media')) pickMedia();
    else if (url.startsWith('vrcast://highlight')) highlight(url);
    else if (url.startsWith('vrcast://open-folder')) shell.openPath(DATA_DIR);
    else if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.on('focus', () => pageEvent('vrcast-focus'));
  win.on('blur', () => pageEvent('vrcast-blur'));
  for (const name of ['hide', 'minimize']) win.on(name, () => pageEvent('vrcast-hidden'));
  for (const name of ['show', 'restore']) win.on(name, () => pageEvent('vrcast-shown'));
  win.on('close', onClose);
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (exiting) return;
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function onClose(event) {
  if (exiting) return;
  event.preventDefault();
  closeFlow().catch(() => {});
}

async function closeFlow() {
  const state = await readState();
  if (!exitRequested && state?.closeToTray && tray) return hideToTray();
  exitRequested = false;
  const parent = win?.isVisible() ? win : undefined;
  if (state?.unsavedList) {
    const { response } = await dialog.showMessageBox(parent, { type: 'question', buttons: ['Сохранить', 'Не сохранять', 'Отмена'], cancelId: 2, defaultId: 0,
      title: 'VRCast Bridge', message: `В списке «${state.unsavedList}» есть несохранённые изменения.`, detail: 'Сохранить их перед выходом?' });
    if (response === 2) return;
    if (response === 0) await api('api/templates/current/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  if (state?.running) {
    const { response } = await dialog.showMessageBox(parent, { type: 'warning', buttons: ['Закрыть', 'Отмена'], cancelId: 1, defaultId: 1,
      title: 'VRCast Bridge', message: 'Сейчас идёт эфир — если закрыть программу, у зрителей он прервётся.', detail: 'Всё равно закрыть?' });
    if (response !== 0) return;
  }
  quitAll();
}

function hideToTray() {
  win?.hide();
  if (trayHintShown || !Notification.isSupported()) return;
  trayHintShown = true;
  new Notification({ title: 'VRCast Bridge работает в трее', body: 'Эфир продолжается. Открыть окно — щелчок по значку.', icon: ICON }).show();
}

async function quitAll() {
  exiting = true;
  saveGeometry();
  win?.hide();
  // Сервер штатно сворачивает захват и сам выходит; подстраховываемся сигналом.
  await fetch(`${urlBase()}api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) }).catch(() => {});
  for (let i = 0; i < 20 && await serverUp(); i++) await new Promise(resolve => setTimeout(resolve, 200));
  try { serverChild?.kill('SIGTERM'); } catch {}
  app.exit(0);
}

function setupTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 }));
  tray.setToolTip('VRCast Bridge');
  const build = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: showWindow },
    { label: 'Остановить эфир', enabled: broadcasting, click: () => api('api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}) },
    { type: 'separator' },
    { label: 'Выйти', click: () => { exitRequested = true; showWindow(); win?.close(); } },
  ]));
  tray.on('click', showWindow);
  build();
  // Меню в трее статично — обновляем пункт «Остановить эфир» по опросу.
  setInterval(async () => {
    const state = await readState();
    if ((state?.running === true) !== broadcasting) { broadcasting = state?.running === true; build(); }
  }, 3000).unref();
}

async function pickMedia() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Добавить файлы', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Видео и аудио', extensions: MEDIA_EXTENSIONS }, { name: 'Все файлы', extensions: ['*'] }] });
  if (!canceled && filePaths.length) addFiles(filePaths);
}

function overlay(bounds, file, extra = {}) {
  const overlayWindow = new BrowserWindow({ ...bounds, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, devTools: false }, ...extra });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setBounds(bounds);
  overlayWindow.loadFile(path.join(__dirname, file));
  return overlayWindow;
}

function virtualScreen() {
  const displays = screen.getAllDisplays().map(display => display.bounds);
  const x = Math.min(...displays.map(b => b.x)), y = Math.min(...displays.map(b => b.y));
  return { x, y, width: Math.max(...displays.map(b => b.x + b.width)) - x, height: Math.max(...displays.map(b => b.y + b.height)) - y };
}

function selectRegion() {
  const wasVisible = win?.isVisible();
  win?.hide();
  setTimeout(() => {
    const bounds = virtualScreen();
    const selector = overlay(bounds, 'region.html');
    selector.once('ready-to-show', () => { selector.show(); selector.focus(); });
    const finish = rect => {
      ipcMain.removeAllListeners('region-done');
      if (!selector.isDestroyed()) selector.close();
      if (wasVisible) showWindow();
      if (!rect || rect.width < 64 || rect.height < 64) return;
      const scale = screen.getPrimaryDisplay().scaleFactor;
      const region = { x: Math.round((rect.x + bounds.x) * scale), y: Math.round((rect.y + bounds.y) * scale),
        width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
      win?.webContents.executeJavaScript(`window.applySelectedRegion(${JSON.stringify(region)})`).catch(() => {});
    };
    ipcMain.once('region-done', (_event, rect) => finish(rect));
    selector.on('closed', () => ipcMain.removeAllListeners('region-done'));
  }, 180);
}

function highlight(url) {
  const query = new URL(url).searchParams;
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(key => parseInt(query.get(key), 10));
  if (![x, y, width, height].every(Number.isFinite) || width < 32 || height < 32) return;
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const outline = overlay({ x: Math.round(x / scale), y: Math.round(y / scale), width: Math.round(width / scale), height: Math.round(height / scale) },
    'outline.html', { focusable: false });
  outline.setIgnoreMouseEvents(true);
  outline.once('ready-to-show', () => outline.showInactive());
  setTimeout(() => { if (!outline.isDestroyed()) outline.close(); }, 2200);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  createWindow();
  try { setupTray(); } catch {}
  await ensureServer();
  if (win && await serverUp()) win.loadURL(urlBase());
  else if (win) win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<meta charset="utf-8"><body style="background:#0e0c18;color:#f0a0a0;font:15px system-ui;display:grid;place-items:center;height:100%;margin:0">'
    + 'Сервер не запустился. Журнал: ~/.local/share/VRCastBridge/vrcast.log.stdout'));
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => { if (!exiting) saveGeometry(); });
