const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const saves = require('./saves');
const { autoUpdater } = require('electron-updater');
const { execFile, execFileSync, spawn } = require('child_process');

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

// Build del juego con la que se probó el mod (Assembly-CSharp.dll). Si no coincide, puede fallar.
const TESTED_BUILD_ASSEMBLY_SIZE = 1396736;
const gameBuildOk = (dir) => {
  try {
    return fs.statSync(path.join(dir, 'mysummercar_Data', 'Managed', 'Assembly-CSharp.dll')).size === TESTED_BUILD_ASSEMBLY_SIZE;
  } catch {
    return false;
  }
};
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
    build: gameBuildOk(dir),
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

// ---------- Requisitos ----------

// Lista de requisitos con su estado. `needed` indica si bloquea jugar o solo sirve para partidas a distancia o como anfitrión.
async function requirementsStatus(gameDirInput) {
  const settings = loadSettings();
  const dir = gameDirInput || settings.gameDir || '';
  const bundle = path.join(toolsDir(), 'msc-loader');
  const managed = path.join(dir, 'mysummercar_Data', 'Managed');
  const same = (a, b) => sha256(a) !== 'NO EXISTE' && sha256(a) === sha256(b);
  // Todos los archivos del paquete (raíz y Managed) deben estar en el juego y ser idénticos.
  const listFiles = (root) => {
    const out = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.push(r);
      }
    };
    walk(root, "");
    return out;
  };
  const bundleFiles = [
    ...listFiles(path.join(bundle, "root")).map((rel) => [path.join(dir, rel), path.join(bundle, "root", rel)]),
    ...listFiles(path.join(bundle, "Managed")).map((rel) => [path.join(managed, rel), path.join(bundle, "Managed", rel)]),
  ];
  const loaderOk = isGameDir(dir) && bundleFiles.every(([a, b]) => same(a, b));
  const modOk = same(path.join(dir, 'Mods', 'MscCoop.dll'), path.join(toolsDir(), 'MscCoop.dll'));
  const ts = await tailscaleStatus();
  const major = parseInt(os.release().split('.')[0], 10);

  return [
    { id: 'windows', label: 'Windows 10 o superior', ok: major >= 10, needed: true, detail: `Versión ${os.release()}` },
    { id: 'game', label: 'My Summer Car encontrado', ok: isGameDir(dir), needed: true, fix: 'choose', detail: dir || 'No encontrado' },
    {
      id: 'framework',
      label: 'Librerías del juego necesarias (System.*)',
      ok: isGameDir(dir) && ['System.dll', 'System.Core.dll', 'System.Data.dll', 'System.Xml.dll', 'System.Runtime.Serialization.dll']
        .every((f) => fs.existsSync(path.join(managed, f))),
      needed: true,
      fix: 'loader',
      detail: isGameDir(dir)
        ? (['System.dll', 'System.Core.dll', 'System.Data.dll', 'System.Xml.dll', 'System.Runtime.Serialization.dll']
          .filter((f) => !fs.existsSync(path.join(managed, f))).join(', ') || 'Todas presentes')
        : 'Sin juego',
    },
    { id: 'build', label: 'Versión del juego probada (build 20171487)', ok: gameBuildOk(dir), needed: false, detail: gameBuildOk(dir) ? 'Correcta' : 'Otra versión: puede fallar' },
    { id: 'loader', label: 'MSCLoader instalado y actualizado', ok: loaderOk, needed: true, fix: 'loader', detail: loaderOk ? 'Correcto' : 'Falta o no coincide' },
    { id: 'mod', label: 'Mod MscCoop instalado y actualizado', ok: modOk, needed: true, fix: 'loader', detail: modOk ? 'Correcto (se actualiza al pulsar Jugar)' : 'Se copiará al pulsar Jugar' },
    { id: 'tailscale', label: 'Tailscale instalado', ok: !!ts.installed, needed: false, fix: 'tailscale', detail: ts.installed ? 'Sí' : 'Solo hace falta para jugar a distancia' },
    { id: 'tsconnected', label: 'Tailscale conectado a la red', ok: !!(ts.installed && ts.running && ts.ip), needed: false, fix: 'tskey', detail: ts.running ? `IP ${ts.ip || '—'}` : (ts.error || 'Pega una clave de invitación') },
    { id: 'firewall', label: `Firewall abierto en el puerto ${settings.port} (anfitrión)`, ok: await firewallOpen(settings.port), needed: false, fix: 'firewall', detail: 'Solo lo necesita quien crea la partida' },
  ];
}

ipcMain.handle('req:check', (_e, gameDir) => requirementsStatus(gameDir));

// ---------- Diagnóstico ----------

const sha256 = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return 'NO EXISTE';
  }
};
const fileSize = (file) => {
  try { return `${fs.statSync(file).size} bytes`; } catch { return 'NO EXISTE'; }
};
const tailLines = (file, n) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '(no existe)';
  }
};
const exists = (p) => (fs.existsSync(p) ? 'sí' : 'no');

// Genera un informe con todas las comprobaciones y lo guarda en la carpeta de datos del launcher.
async function runDiagnostics(gameDirInput) {
  const settings = loadSettings();
  const dir = gameDirInput || settings.gameDir || '';
  const bundle = path.join(toolsDir(), 'msc-loader');
  const managed = path.join(dir, 'mysummercar_Data', 'Managed');
  const out = [];
  const line = (k, v) => out.push(`${k}: ${v}`);
  const sec = (t) => out.push(`\n== ${t} ==`);

  sec('Launcher');
  line('Versión', app.getVersion());
  line('Empaquetado', app.isPackaged);
  line('Windows', os.release());
  line('Arquitectura', process.arch);
  line('Fecha', new Date().toISOString());

  sec('Juego');
  line('Carpeta', dir || '(no elegida)');
  line('mysummercar.exe', isGameDir(dir) ? 'sí' : 'no');
  line('Assembly-CSharp.dll', fileSize(path.join(managed, 'Assembly-CSharp.dll')));
  line('Build probada', gameBuildOk(dir) ? 'sí' : 'no');
  line('steam_api64.dll', exists(path.join(dir, 'steam_api64.dll')));
  line('steam_settings', exists(path.join(dir, 'steam_settings')));

  sec('MSCLoader (instalado vs paquete)');
  for (const rel of ['winhttp.dll', 'doorstop_config.ini']) {
    line(rel, `${sha256(path.join(dir, rel))} | paquete ${sha256(path.join(bundle, 'root', rel))}`);
  }
  for (const f of ['MSCLoader.dll', 'MSCLoader.Preloader.dll', 'INIFileParser.dll', 'Ionic.Zip.Reduced.dll', '0Harmony.dll', 'Newtonsoft.Json.dll', 'NAudio.dll', 'NVorbis.dll', 'NAudio.Flac.dll', 'System.Runtime.Serialization.dll']) {
    line(f, `${sha256(path.join(managed, f))} | paquete ${sha256(path.join(bundle, 'Managed', f))}`);
  }
  line('winhttp.dll.orig', exists(path.join(dir, 'winhttp.dll.orig')));
  line('fardos-backup', exists(path.join(dir, 'fardos-backup')));

  sec('Mod');
  line('Mods/MscCoop.dll', `${sha256(path.join(dir, 'Mods', 'MscCoop.dll'))} | paquete ${sha256(path.join(toolsDir(), 'MscCoop.dll'))}`);
  line('Mods/MscCoop.dll tamaño', fileSize(path.join(dir, 'Mods', 'MscCoop.dll')));
  let otherMods = [];
  try {
    otherMods = fs.readdirSync(path.join(dir, 'Mods')).filter((f) => /\.dll$/i.test(f) && f !== 'MscCoop.dll');
  } catch { /* sin carpeta Mods */ }
  line('Otros DLL en Mods', otherMods.length ? otherMods.join(', ') : 'ninguno');
  sec('msc-coop.json (sin claves)');
  out.push(tailLines(path.join(dir, 'Mods', 'Config', 'msc-coop.json'), 30));

  sec('Red');
  line('Tailscale instalado', tailscaleInstalled() ? 'sí' : 'no');
  line('IP Tailscale', (await tailscaleIp()) || '(sin IP)');
  line('Firewall (puerto ' + settings.port + ')', (await firewallOpen(settings.port)) ? 'abierto' : 'cerrado');
  line('Modo', settings.mode);

  sec('output_log.txt (últimas 80 líneas)');
  out.push(tailLines(path.join(dir, 'output_log.txt'), 80));
  sec('MSCLoader_Preloader.txt (últimas 40 líneas)');
  out.push(tailLines(path.join(dir, 'MSCLoader_Preloader.txt'), 40));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(app.getPath('userData'), `diagnostico-${stamp}.txt`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, out.join('\n'));
  return reportPath;
}

ipcMain.handle('diag:run', async (_e, gameDir) => {
  try {
    return { ok: true, path: await runDiagnostics(gameDir) };
  } catch (e) {
    return { ok: false, error: `No se pudo generar el diagnóstico: ${e.message}` };
  }
});
ipcMain.handle('diag:show', (_e, p) => shell.showItemInFolder(p));

// Archivos que el launcher puede tocar dentro de la carpeta del juego (relativos a ella).
const MANAGED_REL = path.join('mysummercar_Data', 'Managed');
const BACKUP_FILES = [
  'winhttp.dll',
  'winhttp.dll.orig',
  'doorstop_config.ini',
  path.join(MANAGED_REL, 'MSCLoader.dll'),
  path.join(MANAGED_REL, 'MSCLoader.Preloader.dll'),
  path.join(MANAGED_REL, 'MSCLoader.xml'),
  path.join(MANAGED_REL, 'INIFileParser.dll'),
  path.join(MANAGED_REL, 'Ionic.Zip.Reduced.dll'),
  path.join(MANAGED_REL, '0Harmony.dll'),
  path.join(MANAGED_REL, 'Newtonsoft.Json.dll'),
  path.join(MANAGED_REL, 'NAudio.dll'),
  path.join(MANAGED_REL, 'NVorbis.dll'),
  path.join(MANAGED_REL, 'NAudio.Flac.dll'),
  path.join(MANAGED_REL, 'System.Runtime.Serialization.dll'),
  path.join('Mods', 'Assets', 'MSCLoader_Console', 'console.unity3d'),
  path.join('Mods', 'Assets', 'MSCLoader_Settings', 'settingsui.unity3d'),
  path.join('Mods', 'MscCoop.dll'),
  path.join('Mods', 'Config', 'msc-coop.json'),
];

// Copia de seguridad: se hace una sola vez, antes del primer cambio del launcher.
// Guarda cómo estaban los archivos (y si no existían) para poder restaurarlos.
function backupBeforeChange(dir) {
  const backupDir = path.join(dir, 'fardos-backup');
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const entries = BACKUP_FILES.map((rel) => {
    const src = path.join(dir, rel);
    const existed = fs.existsSync(src);
    if (existed) {
      const dst = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    return { path: rel, existed };
  });
  fs.writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), files: entries }, null, 2));
}

// Restaura la copia: devuelve los archivos originales y borra los que el launcher añadió.
function restoreBackup(dir) {
  const backupDir = path.join(dir, 'fardos-backup');
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, error: 'No hay copia de seguridad que restaurar.' };
  const { files } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const { path: rel, existed } of files) {
    const target = path.join(dir, rel);
    if (existed) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(backupDir, rel), target);
    } else {
      fs.rmSync(target, { force: true });
    }
  }
  return { ok: true };
}

// Copia MSCLoader desde el paquete incluido en el launcher (tools\msc-loader); no hace falta descargar nada.
// Copia solo los archivos que no existan en el destino.
function copyMissing(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const to = path.join(dst, name);
    if (!fs.existsSync(to)) fs.copyFileSync(path.join(src, name), to);
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

ipcMain.handle('backup:restore', (_e, gameDir) => {
  const dir = gameDir || loadSettings().gameDir;
  if (!isGameDir(dir)) return { ok: false, error: 'Elige primero la carpeta del juego.' };
  try {
    return restoreBackup(dir);
  } catch (e) {
    return { ok: false, error: `No se pudo restaurar la copia: ${e.message}` };
  }
});

// Instala o repara MSCLoader y el mod desde el paquete del launcher. Es seguro llamarla varias veces:
// solo copia lo que falta o no coincide, y guarda copia de seguridad antes de tocar nada.
const GAME_BUSY = 'El juego está abierto. Ciérralo para actualizar MSCLoader y el mod.';
function gameRunning() {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq mysummercar.exe', '/NH'], { windowsHide: true, encoding: 'utf8' })
      .toLowerCase().includes('mysummercar.exe');
  } catch {
    return false;
  }
}

function installLoaderFiles(dir) {
  if (!isGameDir(dir)) return { ok: false, error: 'Elige primero la carpeta del juego.' };
  // Con el juego abierto, Windows bloquea sus DLL: no se intenta copiar.
  if (gameRunning()) return { ok: false, busy: true, error: GAME_BUSY };
  const bundle = path.join(toolsDir(), 'msc-loader');
  if (!fs.existsSync(bundle)) return { ok: false, error: 'Falta el paquete de MSCLoader dentro del launcher.' };
  try {
    backupBeforeChange(dir);
    // Si ya hay un winhttp.dll distinto, se guarda una copia antes de reemplazarlo.
    const target = path.join(dir, 'winhttp.dll');
    const src = path.join(bundle, 'root', 'winhttp.dll');
    if (fs.existsSync(target) && !fs.readFileSync(target).equals(fs.readFileSync(src)) && !fs.existsSync(`${target}.orig`)) {
      fs.renameSync(target, `${target}.orig`);
    }
    copyDir(path.join(bundle, 'root'), dir);
    copyDir(path.join(bundle, 'Managed'), path.join(dir, 'mysummercar_Data', 'Managed'));
    // Librerías del sistema que MSCLoader necesita: solo se copian si faltan (no se sustituye nada que ya exista).
    copyMissing(path.join(bundle, 'Managed-fallback'), path.join(dir, 'mysummercar_Data', 'Managed'));
    fs.mkdirSync(path.join(dir, 'Mods'), { recursive: true });
    // El mod también se instala aquí, para que aparezca en MSCLoader sin tener que pulsar Jugar.
    fs.copyFileSync(path.join(toolsDir(), 'MscCoop.dll'), path.join(dir, 'Mods', 'MscCoop.dll'));
  } catch (e) {
    // EBUSY/EPERM: un archivo está en uso (normalmente el juego). Se pide cerrarlo en vez de mostrar el error técnico.
    if (e.code === 'EBUSY' || e.code === 'EPERM') return { ok: false, busy: true, error: GAME_BUSY };
    return { ok: false, error: `No se pudo instalar MSCLoader: ${e.message}` };
  }
  return { ok: true };
}

ipcMain.handle('loader:install', (_e, gameDir) => installLoaderFiles(gameDir || loadSettings().gameDir));

ipcMain.handle('tailscale:open', () => shell.openExternal(TAILSCALE_URL));
ipcMain.handle('tailscale:keys', () => shell.openExternal(TAILSCALE_KEYS_URL));

// Estado de Tailscale: si está conectado, tu IP, la red y los compañeros en línea.
function tailscaleStatus() {
  return new Promise((resolve) => {
    if (!tailscaleInstalled()) return resolve({ installed: false });
    execFile(TAILSCALE_EXE, ['status', '--json'], { timeout: 8000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ installed: true, running: false, error: 'Tailscale no responde. Comprueba que el servicio esté iniciado.' });
      try {
        const j = JSON.parse(stdout);
        const self = j.Self || {};
        const peers = Object.values(j.Peer || {}).map((p) => ({
          name: p.HostName || '?',
          ip: (p.TailscaleIPs || []).find((x) => x.startsWith('100.')) || '',
          online: !!p.Online,
        }));
        resolve({
          installed: true,
          running: j.BackendState === 'Running',
          name: self.HostName || '',
          ip: (self.TailscaleIPs || []).find((x) => x.startsWith('100.')) || '',
          tailnet: (j.CurrentTailnet && j.CurrentTailnet.Name) || '',
          peers,
        });
      } catch {
        resolve({ installed: true, running: false, error: 'No se pudo leer el estado de Tailscale.' });
      }
    });
  });
}
ipcMain.handle('tailscale:status', () => tailscaleStatus());

// Comprueba si el anfitrión responde en la red de Tailscale.
ipcMain.handle('tailscale:ping', (_e, ip) => new Promise((resolve) => {
  const target = String(ip || '').trim();
  if (!/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) return resolve({ ok: false, error: 'La IP debe tener el formato 100.x.x.x.' });
  // Tailscale sale con código de error aunque responda si la conexión va por relé (DERP): se mira el «pong».
  execFile(TAILSCALE_EXE, ['ping', '--c', '1', '--timeout', '4s', target], { timeout: 10000, windowsHide: true }, (_err, stdout) => {
    const out = (stdout || '').trim();
    const answered = /pong/i.test(out);
    const relayed = /via DERP/i.test(out);
    resolve({
      ok: answered,
      relayed,
      detail: answered
        ? (relayed ? 'Responde, pero por relé: irá algo más lento.' : 'Responde por conexión directa.')
        : 'No responde. Revisa que el otro PC tenga Tailscale abierto y conectado.',
    });
  });
}));

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
  const saveName = firewallRuleName(p + 1);
  // Dos reglas: la de partida y la de compartir la partida guardada (puerto + 1).
  const script = `netsh advfirewall firewall delete rule name='${name}' | Out-Null; ` +
    `netsh advfirewall firewall add rule name='${name}' dir=in action=allow protocol=TCP localport=${p}; ` +
    `netsh advfirewall firewall delete rule name='${saveName}' | Out-Null; ` +
    `netsh advfirewall firewall add rule name='${saveName}' dir=in action=allow protocol=TCP localport=${p + 1}`;
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

// Vigila output_log.txt tras lanzar el juego: avisa si MSCLoader o el mod fallan y muestra el estado de la conexión del mod.
function watchGameLog(dir, webContents) {
  const log = path.join(dir, 'output_log.txt');
  const started = Date.now();
  let loaded = false;
  let lastCoop = '';
  const send = (text, kind) => {
    if (!webContents.isDestroyed()) webContents.send('game:status', { text, kind });
  };
  send('Juego iniciado. Comprobando que MSCLoader y el mod cargan…', '');
  const timer = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { /* aún no existe */ }
    if (/crashed during load|Could not load type|Mod .* has thrown an error/.test(text)) {
      clearInterval(timer);
      return send('El mod ha fallado al cargar. Pulsa «Reparar MSCLoader» y, si sigue, pásanos el diagnóstico.', 'bad');
    }
    if (!loaded && /Loaded [1-9]d* mods?/.test(text)) {
      loaded = true;
      send('MSCLoader y el mod cargados correctamente.', 'ok');
    }
    // Mensajes de conexión que escribe el mod (p. ej. «conectado a …», «se ha unido»).
    // Solo mensajes conocidos del mod (cortados antes de cualquier resto de log de Unity).
    // Sin expresiones regulares con barras: se busca la marca y se corta en el primer «(» (resto del log de Unity).
    const coopMark = '[MSC Coop] ';
    const knownMsg = /^(escuchando|conectado|desconectado|No se pudo|Versi|.* se ha (unido|desconectado))/;
    let coop = '';
    for (const raw of text.split('\n')) {
      const at = raw.indexOf(coopMark);
      if (at < 0) continue;
      let msg = raw.slice(at + coopMark.length).replace('\r', '');
      const cut = msg.indexOf('(');
      if (cut >= 0) msg = msg.slice(0, cut);
      msg = msg.trim();
      if (knownMsg.test(msg)) coop = msg;
    }
    if (coop && coop !== lastCoop) {
      lastCoop = coop;
      const bad = /No se pudo|desconectado del|Versi[oó]n/i.test(coop);
      send('Mod: ' + coop, bad ? 'bad' : 'ok');
    }
    if (!loaded && Date.now() - started > 120000) {
      clearInterval(timer);
      send('MSCLoader no se ha cargado. Pulsa «Reparar MSCLoader» y vuelve a intentarlo.', 'bad');
    }
    if (loaded && Date.now() - started > 600000) clearInterval(timer);
  }, 2000);
}

// Partida compartida: la carpeta de partidas de My Summer Car y las copias de seguridad del launcher.
const MSC_SAVE_DIR = path.join(os.homedir(), 'AppData', 'LocalLow', 'Amistech', 'My Summer Car');
const savesBackupDir = () => path.join(app.getPath('userData'), 'partidas-anteriores');
let saveServer = null;
// El anfitrión sirve su partida en el puerto de partida + 1, solo por la IP de Tailscale si la hay.
function ensureSaveServer(ip, savePort) {
  if (!saveServer) saveServer = saves.startSaveServer(MSC_SAVE_DIR, savePort, ip || '0.0.0.0');
}

ipcMain.handle('game:launch', async (_e, payload) => {
  const { gameDir, mode, address, port, playerName, tailscaleIp: ip } = payload;
  if (!isGameDir(gameDir)) return { ok: false, error: 'Elige primero la carpeta del juego.' };
  if (gameRunning()) return { ok: false, error: 'El juego ya está abierto. Vuelve a la ventana del juego.' };
  // Antes de jugar se comprueba y repara MSCLoader y el mod automáticamente.
  const repair = installLoaderFiles(gameDir);
  if (!repair.ok) return repair;
  if (mode === 'client' && !address) return { ok: false, error: 'Escribe la IP de tu amigo.' };

  const savePort = (Number(port) || DEFAULT_PORT) + 1;
  if (mode === 'client') {
    // Copia la partida del anfitrión antes de entrar, sin preguntar. La local se guarda como copia de seguridad.
    try {
      const sync = await saves.syncFromHost(`http://${address.trim()}:${savePort}`, MSC_SAVE_DIR, savesBackupDir());
      if (!sync.synced) return { ok: false, error: sync.reason };
    } catch (e) {
      return { ok: false, error: `No se pudo copiar la partida del anfitrión (${e.message}). ¿Está abierto el juego del anfitrión con su launcher?` };
    }
  } else {
    ensureSaveServer(ip, savePort);
  }

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

  backupBeforeChange(gameDir);

  // Instala o actualiza el mod de cooperativo para que siempre coincida con la versión del launcher.
  const bundledMod = path.join(toolsDir(), 'MscCoop.dll');
  if (fs.existsSync(bundledMod)) {
    fs.copyFileSync(bundledMod, path.join(gameDir, 'Mods', 'MscCoop.dll'));
  }

  saveSettings({ gameDir, mode, address: address || '', port: config.Port, playerName: config.PlayerName });
  // Se borra el log anterior para que la comprobación solo mire esta ejecución.
  fs.rmSync(path.join(gameDir, 'output_log.txt'), { force: true });
  spawn(path.join(gameDir, 'mysummercar.exe'), [], { cwd: gameDir, detached: true, stdio: 'ignore' }).unref();
  watchGameLog(gameDir, _e.sender);
  return { ok: true, config };
});

// Auto-actualización: al arrancar busca una versión nueva en GitHub Releases, la descarga y la instala al cerrar.
// Notas de la release: texto plano, sin HTML, recortado para que quepa en el aviso.
const releaseNotesText = (notes) => {
  if (!notes) return '';
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 600);
};

let updateWindow = null;
function sendUpdate(state) {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send('update:state', state);
}

// Registro de actualizaciones: sirve para saber por qué no se aplicó una versión.
function updaterLog(text) {
  try {
    const file = path.join(app.getPath('userData'), 'updater.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch { /* el registro no debe romper el launcher */ }
}

function setupAutoUpdate(win) {
  if (!app.isPackaged) return;
  updateWindow = win;
  let pendingVersion = '';
  let pendingNotes = '';
  autoUpdater.autoDownload = true;
  // Si el usuario no pulsa «Instalar ahora», se aplica al cerrar el launcher.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => updaterLog(`info ${m}`), warn: (m) => updaterLog(`warn ${m}`), error: (m) => updaterLog(`error ${m}`), debug: () => {} };
  autoUpdater.on('checking-for-update', () => sendUpdate({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    pendingNotes = releaseNotesText(info.releaseNotes);
    updaterLog(`disponible ${info.version}`);
    sendUpdate({ phase: 'downloading', version: pendingVersion, notes: pendingNotes, percent: 0 });
  });
  autoUpdater.on('download-progress', (p) => sendUpdate({
    phase: 'downloading', version: pendingVersion, notes: pendingNotes, percent: Math.round(p.percent),
  }));
  autoUpdater.on('update-not-available', () => sendUpdate({ phase: 'none' }));
  autoUpdater.on('update-downloaded', (info) => {
    updaterLog(`descargada ${info.version}`);
    sendUpdate({ phase: 'ready', version: info.version, notes: releaseNotesText(info.releaseNotes) });
  });
  autoUpdater.on('error', (err) => {
    updaterLog(`error ${err && err.message ? err.message : err}`);
    sendUpdate({ phase: 'error' });
  });

  // Comprueba al arrancar, cada minuto y al volver a la ventana, para pillar versiones nuevas con la app abierta.
  // Es lo más rápido sin servidor propio: GitHub no avisa en tiempo real.
  const check = () => autoUpdater.checkForUpdates().catch((e) => updaterLog(`check ${e.message}`));
  check();
  setInterval(check, 60 * 1000);
  win.on('focus', check);
}

ipcMain.handle('update:check', () => autoUpdater.checkForUpdates().then(() => true).catch(() => false));
// Cierra el launcher y arranca la nueva versión.
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(false, true));

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
