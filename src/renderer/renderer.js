const $ = (id) => document.getElementById(id);

const ui = {
  version: $('version'),
  readyBadge: $('readyBadge'),
  readyText: $('readyText'),
  navItems: document.querySelectorAll('.nav-item'),
  views: document.querySelectorAll('.view'),
  gameDir: $('gameDir'),
  browse: $('browse'),
  autoDetect: $('autoDetect'),
  openMods: $('openMods'),
  recheck: $('recheck'),
  chipGame: $('chipGame'),
  chipLoader: $('chipLoader'),
  chipTailscale: $('chipTailscale'),
  installLoader: $('installLoader'),
  openTailscale: $('openTailscale'),
  modeHost: $('modeHost'),
  modeJoin: $('modeJoin'),
  hostPanel: $('hostPanel'),
  joinPanel: $('joinPanel'),
  ip: $('ip'),
  copyIp: $('copyIp'),
  address: $('address'),
  port: $('port'),
  playerName: $('playerName'),
  play: $('play'),
  status: $('status'),
  restoreBackup: $('restoreBackup'),
  tsKeyCard: $('tsKeyCard'),
  tsKey: $('tsKey'),
  tsConnect: $('tsConnect'),
  tsKeysLink: $('tsKeysLink'),
  firewallNotice: $('firewallNotice'),
  openFirewallBtn: $('openFirewallBtn'),
  chipFirewall: $('chipFirewall'),
  openFirewall: $('openFirewall'),
};

let state = { game: false, loader: false, tailscale: false, tailscaleIp: '', firewall: false };

// ---------- Navegación ----------

function showView(name) {
  ui.navItems.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  ui.views.forEach((v) => { v.hidden = v.id !== 'view-' + name; });
}

ui.navItems.forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- Mensajes ----------

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = 'status ' + kind;
}

function chip(el, ok, okText, badText) {
  el.textContent = ok ? okText : badText;
  el.className = 'chip ' + (ok ? 'ok' : 'bad');
}

function mode() {
  return ui.modeHost.checked ? 'host' : 'client';
}

// ---------- Render ----------

function render() {
  chip(ui.chipGame, state.game, 'Encontrado', 'No encontrado');
  chip(ui.chipLoader, state.loader, 'Instalado', state.game ? 'No instalado' : 'Pendiente');
  chip(ui.chipTailscale, state.tailscale, 'Instalado', 'No instalado');
  chip(ui.chipFirewall, state.firewall, 'Abierto', 'Cerrado');

  ui.installLoader.hidden = !state.game;
  ui.installLoader.textContent = state.loader ? 'Reparar MSCLoader' : 'Instalar';
  ui.openTailscale.hidden = state.tailscale;
  ui.openFirewall.hidden = state.firewall;
  ui.tsKeyCard.hidden = !state.tailscale || !!state.tailscaleIp;
  ui.firewallNotice.hidden = mode() !== 'host' || state.firewall;

  ui.hostPanel.hidden = mode() !== 'host';
  ui.joinPanel.hidden = mode() !== 'client';

  ui.ip.textContent = state.tailscaleIp || 'Tailscale no está conectado';
  ui.copyIp.disabled = !state.tailscaleIp;

  const ready = state.game && state.loader;
  ui.play.disabled = !ready;
  ui.readyBadge.className = 'ready ' + (ready ? 'ok' : 'bad');
  ui.readyText.textContent = ready ? 'Listo para jugar' : 'Falta configurar';
}

function applyGameDir(dir) {
  ui.gameDir.value = dir || '';
}

async function refresh(gameDir) {
  const s = await window.launcher.getState(gameDir);
  state = { game: s.game, loader: s.loader, tailscale: s.tailscale, tailscaleIp: s.tailscaleIp, firewall: s.firewall };
  ui.version.textContent = 'Versión ' + s.version;
  applyGameDir(s.settings.gameDir);
  (s.settings.mode === 'client' ? ui.modeJoin : ui.modeHost).checked = true;
  ui.address.value = s.settings.address || '';
  ui.port.value = s.settings.port || 25565;
  ui.playerName.value = s.settings.playerName || '';
  render();
  refreshTailscaleStatus();
  refreshRequirements();
  if (state.game && state.loader && !s.build) setStatus('Tu juego no es la versión probada (build 20171487). El mod puede fallar.', 'bad');
  else if (state.game && state.loader) setStatus('Todo listo. Pulsa Jugar para empezar.', 'ok');
  else if (state.game) setStatus('Falta instalar MSCLoader. Ve a Estado.', 'bad');
  else setStatus('No encuentro My Summer Car. Ve a Configuración para indicar la carpeta.', 'bad');
}

// ---------- Acciones ----------

async function pickGame() {
  const dir = await window.launcher.pickGameDir();
  if (!dir) return;
  applyGameDir(dir);
  await refresh(dir);
}

async function autoDetect() {
  setStatus('Buscando My Summer Car…');
  const dir = await window.launcher.autoDetect();
  if (dir) {
    applyGameDir(dir);
    await refresh(dir);
  } else {
    setStatus('No lo encontré. Indica la carpeta manualmente.', 'bad');
  }
}

async function play() {
  const payload = {
    gameDir: ui.gameDir.value.trim(),
    mode: mode(),
    address: ui.address.value.trim(),
    port: Number(ui.port.value) || 25565,
    playerName: ui.playerName.value.trim(),
    tailscaleIp: state.tailscaleIp,
  };
  if (payload.mode === 'client' && !payload.address) {
    setStatus('Elige a tu amigo de la lista o escribe su IP.', 'bad');
    ui.address.focus();
    return;
  }
  // Comprobaciones antes de unirse: Tailscale conectado y el anfitrión respondiendo.
  if (payload.mode === 'client') {
    if (!state.tailscaleIp) {
      setStatus('Para unirte necesitas Tailscale conectado. Ve a Estado y pega tu clave de invitación.', 'bad');
      return;
    }
    setStatus('Comprobando que el anfitrión responde…');
    const ping = await window.launcher.tailscalePing(payload.address);
    if (!ping.ok) {
      const go = window.confirm(`${ping.detail}\n\n¿Jugar igualmente? (Si tu amigo aún no ha creado la partida, no podrás entrar.)`);
      if (!go) {
        setStatus('Cancelado. Pide a tu amigo que cree la partida y vuelve a probar.', 'bad');
        return;
      }
    }
  }
  const res = await window.launcher.launch(payload);
  if (!res.ok) {
    setStatus(res.error, 'bad');
    return;
  }
  setStatus(
    payload.mode === 'host'
      ? `Juego iniciado como anfitrión. Dile a tu amigo: ${res.config.Address}:${res.config.Port}`
      : `Juego iniciado. Conectando a ${res.config.Address}:${res.config.Port}`,
    'ok'
  );
}

ui.browse.addEventListener('click', pickGame);
ui.autoDetect.addEventListener('click', autoDetect);
ui.openMods.addEventListener('click', () => window.launcher.openModsFolder());
ui.recheck.addEventListener('click', () => refresh(ui.gameDir.value.trim()));
ui.installLoader.addEventListener('click', async () => {
  const res = await window.launcher.installLoader(ui.gameDir.value.trim());
  if (res.ok) {
    await refresh(ui.gameDir.value.trim());
  } else {
    setStatus(res.error, 'bad');
  }
});
ui.tsConnect.addEventListener('click', async () => {
  ui.tsConnect.disabled = true;
  setStatus('Conectando a Tailscale…');
  const res = await window.launcher.loginTailscale(ui.tsKey.value);
  ui.tsConnect.disabled = false;
  if (res.ok) {
    ui.tsKey.value = '';
    setStatus(`Conectado a Tailscale (${res.ip}).`, 'ok');
    await refresh(ui.gameDir.value.trim());
  } else {
    setStatus(res.error, 'bad');
  }
});
ui.tsKeysLink.addEventListener('click', () => window.launcher.openTailscaleKeys());

// Rellena el desplegable de amigos en línea. Elegir uno pone su IP en el campo de dirección.
function fillPeerSelect(online) {
  const sel = $('peerSelect');
  const current = ui.address.value.trim();
  sel.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = online.length ? '— elige un amigo —' : 'Nadie en línea ahora';
  sel.appendChild(empty);
  for (const p of online) {
    if (!p.ip) continue;
    const opt = document.createElement('option');
    opt.value = p.ip;
    opt.textContent = `${p.name} (${p.ip})`;
    if (p.ip === current) opt.selected = true;
    sel.appendChild(opt);
  }
}
$('peerSelect').addEventListener('change', (e) => {
  if (e.target.value) ui.address.value = e.target.value;
});

// Estado de Tailscale: conectado o no, tu IP, la red y los compañeros en línea.
async function refreshTailscaleStatus() {
  const s = await window.launcher.tailscaleStatus();
  const state = $('tsState');
  const info = $('tsInfo');
  const peers = $('tsPeers');
  peers.innerHTML = '';
  if (!s.installed) {
    chip(state, false, '', 'No instalado');
    info.textContent = 'Instala Tailscale para jugar a distancia.';
    return;
  }
  if (!s.running) {
    chip(state, false, '', 'No conectado');
    info.textContent = s.error || 'Pega una clave de invitación para conectarte.';
    return;
  }
  chip(state, true, 'Conectado', '');
  const online = s.peers.filter((p) => p.online);
  info.textContent = `Tu IP: ${s.ip || '—'} · Red: ${s.tailnet || '—'} · En línea: ${online.length}`;
  fillPeerSelect(online);
  for (const p of online.slice(0, 10)) {
    const li = document.createElement('li');
    li.innerHTML = '';
    const name = document.createElement('span');
    name.textContent = `${p.name} (${p.ip})`;
    const badge = document.createElement('span');
    badge.className = 'chip ok';
    badge.textContent = 'En línea';
    li.append(name, badge);
    peers.appendChild(li);
  }
}

$('tsRefresh').addEventListener('click', refreshTailscaleStatus);
$('tsPing').addEventListener('click', async () => {
  const result = $('tsPingResult');
  result.textContent = 'Probando…';
  const res = await window.launcher.tailscalePing(ui.address.value.trim());
  const host = ui.address.value.trim();
  result.textContent = res.ok
    ? `El anfitrión ${host} responde. ${res.detail} Ya puedes unirte.`
    : (res.error || `El anfitrión ${host} no responde. ${res.detail || ''}`.trim());
});

// Lista de requisitos con botón para arreglar cada uno cuando se puede.
async function refreshRequirements() {
  const items = await window.launcher.checkRequirements(ui.gameDir.value.trim());
  const list = $('reqList');
  list.innerHTML = '';
  const missing = items.filter((i) => i.needed && !i.ok);
  $('reqSummary').textContent = missing.length
    ? `Faltan ${missing.length} requisito(s) para jugar: ${missing.map((i) => i.label).join(', ')}.`
    : 'Todo lo necesario para jugar está listo.';
  // Botón de arreglo en la vista de Jugar para el primer requisito que falte.
  const first = missing.find((i) => i.fix);
  if (first) showPlayFix(FIX_LABELS[first.fix] || 'Arreglar', first.fix);
  else hidePlayFix();
  for (const it of items) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'check-info';
    const name = document.createElement('div');
    name.className = 'check-name';
    name.textContent = it.needed ? it.label : `${it.label} (opcional)`;
    const desc = document.createElement('div');
    desc.className = 'check-desc';
    desc.textContent = it.detail;
    info.append(name, desc);
    const chipEl = document.createElement('span');
    chip(chipEl, it.ok, 'Correcto', it.needed ? 'Falta' : 'No');
    li.append(info, chipEl);
    if (!it.ok && it.fix) {
      const btn = document.createElement('button');
      btn.className = 'ghost small';
      btn.textContent = { loader: 'Instalar', tailscale: 'Instalar', firewall: 'Abrir puerto', tskey: 'Conectar', choose: 'Elegir' }[it.fix];
      btn.addEventListener('click', () => fixRequirement(it.fix));
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

const FIX_LABELS = {
  choose: 'Elegir carpeta del juego',
  loader: 'Instalar o reparar MSCLoader',
  tailscale: 'Instalar Tailscale',
  tskey: 'Conectar Tailscale',
  firewall: 'Abrir puerto en el firewall',
};
let playFixKind = '';
function showPlayFix(label, kind) {
  playFixKind = kind;
  const btn = $('playFix');
  btn.textContent = label;
  btn.hidden = false;
}
function hidePlayFix() {
  playFixKind = '';
  $('playFix').hidden = true;
}
$('playFix').addEventListener('click', () => fixRequirement(playFixKind));

// Acción de cada requisito: lleva a la acción correspondiente.
async function fixRequirement(kind) {
  if (kind === 'choose') return pickGame();
  if (kind === 'loader') return ui.installLoader.click();
  if (kind === 'tailscale') return ui.openTailscale.click();
  if (kind === 'firewall') return openFirewall();
  if (kind === 'tskey') {
    ui.tsKey.focus();
    return ui.tsKeyCard.scrollIntoView({ behavior: 'smooth' });
  }
}

let lastReport = '';
ui.runDiag = $('runDiag');
ui.showDiag = $('showDiag');
ui.runDiag.addEventListener('click', async () => {
  ui.runDiag.disabled = true;
  setStatus('Generando diagnóstico…');
  const res = await window.launcher.runDiagnostics(ui.gameDir.value.trim());
  ui.runDiag.disabled = false;
  if (res.ok) {
    lastReport = res.path;
    ui.showDiag.hidden = false;
    setStatus(`Diagnóstico guardado: ${res.path}`, 'ok');
  } else {
    setStatus(res.error, 'bad');
  }
});
ui.showDiag.addEventListener('click', () => window.launcher.showReport(lastReport));

ui.restoreBackup.addEventListener('click', async () => {
  const dir = ui.gameDir.value.trim();
  if (!window.confirm('Se devolverán los archivos originales del juego y se quitará MSCLoader y el mod. ¿Continuar?')) return;
  const res = await window.launcher.restoreBackup(dir);
  if (res.ok) {
    setStatus('Copia restaurada. El juego vuelve a estar como antes del launcher.', 'ok');
    await refresh(dir);
  } else {
    setStatus(res.error, 'bad');
  }
});

// Tras instalar Tailscale, esperamos a que aparezca solo y refrescamos el estado.
function waitForTailscale() {
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    const s = await window.launcher.getState(ui.gameDir.value.trim());
    if (s.tailscale || tries > 200) {
      clearInterval(timer);
      await refresh(ui.gameDir.value.trim());
    }
  }, 3000);
}

async function openFirewall() {
  setStatus('Pidiendo permiso de administrador para abrir el puerto…');
  const port = Number(ui.port.value) || 25565;
  const res = await window.launcher.openFirewall(port);
  if (res.ok) {
    setStatus(`Puerto ${port} abierto en el firewall.`, 'ok');
    await refresh(ui.gameDir.value.trim());
  } else {
    setStatus(res.error, 'bad');
  }
}

ui.openFirewall.addEventListener('click', openFirewall);
ui.openFirewallBtn.addEventListener('click', openFirewall);

ui.openTailscale.addEventListener('click', async () => {
  ui.openTailscale.disabled = true;
  setStatus('Descargando Tailscale…');
  const res = await window.launcher.installTailscale();
  ui.openTailscale.disabled = false;
  if (res.ok) {
    setStatus('Instalador de Tailscale abierto. Cuando termine, el launcher lo detectará solo.', 'ok');
    waitForTailscale();
  } else {
    setStatus(res.error, 'bad');
    if (res.error.startsWith('No se pudo descargar')) window.launcher.openTailscale();
  }
});
ui.copyIp.addEventListener('click', async () => {
  await window.launcher.copyText(state.tailscaleIp);
  setStatus(`IP copiada: ${state.tailscaleIp}`, 'ok');
});
ui.modeHost.addEventListener('change', render);
ui.modeJoin.addEventListener('change', render);
ui.play.addEventListener('click', play);
ui.gameDir.addEventListener('change', () => refresh(ui.gameDir.value.trim()));

// Aviso de actualización: versión nueva, cambios y botón para instalarla.
const banner = $('updateBanner');
const updateTitle = $('updateTitle');
const updateNotes = $('updateNotes');
const updateInstall = $('updateInstall');
const updateLater = $('updateLater');
let dismissedVersion = '';
window.launcher.onUpdateState((s) => {
  const show = (s.phase === 'downloading' || s.phase === 'ready') && s.version !== dismissedVersion;
  banner.hidden = !show;
  updateInstall.hidden = s.phase !== 'ready';
  updateLater.hidden = s.phase !== 'ready';
  if (s.phase === 'downloading') {
    const pct = typeof s.percent === 'number' ? ` ${s.percent}%` : '';
    updateTitle.textContent = `Nueva actualización ${s.version}: descargando…${pct}`;
    updateNotes.textContent = s.notes || '';
  } else if (s.phase === 'ready') {
    updateTitle.textContent = `Nueva actualización ${s.version} lista`;
    updateNotes.textContent = s.notes || 'Se instalará al cerrar el launcher, o ahora si pulsas «Instalar ahora».';
  }
});
updateInstall.addEventListener('click', () => window.launcher.installUpdate());
// «Más tarde» oculta el aviso de esta versión; la actualización sigue aplicándose al cerrar.
updateLater.addEventListener('click', () => {
  dismissedVersion = updateTitle.textContent.match(/\d+\.\d+\.\d+/)?.[0] || '';
  banner.hidden = true;
});
if (window.launcher.onGameStatus) {
  window.launcher.onGameStatus(({ text, kind }) => {
    setStatus(text, kind);
    // Si el mod o MSCLoader fallan al arrancar, ofrecemos reparar sin tener que buscarlo.
    if (kind === 'bad' && /MSCLoader|mod/.test(text)) showPlayFix(FIX_LABELS.loader, 'loader');
    if (kind === 'ok') hidePlayFix();
  });
}

refresh();
