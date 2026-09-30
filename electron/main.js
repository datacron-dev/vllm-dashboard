'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { MetricsPoller } = require('./metrics');
const { LogTailer } = require('./logs');
const { ServerControl } = require('./server-control');
const { PRESETS, findPreset, matchPresetId } = require('./presets');
const { SystemMonitor } = require('./system-monitor');
const { Provenance } = require('./provenance');
const { loadProfiles, saveProfiles, findProfile, uniqueId, matchProfileId } = require('./profiles');

// ---------------------------------------------------------------------------
// Sandbox handling (same as before)
// ---------------------------------------------------------------------------
(function configureSandbox() {
  if (process.platform !== 'linux') return;
  const helpers = [
    path.join(path.dirname(process.execPath), 'chrome-sandbox'),
    '/usr/lib/electron/chrome-sandbox',
    '/usr/lib/chromium/chrome-sandbox',
  ];
  let helperOk = false;
  for (const p of helpers) {
    try {
      const st = fs.statSync(p);
      if (st.mode & 0o4000 && st.uid === 0) { helperOk = true; break; }
    } catch (_) { /* not present */ }
  }
  if (!helperOk) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
  }
})();

// ---------------------------------------------------------------------------
// GPU / rendering — call the function now instead of leaving body in IIFE.
// ---------------------------------------------------------------------------
(function configureRendering() {
  const wantGpu = process.env.VLLM_DASHBOARD_GPU === '1';
  const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  if (wantGpu) {
    app.commandLine.appendSwitch('enable-gpu');
  } else if (!hasDisplay) {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    app.commandLine.appendSwitch('use-gl', 'swiftshader');
  }
})();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_VLLM_COMMAND = PRESETS[0].command;

const SETTINGS = {
  vllmEndpoint: 'http://127.0.0.1:8000',
  pollIntervalMs: 2000,
  logSource: 'docker',
  dockerContainer: 'my-vllm',
  logFile: '/var/log/vllm.log',
  healthPollIntervalMs: 5000,
  vllmCommand: DEFAULT_VLLM_COMMAND,
};

let CONFIG_PATH = null;   // resolved inside app.whenReady() (see below)
let PROFILES_PATH = null; // same — resolves reliably after Electron appdata is initialised

let profiles = null;       // loaded inside app.whenReady() after CONFIG_PATH / PROFILES_PATH are set

let win = null;
let poller = null;
let tailer = null;
let control = null;
let sysMonitor = null;
let provenance = null;

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.vllmEndpoint === 'string') SETTINGS.vllmEndpoint = raw.vllmEndpoint || SETTINGS.vllmEndpoint;
      // Only restore the saved command if it still matches one of the current presets.
      // If presets have changed (e.g. a model preset was updated), fall back to the
      // default so the user sees the latest flags (like a corrected --gpu-memory-utilization).
      if (typeof raw.vllmCommand === 'string') {
        if (matchPresetId(raw.vllmCommand)) {
          SETTINGS.vllmCommand = raw.vllmCommand;
        }
        // else: keep the default (PRESSETS[0]) — the saved command is stale.
      }
      if (raw.logSource === 'docker' || raw.logSource === 'file') SETTINGS.logSource = raw.logSource;
      if (typeof raw.dockerContainer === 'string' && raw.dockerContainer) SETTINGS.dockerContainer = raw.dockerContainer;
      if (typeof raw.logFile === 'string' && raw.logFile) SETTINGS.logFile = raw.logFile;
      if (typeof raw.pollIntervalMs === 'number' && raw.pollIntervalMs >= 500) SETTINGS.pollIntervalMs = raw.pollIntervalMs;
    }
  } catch (_) { /* first run or corrupt file */ }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const payload = {
      vllmEndpoint: SETTINGS.vllmEndpoint,
      vllmCommand: SETTINGS.vllmCommand,
      logSource: SETTINGS.logSource,
      dockerContainer: SETTINGS.dockerContainer,
      logFile: SETTINGS.logFile,
      pollIntervalMs: SETTINGS.pollIntervalMs,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2));
    return { ok: true, path: CONFIG_PATH };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 960,
    minHeight: 640,
    title: 'vLLM Dashboard',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// Metrics
ipcMain.handle('metrics:configure', (_event, endpoint) => {
  if (typeof endpoint === 'string' && /^https?:\/\//.test(endpoint)) {
    SETTINGS.vllmEndpoint = endpoint;
  }
  saveConfig();
  startPolling();
  startProvenance();
  return { endpoint: SETTINGS.vllmEndpoint, intervalMs: SETTINGS.pollIntervalMs };
});

ipcMain.handle('metrics:getSettings', () => ({
  endpoint: SETTINGS.vllmEndpoint,
  intervalMs: SETTINGS.pollIntervalMs,
}));

// Log tailing
ipcMain.handle('logs:configure', (_event, opts) => {
  if (opts && typeof opts === 'object') {
    if (opts.logSource === 'docker' || opts.logSource === 'file') SETTINGS.logSource = opts.logSource;
    if (typeof opts.dockerContainer === 'string' && opts.dockerContainer) SETTINGS.dockerContainer = opts.dockerContainer;
    if (typeof opts.logFile === 'string' && opts.logFile) SETTINGS.logFile = opts.logFile;
  }
  saveConfig();
  restartLogTailing();
  return {
    logSource: SETTINGS.logSource,
    dockerContainer: SETTINGS.dockerContainer,
    logFile: SETTINGS.logFile,
  };
});

// Server control (start / stop / restart)
ipcMain.handle('server:start', () => {
  const guard = serverControlGuard('start');
  if (guard.locked) {
    control._emitState('locked');
    control.emit('output', { stream: 'status', text: guard.reason, at: Date.now() });
    return { ok: false, locked: true, reason: guard.reason };
  }
  control.start();
  return { ok: true };
});

ipcMain.handle('server:stop', () => {
  const guard = serverControlGuard('stop');
  if (guard.locked) {
    control._emitState('locked');
    control.emit('output', { stream: 'status', text: guard.reason, at: Date.now() });
    return { ok: false, locked: true, reason: guard.reason };
  }
  // M3 fix: also guard against internal busy.
  if (control.busy) {
    control._emitState('locked');
    control.emit('output', { stream: 'status', text: 'Please wait: a server action is in progress.', at: Date.now() });
    return { ok: false, locked: true, reason: 'busy' };
  }
  control.stop();
  return { ok: true };
});

ipcMain.handle('server:restart', () => {
  const guard = serverControlGuard('restart');
  if (guard.locked) {
    control._emitState('locked');
    control.emit('output', { stream: 'status', text: guard.reason, at: Date.now() });
    return { ok: false, locked: true, reason: guard.reason };
  }
  // M3 fix: also guard against internal busy.
  if (control.busy) {
    control._emitState('locked');
    control.emit('output', { stream: 'status', text: 'Please wait: a server action is in progress.', at: Date.now() });
    return { ok: false, locked: true, reason: 'busy' };
  }
  control.restart();
  return { ok: true };
});

// vLLM config
ipcMain.handle('config:get', () => ({
  vllmCommand: SETTINGS.vllmCommand,
  vllmEndpoint: SETTINGS.vllmEndpoint,
  logSource: SETTINGS.logSource,
  dockerContainer: SETTINGS.dockerContainer,
  logFile: SETTINGS.logFile,
  pollIntervalMs: SETTINGS.pollIntervalMs,
  activePresetId: matchPresetId(SETTINGS.vllmCommand),
  activeProfileId: matchProfileId(profiles, SETTINGS.vllmCommand),
}));

ipcMain.handle('config:save', (_event, patch) => {
  if (patch && typeof patch === 'object') {
    if (typeof patch.vllmEndpoint === 'string') SETTINGS.vllmEndpoint = patch.vllmEndpoint;
    if (typeof patch.vllmCommand === 'string' && patch.vllmCommand.trim()) SETTINGS.vllmCommand = patch.vllmCommand;
    if (patch.logSource === 'docker' || patch.logSource === 'file') SETTINGS.logSource = patch.logSource;
    if (typeof patch.dockerContainer === 'string' && patch.dockerContainer) SETTINGS.dockerContainer = patch.dockerContainer;
    if (typeof patch.logFile === 'string' && patch.logFile) SETTINGS.logFile = patch.logFile;
    if (typeof patch.pollIntervalMs === 'number' && patch.pollIntervalMs >= 500) SETTINGS.pollIntervalMs = patch.pollIntervalMs;
  }
  const result = saveConfig();
  startPolling();
  restartLogTailing();
  if (control) { control.settings = SETTINGS; }
  startProvenance();
  return result;
});

// Model presets
ipcMain.handle('presets:list', () =>
  PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description }))
);

ipcMain.handle('presets:match', (_event, command) => {
  // Match a command string against known presets.
  // Used during config load to restore the correct preset selection.
  return matchPresetId(command) || null;
});

ipcMain.handle('presets:select', (_event, presetId) => {
  const preset = findPreset(presetId);
  if (!preset) return { ok: false, error: `Unknown preset: ${presetId}` };
  SETTINGS.vllmCommand = preset.command;
  const result = saveConfig();
  if (result.ok) {
    result.activePresetId = preset.id;
    result.activeProfileId = null;
    if (control) { control.settings = SETTINGS; }
    startProvenance();
  }
  return result;
});

// Config profiles
ipcMain.handle('profiles:list', () => profiles);

ipcMain.handle('profiles:create', (_event, name) => {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'Profile name is required' };
  if (profiles.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())) {
    return { ok: false, error: `A profile named "${name.trim()}" already exists` };
  }
  const profile = {
    id: uniqueId(),
    name: name.trim(),
    command: SETTINGS.vllmCommand,
    createdAt: new Date().toISOString(),
  };
  profiles.push(profile);
  const saveResult = saveProfiles(profiles, PROFILES_PATH);
  if (saveResult.ok) return { ok: true, profile };
  return { ok: false, error: saveResult.error };
});

ipcMain.handle('profiles:select', (_event, profileId) => {
  const profile = findProfile(profiles, profileId);
  if (!profile) return { ok: false, error: `Unknown profile: ${profileId}` };
  SETTINGS.vllmCommand = profile.command;
  const result = saveConfig();
  if (result.ok) {
    result.activeProfileId = profileId;
    result.activePresetId = null;
    if (control) { control.settings = SETTINGS; }
    startProvenance();
  }
  return result;
});

ipcMain.handle('profiles:delete', (_event, profileId) => {
  const idx = profiles.findIndex((p) => p.id === profileId);
  if (idx === -1) return { ok: false, error: `Unknown profile: ${profileId}` };
  profiles.splice(idx, 1);
  const saveResult = saveProfiles(profiles, PROFILES_PATH);
  if (saveResult.ok) return { ok: true };
  return { ok: false, error: saveResult.error };
});

// Provenance / Monitor mode
ipcMain.handle('prov:get', () => provenance ? provenance.last || null : null);
ipcMain.handle('prov:detect', async () => {
  if (!provenance) startProvenance();
  return provenance.detect();
});

// System monitor
ipcMain.handle('sysmon:start', () => { startSystemMonitor(); return { ok: true }; });
ipcMain.handle('sysmon:stop', () => { stopSystemMonitor(); return { ok: true }; });

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------
function startPolling() {
  stopPolling();
  poller = new MetricsPoller({
    endpoint: SETTINGS.vllmEndpoint,
    intervalMs: SETTINGS.pollIntervalMs,
    healthIntervalMs: SETTINGS.healthPollIntervalMs,
  });
  poller.on('update', (snapshot) => {
    if (win && !win.isDestroyed()) win.webContents.send('metrics:update', snapshot);
  });
  poller.on('health', (health) => {
    if (win && !win.isDestroyed()) win.webContents.send('metrics:health', health);
  });
  poller.start();
}

function stopPolling() {
  if (poller) { poller.stop(); poller = null; }
}

function restartLogTailing() {
  if (tailer) {
    tailer.stop();
    tailer.removeAllListeners();
    tailer = null;
  }
  tailer = new LogTailer(SETTINGS);
  tailer.on('line', (entry) => {
    if (win && !win.isDestroyed()) win.webContents.send('logs:line', entry);
  });
  tailer.on('status', (status) => {
    if (win && !win.isDestroyed()) win.webContents.send('logs:status', status);
  });
  tailer.start();
}

function startControl() {
  if (control) control.removeAllListeners();
  control = new ServerControl({ settings: SETTINGS, configPath: CONFIG_PATH });
  if (provenance) control.setProvenance(provenance);
  control.on('output', (entry) => {
    if (win && !win.isDestroyed()) win.webContents.send('server:output', entry);
  });
  control.on('state', (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('server:state', state);
  });
}

function startSystemMonitor() {
  stopSystemMonitor();
  sysMonitor = new SystemMonitor({ intervalMs: 3000 });
  sysMonitor.on('update', (snapshot) => {
    if (win && !win.isDestroyed()) win.webContents.send('sysmon:update', snapshot);
  });
  sysMonitor.start();
}

function stopSystemMonitor() {
  if (sysMonitor) { sysMonitor.stop(); sysMonitor.removeAllListeners(); sysMonitor = null; }
}

function containerNameFromCommand(command) {
  const m = String(command || '').match(/--name[= ]([^\s"']+)/);
  return (m && m[1]) || SETTINGS.dockerContainer || 'my-vllm';
}

function startProvenance() {
  stopProvenance();
  provenance = new Provenance({
    endpoint: SETTINGS.vllmEndpoint,
    containerName: containerNameFromCommand(SETTINGS.vllmCommand),
    intervalMs: SETTINGS.healthPollIntervalMs,
  });
  if (control) control.setProvenance(provenance);
  provenance.on('update', (snapshot) => {
    if (win && !win.isDestroyed()) win.webContents.send('prov:update', snapshot);
  });
  provenance.start().catch(() => {});
}

function stopProvenance() {
  if (provenance) { provenance.stop(); provenance.removeAllListeners(); provenance = null; }
}

function serverControlGuard(action) {
  const snapshot = provenance ? provenance.last : null;
  if (!snapshot || snapshot.state !== 'external') {
    return { locked: false };
  }
  const port = snapshot.endpoint ? String(snapshot.endpoint).split(':').pop() : 'the endpoint';
  const kindLabel = snapshot.kind || 'external';
  const modelLabel = snapshot.model ? ` · ${snapshot.model}` : '';
  return {
    locked: true,
    reason: `Locked: external ${kindLabel} server owns :${port}${modelLabel}. Stop it before using ${action}.`,
  };
}

// ---------------------------------------------------------------------------
// Application lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Resolve config / profile paths *after* Electron's appdata dir is stable.
  // For AppImages this is critical: app.getPath('userData') may resolve to the
  // ephemeral mount point when called at module-load time, but resolves to the
  // user's real config dir once the app is ready.
  CONFIG_PATH = path.join(app.getPath('userData'), 'vllm-dashboard-config.json');
  PROFILES_PATH = path.join(app.getPath('userData'), 'vllm-dashboard-profiles.json');

  profiles = loadProfiles(PROFILES_PATH);
  loadConfig();
  createWindow();
  startPolling();
  startProvenance();
  startControl();
  startSystemMonitor();
  restartLogTailing();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  stopPolling();
  stopProvenance();
  if (tailer) tailer.stop();
  stopSystemMonitor();
  // Do NOT stop the vLLM container on app exit.
});
