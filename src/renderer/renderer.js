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

  ui.installLoader.hidden = !state.game || state.loader;
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
  if (state.game && state.loader) setStatus('Todo listo. Pulsa Jugar para empezar.', 'ok');
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
    setStatus('Escribe la IP de tu amigo.', 'bad');
    ui.address.focus();
    return;
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

// Estado de actualización: se muestra en la barra de estado sin tapar otros mensajes importantes.
if (window.launcher.onUpdateStatus) {
  window.launcher.onUpdateStatus(({ text, kind }) => setStatus(text, kind));
}

refresh();
