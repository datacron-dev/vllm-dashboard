'use strict';

// Preload: exposes a minimal, promise-based API to the renderer.
// No Node integration in the renderer; everything goes through these channels.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('vllm', {
  // Metrics
  configureMetrics: (endpoint) => ipcRenderer.invoke('metrics:configure', endpoint),
  getMetricsSettings: () => ipcRenderer.invoke('metrics:getSettings'),
  onMetricsUpdate: (cb) => subscribe('metrics:update', cb),
  onHealth: (cb) => subscribe('metrics:health', cb),

  // Logs
  configureLogs: (opts) => ipcRenderer.invoke('logs:configure', opts),
  onLogLine: (cb) => subscribe('logs:line', cb),
  onLogStatus: (cb) => subscribe('logs:status', cb),

  // Server control (start / stop / restart)
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  restartServer: () => ipcRenderer.invoke('server:restart'),
  onServerOutput: (cb) => subscribe('server:output', cb),
  onServerState: (cb) => subscribe('server:state', cb),

  // vLLM config (launch command + endpoint + log source)
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  // Model presets
  listPresets: () => ipcRenderer.invoke('presets:list'),
  selectPreset: (presetId) => ipcRenderer.invoke('presets:select', presetId),
  matchPreset: (command) => ipcRenderer.invoke('presets:match', command),

  // Config profiles (custom command profiles)
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  selectProfile: (profileId) => ipcRenderer.invoke('profiles:select', profileId),
  deleteProfile: (profileId) => ipcRenderer.invoke('profiles:delete', profileId),

  // System monitor (GPU + system telemetry)
  startSystemMonitor: () => ipcRenderer.invoke('sysmon:start'),
  stopSystemMonitor: () => ipcRenderer.invoke('sysmon:stop'),
  onSystemMonitorUpdate: (cb) => subscribe('sysmon:update', cb),

  // Provenance / Monitor mode
  getProvenance: () => ipcRenderer.invoke('prov:get'),
  detectServer: () => ipcRenderer.invoke('prov:detect'),
  onProvenanceUpdate: (cb) => subscribe('prov:update', cb),

  // App info
  versions: () => {
    // Load version from .version file if present
    let appVersion = '';
    try {
      appVersion = require('fs').readFileSync(
        require('path').join(__dirname, '..', '.version'),
        'utf8'
      ).trim();
    } catch (_) { /* not present */ }
    return {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      app: appVersion,
      commit: process.env.PROVENANCE_COMMIT || '',
    };
  },
});
