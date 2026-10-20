// Compartir la partida guardada del anfitrión con los invitados, sin depender de Electron (se puede probar con Node).
// El anfitrión sirve sus archivos de partida en solo lectura. El invitado los descarga y verifica por hash.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const BACKUPS_TO_KEEP = 5;

// Solo archivos sueltos de la carpeta de partidas: nada de subcarpetas ni rutas.
function listSaveFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function manifest(dir) {
  return listSaveFiles(dir).map((name) => {
    const full = path.join(dir, name);
    return { name, size: fs.statSync(full).size, sha256: sha256File(full) };
  });
}

// Servidor del anfitrión: /manifest (lista con hashes) y /file/<nombre> (contenido).
function startSaveServer(dir, port, host) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    if (req.url === '/manifest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(manifest(dir)));
    }
    const m = /^\/file\/(.+)$/.exec(req.url || '');
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (!listSaveFiles(dir).includes(name)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return fs.createReadStream(path.join(dir, name)).pipe(res);
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', () => { /* el launcher lo muestra al intentar jugar */ });
  server.listen(port, host);
  return server;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tiempo agotado')));
    req.on('error', reject);
  });
}

function getFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('tiempo agotado')));
    req.on('error', reject);
  });
}

function pruneBackups(backupRoot) {
  try {
    const dirs = fs.readdirSync(backupRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const old of dirs.slice(0, Math.max(0, dirs.length - BACKUPS_TO_KEEP))) {
      fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true });
    }
  } catch { /* sin copias previas */ }
}

// Descarga la partida del anfitrión si es distinta a la local. Antes guarda una copia de la local.
// Devuelve { synced, changed, reason }.
async function syncFromHost(baseUrl, dir, backupRoot) {
  const remote = await getJson(`${baseUrl}/manifest`);
  if (!remote.length) return { synced: false, reason: 'El anfitrión todavía no tiene partida guardada. Que guarde en el juego y vuelva a intentarlo.' };

  fs.mkdirSync(dir, { recursive: true });
  const localFiles = manifest(dir);
  const local = Object.fromEntries(localFiles.map((f) => [f.name, f.sha256]));
  const changed = remote.filter((f) => local[f.name] !== f.sha256);
  if (!changed.length) return { synced: true, changed: 0 };

  if (localFiles.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bdir = path.join(backupRoot, stamp);
    fs.mkdirSync(bdir, { recursive: true });
    for (const f of localFiles) fs.copyFileSync(path.join(dir, f.name), path.join(bdir, f.name));
    pruneBackups(backupRoot);
  }

  for (const f of changed) {
    await getFile(`${baseUrl}/file/${encodeURIComponent(f.name)}`, path.join(dir, f.name));
  }
  for (const f of remote) {
    if (sha256File(path.join(dir, f.name)) !== f.sha256) throw new Error(`Verificación fallida en ${f.name}`);
  }
  return { synced: true, changed: changed.length };
}

module.exports = { startSaveServer, syncFromHost, manifest };
