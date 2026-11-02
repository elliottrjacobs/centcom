import { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell, clipboard, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import pkg from '../package.json';
import type { ServerInfo } from '../shared/types';
import { startServer } from '../server/index';
import { readConfigFileSync } from '../server/config';
import { desktopInstructionReport } from '../cli/instruction-source';

const DEFAULT_PORT = Number(process.env.CENTCOM_PORT ?? 4747);

let win: BrowserWindow | null = null;
let info: ServerInfo | null = null;
let origin = '';
let stopServer: (() => Promise<void>) | null = null;
/** True when this launch created the config (and with it the vault and owner token). */
let firstRun = false;

/** If a CENTCOM server is already running (e.g. as a background service), use it instead of starting a second one. */
async function findRunningServer(port: number, token: string | undefined): Promise<ServerInfo | null> {
  try {
    // With the token: a server that requires one from local clients must still be recognised.
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<ServerInfo>;
    return body.name === 'centcom' && typeof body.vault === 'string' ? (body as ServerInfo) : null;
  } catch {
    return null;
  }
}

/**
 * The page never holds a token: the main process adds the bearer to the window's own API, MCP and
 * event requests. Only for exactly `origin`, so nothing else the page loads ever sees it.
 */
async function injectBearer(target: string, token: string | undefined): Promise<void> {
  if (!token) return;
  const { session } = await import('electron');
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${target}/api/*`, `${target}/mcp*`] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (new URL(details.url).origin === target) requestHeaders.Authorization = `Bearer ${token}`;
    callback({ requestHeaders });
  });
}

/** The built UI. Inside a packaged app it lives unpacked beside app.asar, so the server reads real files. */
function uiDir(): string {
  return path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'dist-ui');
}

async function ensureServer(): Promise<void> {
  const config = readConfigFileSync();
  firstRun = config === null;
  if (config?.serverUrl) {
    const remote = new URL(config.serverUrl);
    if (remote.protocol !== 'https:') throw new Error('The cloud server must use HTTPS.');
    origin = remote.origin;
    const response = await fetch(`${origin}/api/info`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Cloud connection failed (${response.status}).`);
    info = await response.json() as ServerInfo;
    await injectBearer(origin, config.token);
    return;
  }
  let resolved = await findRunningServer(DEFAULT_PORT, config?.token);
  if (!resolved) {
    const started = await startServer({ uiDir: uiDir(), quiet: true });
    resolved = started.info;
    stopServer = started.close;
  }
  info = resolved;
  origin = `http://127.0.0.1:${resolved.port}`;
  // Local mode too, so the app keeps working when the server requires a token on loopback. Read
  // after starting: a first run has only just written the config, and with it the owner token.
  await injectBearer(origin, readConfigFileSync()?.token);
}

/* ── Updates ── */

/**
 * Signed release builds update themselves from the GitHub Releases feed baked in at package time
 * (electron-builder `publish`). Development and fork builds have no feed and skip this silently.
 */
async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || process.env.CENTCOM_DISABLE_UPDATES === '1') return;
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.warn(`[centcom] update check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ── Window state ── */

const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function readBounds(): Partial<Electron.Rectangle> {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<Electron.Rectangle>;
  } catch {
    return {};
  }
}
function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
  } catch {
    /* non-fatal */
  }
}

function createWindow() {
  const bounds = readBounds();
  win = new BrowserWindow({
    width: bounds.width ?? 1360,
    height: bounds.height ?? 880,
    x: bounds.x,
    y: bounds.y,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: 'CENTCOM',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e10' : '#f3f3f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  // The window only ever shows our own server. Anything else opens in the real browser, or not at all.
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origin) {
      e.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));

  win.once('ready-to-show', () => win?.show());
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(`${origin}/`);
}

function openExternal(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.toString());
  } catch {
    /* not a URL: ignore */
  }
}

/* ── IPC (validated here, never trusted from the page) ── */

function fromOurWindow(e: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame && e.senderFrame?.url && new URL(e.senderFrame.url).origin === origin);
}

/* First run: show the owner token once, then never again from this app. */
const onboardingFile = () => path.join(app.getPath('userData'), 'onboarding.json');
function onboarded(): boolean {
  try {
    return (JSON.parse(fs.readFileSync(onboardingFile(), 'utf8')) as { done?: boolean }).done === true;
  } catch {
    return false;
  }
}

ipcMain.handle('centcom:onboarding', (e) => {
  if (!fromOurWindow(e)) throw new Error('Onboarding request refused');
  if (!firstRun || onboarded() || !info) return { show: false };
  return { show: true, vault: info.vault, token: readConfigFileSync()?.token ?? null, docs: (pkg as { homepage?: string }).homepage ?? null };
});

ipcMain.handle('centcom:onboarding-done', (e) => {
  if (!fromOurWindow(e)) throw new Error('Onboarding request refused');
  firstRun = false;
  fs.writeFileSync(onboardingFile(), JSON.stringify({ done: true, at: Date.now() }));
});

/* Open at login: the app keeps the server running while it is open, windows or not. */
ipcMain.handle('centcom:login-item', (e, enable: unknown) => {
  if (!fromOurWindow(e)) throw new Error('Login item request refused');
  if (!app.isPackaged) return { supported: false, enabled: false };
  if (typeof enable === 'boolean') app.setLoginItemSettings({ openAtLogin: enable, type: 'mainAppService' });
  return { supported: true, enabled: app.getLoginItemSettings({ type: 'mainAppService' }).openAtLogin };
});

ipcMain.handle('centcom:scan-instructions', async (e) => {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame ||
      !e.senderFrame?.url || new URL(e.senderFrame.url).origin !== origin) {
    throw new Error('Instruction scan refused');
  }
  return desktopInstructionReport();
});

ipcMain.handle('centcom:copy-text', (e, text: unknown) => {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame ||
      !e.senderFrame?.url || new URL(e.senderFrame.url).origin !== origin) {
    throw new Error('Clipboard request refused');
  }
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid clipboard text');
  clipboard.writeText(text);
});

ipcMain.handle('centcom:copy-server-token', (e) => {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame ||
      !e.senderFrame?.url || new URL(e.senderFrame.url).origin !== origin) {
    throw new Error('Clipboard request refused');
  }
  const token = readConfigFileSync()?.token;
  if (!token) throw new Error('Server token is not configured');
  clipboard.writeText(token);
});

function resolveInVault(rel: string): string | null {
  if (!info) return null;
  const vault = path.resolve(info.vault);
  const target = path.resolve(vault, rel);
  if (target !== vault && !target.startsWith(vault + path.sep)) return null;
  return fs.existsSync(target) ? target : null;
}

ipcMain.on('centcom:reveal', (e, rel: unknown) => {
  if (e.senderFrame?.url && new URL(e.senderFrame.url).origin !== origin) return;
  const target = typeof rel === 'string' ? resolveInVault(rel) : null;
  if (target) shell.showItemInFolder(target);
});
/**
 * Open a vault file in its default app. Opening is execution-adjacent, so beyond the vault
 * check this refuses anything macOS would *run* rather than *view*: a file an agent dropped
 * into the vault must not become code execution because someone clicked "Open".
 */
const NEVER_OPEN = /\.(app|command|tool|sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|jar|pkg|mpkg|dmg|scpt|scptd|applescript|workflow|action|terminal|inetloc|webloc|fileloc|url|desktop|exe|bat|cmd|ps1|vbs)$/i;
ipcMain.on('centcom:open', (e, rel: unknown) => {
  if (e.senderFrame?.url && new URL(e.senderFrame.url).origin !== origin) return;
  const target = typeof rel === 'string' ? resolveInVault(rel) : null;
  if (!target || NEVER_OPEN.test(target)) return;
  try {
    if (!fs.statSync(target).isFile()) return;
    // An executable bit on an extensionless file means `open` would run it in Terminal.
    if ((fs.statSync(target).mode & 0o111) !== 0 && !/\.[a-z0-9]{2,5}$/i.test(target)) return;
  } catch {
    return;
  }
  void shell.openPath(target);
});
ipcMain.on('centcom:open-vault', (e) => {
  if (e.senderFrame?.url && new URL(e.senderFrame.url).origin !== origin) return;
  if (info) void shell.openPath(info.vault);
});

/* ── Menu: the Edit roles are what make ⌘C/⌘V/⌘Z work in a frameless-title window ── */

function buildMenu() {
  const send = (name: string) => () => win?.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(name)}, { detail: {} }))`);
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Ticket', accelerator: 'CmdOrCtrl+N', click: send('centcom:new-ticket') },
        { label: 'New Project', accelerator: 'CmdOrCtrl+Shift+N', click: send('centcom:new-project') },
        { type: 'separator' },
        { label: 'Open Vault in Finder', click: () => info && void shell.openPath(info.vault) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: send('centcom:toggle-sidebar') },
        { type: 'separator' },
        { role: 'reload' },
        // Inspecting the page is for development; a shipped app has no reason to offer it.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── Lifecycle ── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(async () => {
    try {
      await ensureServer();
    } catch (err) {
      const { dialog } = await import('electron');
      dialog.showErrorBox('CENTCOM could not start', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
    buildMenu();
    // Launched at login: keep the server up quietly, no window until the app is opened.
    const atLogin = app.getLoginItemSettings().wasOpenedAtLogin === true;
    if (!atLogin) createWindow();
    void checkForUpdates();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Stay alive with no windows (macOS convention) so agents can keep writing while the window is closed.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !stopServer) return;
    quitting = true;
    e.preventDefault();
    void stopServer().finally(() => app.quit());
  });
}
