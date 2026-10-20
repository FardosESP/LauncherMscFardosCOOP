const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const { execFile, spawn } = require('child_process');

const TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const TAILSCALE_URL = 'https://tailscale.com/download';
const TAILSCALE_INSTALLER_URL = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe';
const TAILSCALE_KEYS_URL = 'https://login.tailscale.com/admin/settings/keys';
const STEAM_VDF = 'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf';
const DEFAULT_PORT = 25565;

const settingsPath = () => path.join(app.getPath('userData'), 'launcher.json');

function toolsDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(__dirname, '..', 'tools');
}

function loadSettings() {
  const defaults = { gameDir: '', mode: 'host', address: '', port: DEFAULT_PORT, playerName: os.userInfo().username };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

const isGameDir = (dir) => !!dir && fs.existsSync(path.join(dir, 'mysummercar.exe'));
const loaderInstalled = (dir) =>
  isGameDir(dir) && fs.existsSync(path.join(dir, 'Mods')) && fs.existsSync(path.join(dir, 'winhttp.dll'));
const tailscaleInstalled = () => fs.existsSync(TAILSCALE_EXE);

// Bibliotecas de Steam: lee libraryfolders.vdf para encontrar cualquier unidad con juegos.
function steamCommonDirs() {
  const dirs = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common',
    'C:\\Program Files\\Steam\\steamapps\\common',
  ];
  try {
    const text = fs.readFileSync(STEAM_VDF, 'utf8');
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      dirs.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common'));
    }
  } catch { /* sin Steam: se ignora */ }
  return dirs;
}

// Búsqueda en anchura con profundidad y número de carpetas limitados para no bloquear.
function findGameDir(root, maxDepth = 4, maxVisited = 4000) {
  const queue = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < maxVisited) {
    const { dir, depth } = queue.shift();
    visited++;
    if (isGameDir(dir)) return dir;
    if (depth >= maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '$RECYCLE.BIN') {
        queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

function autoDetectGameDir() {
  const home = os.homedir();
  const roots = [...steamCommonDirs(), path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const found = findGameDir(root);
    if (found) return found;
  }
  return '';
}

// La IP de Tailscale cambia poco: se reutiliza unos segundos para no lanzar un proceso en cada refresco.
let tailscaleCache = { at: 0, ip: '' };

function tailscaleIp() {
  if (Date.now() - tailscaleCache.at < 30000) return Promise.resolve(tailscaleCache.ip);
  return new Promise((resolve) => {
    if (!tailscaleInstalled()) return resolve('');
    execFile(TAILSCALE_EXE, ['ip', '-4'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const ip = err ? '' : stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('100.')) || '';
      tailscaleCache = { at: Date.now(), ip };
      resolve(ip);
    });
  });
}

async function getState(override) {
  const settings = loadSettings();
  if (override !== undefined) {
    settings.gameDir = override;
    if (isGameDir(override)) saveSettings(settings);
  } else if (!isGameDir(settings.gameDir)) {
    // Solo se escanea el disco si la carpeta guardada ya no es válida; el resultado se guarda.
    const detected = autoDetectGameDir();
    if (detected) {
      settings.gameDir = detected;
      saveSettings(settings);
    }
  }
  const dir = settings.gameDir;
  return {
    settings,
    game: isGameDir(dir),
    loader: loaderInstalled(dir),
    tailscale: tailscaleInstalled(),
    tailscaleIp: await tailscaleIp(),
    firewall: await firewallOpen(settings.port),
    version: app.getVersion(),
  };
}

// Regla de firewall para el puerto de partida. Consultar no necesita administrador.
const firewallRuleName = (port) => `Fardos MSC Coop TCP ${port}`;

function firewallOpen(port) {
  return new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${firewallRuleName(port)}`],
      { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 860,
    minHeight: 600,
    resizable: true,
    maximizable: true,
    backgroundColor: '#0d0f14',
    title: 'Fardos MSC Coop',
    icon: path.join(__dirname, '..', 'build', 'app.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('state:get', (_e, gameDir) => getState(gameDir));

ipcMain.handle('settings:save', (_e, s) => {
  saveSettings(s);
  return true;
});

ipcMain.handle('game:pick', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Elige la carpeta de My Summer Car (la que contiene mysummercar.exe)',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('game:autodetect', () => autoDetectGameDir());

// Copia MSCLoader desde el paquete incluido en el launcher (tools\msc-loader); no hace falta descargar nada.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

ipcMain.handle('loader:install', (_e, gameDir) => {
  const dir = gameDir || loadSettings().gameDir;
  if (!isGameDir(dir)) return { ok: false, error: 'Elige primero la carpeta del juego.' };
  const bundle = path.join(toolsDir(), 'msc-loader');
  if (!fs.existsSync(bundle)) return { ok: false, error: 'Falta el paquete de MSCLoader dentro del launcher.' };
  try {
    copyDir(path.join(bundle, 'root'), dir);
    copyDir(path.join(bundle, 'Managed'), path.join(dir, 'mysummercar_Data', 'Managed'));
    fs.mkdirSync(path.join(dir, 'Mods'), { recursive: true });
  } catch (e) {
    return { ok: false, error: `No se pudo instalar MSCLoader: ${e.message}` };
  }
  return { ok: true };
});

ipcMain.handle('tailscale:open', () => shell.openExternal(TAILSCALE_URL));
ipcMain.handle('tailscale:keys', () => shell.openExternal(TAILSCALE_KEYS_URL));

// Conecta esta máquina a la red de Tailscale con una clave de invitación (no hace falta iniciar sesión).
// La clave se usa una vez y no se guarda.
ipcMain.handle('tailscale:login', (_e, key) => {
  const k = String(key || '').trim();
  if (!tailscaleInstalled()) return { ok: false, error: 'Primero instala Tailscale.' };
  if (!/^tskey-[\w-]+$/.test(k)) return { ok: false, error: 'La clave no es válida. Debe empezar por «tskey-».' };
  return new Promise((resolve) => {
    execFile(TAILSCALE_EXE, ['up', `--authkey=${k}`, '--unattended'], { timeout: 60000, windowsHide: true },
      async (err, _stdout, stderr) => {
        tailscaleCache = { at: 0, ip: '' };
        const ip = await tailscaleIp();
        if (ip) return resolve({ ok: true, ip });
        const detail = (stderr || (err && err.message) || 'desconocido').toString().trim().slice(0, 300);
        resolve({ ok: false, error: `No se pudo conectar a Tailscale: ${detail}` });
      });
  });
});

// Abre el puerto de partida en el firewall de Windows. Pide permisos de administrador (UAC).
ipcMain.handle('firewall:open', (_e, port) => {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'Puerto no válido.' };
  const name = firewallRuleName(p);
  const script = `netsh advfirewall firewall delete rule name='${name}' | Out-Null; ` +
    `netsh advfirewall firewall add rule name='${name}' dir=in action=allow protocol=TCP localport=${p}`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${script.replace(/"/g, '\\"')}"`],
    { timeout: 120000, windowsHide: true }, async (err) => {
      const ok = !err && await firewallOpen(p);
      resolve(ok ? { ok: true } : { ok: false, error: 'No se abrió el puerto. Acepta la petición de administrador o ábrelo a mano.' });
    });
  });
});

// Descarga el instalador oficial de Tailscale, comprueba su firma y lo ejecuta (Windows pedirá permisos de administrador).
ipcMain.handle('tailscale:install', async () => {
  const dest = path.join(os.tmpdir(), 'fardos-tailscale-setup.exe');
  try {
    await downloadFile(TAILSCALE_INSTALLER_URL, dest);
  } catch (e) {
    return { ok: false, error: `No se pudo descargar Tailscale (${e.message}). Se abre la web oficial.` };
  }
  if (!(await isTailscaleSigned(dest))) {
    fs.rmSync(dest, { force: true });
    return { ok: false, error: 'La firma del instalador no es de Tailscale. Instalación cancelada.' };
  }
  const err = await shell.openPath(dest);
  return err ? { ok: false, error: err } : { ok: true };
});

function downloadFile(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('tiempo agotado')));
    req.on('error', reject);
  });
}

// Comprueba que el ejecutable esté firmado digitalmente por Tailscale.
function isTailscaleSigned(file) {
  return new Promise((resolve) => {
    const cmd = `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}').SignerCertificate.Subject`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      resolve(!err && /Tailscale/i.test(stdout));
    });
  });
}

ipcMain.handle('mods:open', async (_e, gameDir) => {
  const dir = gameDir || loadSettings().gameDir;
  if (!isGameDir(dir)) return { ok: false, error: 'Elige primero la carpeta del juego.' };
  const mods = path.join(dir, 'Mods');
  fs.mkdirSync(mods, { recursive: true });
  const err = await shell.openPath(mods);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('game:launch', (_e, payload) => {
  const { gameDir, mode, address, port, playerName, tailscaleIp: ip } = payload;
  if (!isGameDir(gameDir)) return { ok: false, error: 'Elige primero la carpeta del juego.' };
  if (!loaderInstalled(gameDir)) return { ok: false, error: 'MSCLoader no está instalado.' };
  if (mode === 'client' && !address) return { ok: false, error: 'Escribe la IP de tu amigo.' };

  const config = {
    Mode: mode,
    Address: mode === 'host' ? (ip || '127.0.0.1') : address.trim(),
    Port: Number(port) || DEFAULT_PORT,
    PlayerName: (playerName || '').trim() || os.userInfo().username,
  };
  const configDir = path.join(gameDir, 'Mods', 'Config');
  fs.mkdirSync(configDir, { recursive: true });
  // Conserva los ajustes de partida que el mod guarda desde el menú in-game (p. ej. MaxCars).
  const configFile = path.join(configDir, 'msc-coop.json');
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* primera vez */ }
  config.MaxCars = Number(previous.MaxCars) >= 2 ? 2 : 1;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  // Instala o actualiza el mod de cooperativo para que siempre coincida con la versión del launcher.
  const bundledMod = path.join(toolsDir(), 'MscCoop.dll');
  if (fs.existsSync(bundledMod)) {
    fs.copyFileSync(bundledMod, path.join(gameDir, 'Mods', 'MscCoop.dll'));
  }

  saveSettings({ gameDir, mode, address: address || '', port: config.Port, playerName: config.PlayerName });
  spawn(path.join(gameDir, 'mysummercar.exe'), [], { cwd: gameDir, detached: true, stdio: 'ignore' }).unref();
  return { ok: true, config };
});

// Auto-actualización: al arrancar busca una versión nueva en GitHub Releases, la descarga y la instala al cerrar.
function setupAutoUpdate(win) {
  if (!app.isPackaged) return;
  const send = (text, kind = '') => {
    if (!win.isDestroyed()) win.webContents.send('update:status', { text, kind });
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => send(`Descargando la versión ${info.version}…`, 'ok'));
  autoUpdater.on('update-downloaded', (info) => send(`Versión ${info.version} lista. Se instalará al cerrar el launcher.`, 'ok'));
  autoUpdater.on('error', () => send('No se pudo comprobar actualizaciones. Se seguirá con la versión actual.'));
  autoUpdater.checkForUpdates().catch(() => {});
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdate(BrowserWindow.getAllWindows()[0]);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
