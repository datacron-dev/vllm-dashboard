'use strict';

/* =========================================================================
   vLLM Dashboard — renderer entry point (vanilla JS, no framework)
   Subscribes to IPC events from the main process and updates panels.
   ========================================================================= */

const MAX_LOG_LINES = 500;
const BOOTING_STATUS = 'loading'; // status text that triggers the boot indicator
const VLLM_NA_MESSAGE = 'n/a — no vLLM server detected';
const VLLM_NA_META = 'unsupported by this server';
const PROV_LABELS = {
  ours: 'Ours',
  external: 'External',
  none: 'No server',
};
const PROV_KIND_LABELS = {
  vllm: 'vLLM',
  unknown: 'unknown',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

function setText(sel, value) {
  const el = $(sel);
  if (el) el.textContent = value;
}

function formatTokS(v) {
  if (v == null || Number.isNaN(v)) return '--';
  if (v >= 1000) return (v / 1000).toFixed(2) + 'k';
  return Math.round(v).toString();
}

function formatPct(v) {
  if (v == null || Number.isNaN(v)) return '--';
  return v.toFixed(1) + '%';
}

function formatTTFT(v) {
  if (v == null || Number.isNaN(v)) return '--';
  if (v >= 1000) return (v / 1000).toFixed(2) + 's';
  return Math.round(v).toString();
}

function formatITL(v) {
  if (v == null || Number.isNaN(v)) return '--';
  if (v >= 1000) return (v / 1000).toFixed(2) + 's';
  return Math.round(v).toString();
}

function formatTime(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

// ---------------------------------------------------------------------------
// SparklineHistory — deque per metric, feeds SVG sparkline paths
// ---------------------------------------------------------------------------
const SPARK_MAX = 60; // keep last N data points (at 2s poll = 2 min history)

function makeSparkHistory() {
  return { values: [], push(v) { this.values.push(v); if (this.values.length > SPARK_MAX) this.values.shift(); } };
}

function sparklineRender(svgEl, values, maxVal) {
  if (!svgEl) return;
  const linePath = svgEl.querySelector('.sparkline-line');
  const areaPath = svgEl.querySelector('.sparkline-area');
  if (!linePath || !areaPath) return;
  if (values.length < 2) {
    linePath.setAttribute('d', '');
    areaPath.setAttribute('d', '');
    return;
  }
  const top = maxVal != null && maxVal > 0 ? Math.max(maxVal, ...values.filter(v => v != null)) : Math.max(1e-9, ...values.filter(v => v != null && !Number.isNaN(v)));
  const len = values.length;
  const pts = values.map((v, i) => {
    const x = (i / (len - 1)) * 100;
    const safe = v == null || Number.isNaN(v) ? 0 : v;
    const y = 20 - (safe / top) * 18; // leave 2px margin top/bottom
    return [x, Math.max(0, Math.min(20, y))];
  });
  const lineD = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const areaD = lineD + `L100,20L0,20Z`;
  linePath.setAttribute('d', lineD);
  areaPath.setAttribute('d', areaD);
}

const sparkHistories = {
  'prompt-tok-s': makeSparkHistory(),
  'gen-tok-s': makeSparkHistory(),
  'ttft': makeSparkHistory(),
  'itl': makeSparkHistory(),
};

// ---------------------------------------------------------------------------
// Health panel
// ---------------------------------------------------------------------------
const health = {
  na: false,
  update(snapshot) {
    if (this.na) {
      setText('#kv-value', 'n/a');
      setText('#req-running', 'n/a');
      setText('#req-waiting', 'n/a');
      setText('#server-uptime-poll', 'n/a');
      setText('#health-meta', VLLM_NA_META);
      const bar = $('#kv-bar');
      if (bar) bar.style.width = '0%';
      return;
    }
    const kvPct = snapshot.kvCachePct;
    setText('#kv-value', kvPct == null ? '--' : formatPct(kvPct));
    const bar = $('#kv-bar');
    if (bar && kvPct != null) {
      bar.style.width = Math.min(100, Math.max(0, kvPct)) + '%';
      bar.classList.toggle('bar__fill--warn', kvPct > 70 && kvPct <= 90);
      bar.classList.toggle('bar__fill--full', kvPct > 90);
    }
    setText('#req-running', snapshot.numRunning == null ? '--' : snapshot.numRunning);
    setText('#req-waiting', snapshot.numWaiting == null ? '--' : snapshot.numWaiting);
    setText('#server-uptime-poll', snapshot.ok ? formatDuration(snapshot.uptime) : `error: ${snapshot.error}`);
    setText('#health-meta', snapshot.ok ? 'live' : 'stale');
  },
  health(healthInfo) {
    const badge = $('#health-badge');
    if (!badge) return;
    badge.classList.remove('badge--running', 'badge--stopped', 'badge--neutral');
    if (healthInfo.status === 'running') {
      badge.classList.add('badge--running');
      badge.querySelector('.badge__label').textContent = healthInfo.detail || 'Running';
    } else {
      badge.classList.add('badge--stopped');
      badge.querySelector('.badge__label').textContent = healthInfo.detail ? `Stopped · ${healthInfo.detail}` : 'Stopped';
    }
  },
};

// ---------------------------------------------------------------------------
// Throughput panel
// ---------------------------------------------------------------------------
const throughput = {
  na: false,
  update(snapshot) {
    if (this.na) {
      setText('#prompt-tok-s', 'n/a');
      setText('#gen-tok-s', 'n/a');
      setText('#ttft', 'n/a');
      setText('#itl', 'n/a');
      setText('#throughput-meta', VLLM_NA_META);
      return;
    }
    const promptTokS = snapshot.promptTokS;
    const genTokS = snapshot.genTokS;
    const ttftMs = snapshot.ttftMs;
    const itlMs = snapshot.itlMs;
    setText('#prompt-tok-s', formatTokS(promptTokS));
    setText('#gen-tok-s', formatTokS(genTokS));
    setText('#ttft', formatTTFT(ttftMs));
    setText('#itl', formatITL(itlMs));
    setText('#throughput-meta',
      snapshot.promptTokensTotal != null
        ? `${(snapshot.promptTokensTotal || 0).toLocaleString()} + ${(snapshot.genTokensTotal || 0).toLocaleString()} total`
        : '—');

    // Push to sparkline histories
    const pSpark = sparkHistories['prompt-tok-s'];
    const gSpark = sparkHistories['gen-tok-s'];
    const tSpark = sparkHistories['ttft'];
    const iSpark = sparkHistories['itl'];
    if (pSpark) pSpark.push(promptTokS);
    if (gSpark) gSpark.push(genTokS);
    if (tSpark) tSpark.push(ttftMs);
    if (iSpark) iSpark.push(itlMs);
    sparklineRender($('#spark-prompt-tok-s'), pSpark ? pSpark.values : [], 1000);
    sparklineRender($('#spark-gen-tok-s'), gSpark ? gSpark.values : [], 1000);
    sparklineRender($('#spark-ttft'), tSpark ? tSpark.values : [], 5000);
    sparklineRender($('#spark-itl'), iSpark ? iSpark.values : [], 500);
  },
};

// ---------------------------------------------------------------------------
// Context Fill panel — 270° donut, values inside the arc
// ---------------------------------------------------------------------------
const contextFill = {
  total: 0,
  filled: 0,
  update(data) {
    if (data == null || data.prefixCacheMaxTokens == null) {
      this.total = 0;
      this.filled = 0;
      this._render(0);
      return;
    }
    this.filled = data.prefixCacheTokensUsed || 0;
    this.total = data.prefixCacheMaxTokens;
    const pct = this.total > 0 ? (this.filled / this.total) * 100 : 0;
    this._render(pct);
  },
  _render(pct) {
    const valEl = $('#context-fill-value');
    const arc   = $('#context-fill-arc');
    if (!arc) return;

    const circumference = 2 * Math.PI * 46; // ≈ 289.03
    const arcLength     = circumference * 0.75; // 270° = 216.77

    if (valEl) {
      const pctText = (pct >= 100 ? '100' : pct.toFixed(0)) + '%';
      valEl.innerHTML = `<span class="context-fill__donut-pct">${pctText}</span>` +
        (this.total > 0 ? `<br><span class="context-fill__donut-sub">${this._short(this.filled)} / ${this._short(this.total)}</span>` : '');
    }
    const offset = arcLength - (pct / 100) * arcLength;
    arc.setAttribute('stroke-dashoffset', String(offset));

    // Status dot: green when there is data, dim when empty
    const statusDot = document.querySelector('.context-fill__status-dot');
    if (statusDot) {
      if (pct > 0 || this.filled > 0) {
        statusDot.style.background = 'var(--accent)';
        statusDot.style.boxShadow = '0 0 4px var(--accent)';
      } else {
        statusDot.style.background = 'var(--text-faint)';
        statusDot.style.boxShadow = 'none';
      }
    }
  },
  _short(n) {
    if (n == null) return '--';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return String(n);
  },
};

// ---------------------------------------------------------------------------
// Prefix cache panel
// ---------------------------------------------------------------------------
const prefixCache = {
  na: false,
  update(snapshot) {
    if (this.na) {
      const el = $('#hit-rate');
      if (el) {
        el.textContent = 'n/a';
        el.classList.remove('bigstat__value--warn', 'bigstat__value--error');
      }
      setText('#hit-rate-hint', VLLM_NA_MESSAGE);
      return;
    }
    const rate = snapshot.prefixCacheHitRate;
    const el = $('#hit-rate');
    if (!el) return;
    el.textContent = rate == null ? '--' : formatPct(rate);
    el.classList.remove('bigstat__value--warn', 'bigstat__value--error');
    if (rate != null) {
      if (rate < 20) el.classList.add('bigstat__value--error');
      else if (rate < 50) el.classList.add('bigstat__value--warn');
    }
    const hint = $('#hit-rate-hint');
    if (hint) {
      const hits = snapshot.prefixCacheHits;
      const queries = snapshot.prefixCacheQueries;
      if (hits == null && queries == null) {
        hint.textContent = 'prefix caching not exposed by this build';
      } else {
        hint.textContent =
          `${(hits || 0).toLocaleString()} / ${(queries || 0).toLocaleString()} prefix tokens from cache`;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Logs panel
// ---------------------------------------------------------------------------
const logs = {
  view: null,
  lines: [],
  autoscroll: true,
  init() {
    this.view = $('#server-logs');
    if (!this.view) return;

    // Auto-scroll toggle
    const autoscrollToggle = $('#log-autoscroll');
    if (autoscrollToggle) {
      autoscrollToggle.addEventListener('change', () => {
        this.autoscroll = autoscrollToggle.checked;
      });
    }

    $('#btn-clear-logs').addEventListener('click', () => this.clear());
  },
  push(entry) {
    if (!this.view) return;
    const line = document.createElement('div');
    line.className = `log-line log-line--${entry.level}`;
    line.textContent = entry.text;
    this.view.appendChild(line);
    this.lines.push(line);
    while (this.lines.length > MAX_LOG_LINES) {
      const old = this.lines.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    if (this.autoscroll) this.scrollBottom();
  },
  clear() {
    if (!this.view) return;
    this.view.innerHTML = '';
    this.lines.length = 0;
  },
  scrollBottom() {
    if (!this.view) return;
    this.view.scrollTop = this.view.scrollHeight;
  },
};

// ---------------------------------------------------------------------------
// Provenance / Monitor mode
// ---------------------------------------------------------------------------
const provenance = {
  current: { state: 'none', kind: 'unknown', model: null, models: [], endpoint: '' },
  update(snapshot) {
    if (!snapshot) return;
    this.current = snapshot;
    this.renderBadge();
    this.applyPanelStates();
    this.applyButtonStates();
  },
  renderBadge() {
    const badge = $('#prov-badge');
    if (!badge) return;
    if (this.current.endpoint) topbar.endpoint(this.current.endpoint);
    const label = badge.querySelector('.prov-badge__label');
    badge.classList.remove('prov-badge--ours', 'prov-badge--external', 'prov-badge--none');
    const { state, kind, model } = this.current;
    if (state === 'ours') {
      badge.classList.add('prov-badge--ours');
      label.textContent = model ? `Ours · ${model}` : 'Ours · vLLM';
    } else if (state === 'external') {
      badge.classList.add('prov-badge--external');
      const kindLabel = PROV_KIND_LABELS[kind] || PROV_KIND_LABELS.unknown;
      label.textContent = model ? `External · ${kindLabel} · ${model}` : `External · ${kindLabel}`;
    } else {
      badge.classList.add('prov-badge--none');
      label.textContent = 'No server';
    }
    badge.title = this.badgeTitle();
  },
  badgeTitle() {
    const { state, kind, endpoint, dockerAvailable, ourContainerState } = this.current;
    if (state === 'none') return 'No server is answering the saved endpoint.';
    const kindLabel = PROV_KIND_LABELS[kind] || PROV_KIND_LABELS.unknown;
    if (state === 'ours') {
      return `Our Docker container owns ${endpoint || 'the endpoint'} (${kindLabel}).`;
    }
    return `External ${kindLabel} server owns ${endpoint || 'the endpoint'}.`;
  },
  applyPanelStates() {
    const isVllm = this.current.kind === 'vllm';
    const na = !isVllm;
    health.na = na;
    throughput.na = na;
    prefixCache.na = na;
    for (const panelId of ['panel-health', 'panel-throughput', 'panel-prefix-cache', 'panel-context-fill']) {
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.toggle('panel--na', na);
    }
  },
  applyButtonStates() {
    serverCtl.setProvenanceState(this.current.state);
  },
};

// ---------------------------------------------------------------------------
// Server control panel (start / stop / restart)
// ---------------------------------------------------------------------------
const serverCtl = {
  _btns: null,
  busy: false,
  locked: false,
  init() {
    this._btns = {
      s: $('#btn-start'),
      t: $('#btn-stop'),
      r: $('#btn-restart'),
    };
    this._btns.s.addEventListener('click', () => this.act('start'));
    this._btns.t.addEventListener('click', () => this.act('stop'));
    this._btns.r.addEventListener('click', () => this.act('restart'));
  },
  setProvenanceState(state) {
    if (!this._btns) return;
    // Ours: normal behavior. None: Start enabled, Stop/Restart disabled.
    // External: everything locked while the external server owns the endpoint.
    this.locked = state === 'external';
    const canStart = state !== 'external' && !this.busy;
    const canStop = state === 'ours' && !this.busy;
    const canRestart = state === 'ours' && !this.busy;
    this._applyDisabled(!canStart, !canStop, !canRestart);
  },
  async act(action) {
    if (this.busy || this.locked || !window.vllm) return;
    this.busy = true;
    this._applyDisabled(true, true, true);
    const fn = { start: 'startServer', stop: 'stopServer', restart: 'restartServer' }[action];
    try {
      const result = await window.vllm[fn]();
      if (result && result.locked) {
        this.output(result.reason || 'Locked by external server');
      }
    } catch (e) {
      this.output(`IPC error: ${e.message}`);
    }
    // Safety net — if _pollState() never fires (e.g. dockerd is unreachable),
    // unblock after 150 s so the user can retry.
    this._unlockTimer = setTimeout(() => {
      // Only unlock if still stuck; the state() handler will clear this timer.
      if (this.busy) this._applyDisabled(false, false, false);
    }, 150000);
  },
  // Only touches DOM — never touches this.busy.
  _applyDisabled(startDisabled, stopDisabled, restartDisabled) {
    if (this._unlockTimer) {
      clearTimeout(this._unlockTimer);
      this._unlockTimer = null;
    }
    const { s, t, r } = this._btns;
    if (s) s.disabled = startDisabled;
    if (t) t.disabled = stopDisabled;
    if (r) r.disabled = restartDisabled;
  },
  _setBtnDisabled(disabled) {
    this._applyDisabled(disabled, disabled, disabled);
  },
  state(info) {
    const el = $('#server-state');
    if (!el) return;
    el.classList.remove('ctl-status__value--running', 'ctl-status__value--stopped', 'ctl-status__value--unknown', 'ctl-status__value--locked');
    if (info.state === 'running') { el.textContent = 'running'; el.classList.add('ctl-status__value--running'); }
    else if (info.state === 'stopped') { el.textContent = 'stopped'; el.classList.add('ctl-status__value--stopped'); }
    else if (info.state === 'locked') { el.textContent = 'locked'; el.classList.add('ctl-status__value--locked'); }
    else { el.textContent = info.state || 'unknown'; el.classList.add('ctl-status__value--unknown'); }
    setText('#server-meta', `container: ${this._containerName()}`);
    // state() fires after _pollState() succeeds → the action completed,
    // regardless of the container's final state. Unlock buttons.
    this.busy = false;
    if (info.state !== 'locked') {
      provenance.applyButtonStates();
    } else {
      this._applyDisabled(true, true, true);
    }
  },
  output(entry) {
    const el = $('#server-output');
    const bootEl = $('#ctl-boot');
    if (!el) return;
    el.textContent = entry.text;

    // Show boot indicator when status contains probing/loading keywords.
    if (bootEl) {
      const text = entry.text.toLowerCase();
      const showing = text.includes('model') || text.includes('loading') || text.includes('starting');
      bootEl.style.display = showing ? 'flex' : 'none';
    }
  },
  _containerName() {
    // Best-effort: read from config if available, else default.
    return (this._name) || 'my-vllm';
  },
  setName(name) { this._name = name; },
};

// ---------------------------------------------------------------------------
// vLLM Config panel
// ---------------------------------------------------------------------------
const config = {
  init() {
    const save = $('#config-save');
    const restart = $('#config-restart');
    const detect = $('#cfg-detect');
    if (save) save.addEventListener('click', () => this.save(false));
    if (restart) restart.addEventListener('click', () => this.save(true));
    if (detect) detect.addEventListener('click', () => this.detect());
    // Model preset dropdown
    const preset = $('#cfg-preset');
    if (preset) {
      preset.addEventListener('change', () => this.selectPreset(preset.value));
    }
    // Custom profile "Save as" button
    const addProfile = $('#btn-add-profile');
    if (addProfile) {
      addProfile.addEventListener('click', () => this.addProfile());
    }
  },
  async detect() {
    const saved = $('#config-saved');
    if (saved) { saved.textContent = 'detecting…'; saved.classList.remove('cfg-saved--ok', 'cfg-saved--err'); }
    if (!window.vllm || typeof window.vllm.detectServer !== 'function') {
      if (saved) { saved.textContent = 'detect unsupported'; saved.classList.add('cfg-saved--err'); }
      return;
    }
    try {
      const result = await window.vllm.detectServer();
      if (result && result.ok && result.detected) {
        const d = result.detected;
        const kindLabel = PROV_KIND_LABELS[d.kind] || 'unknown';
        // Apply the detected endpoint so the metrics poller hits the right port.
        if (typeof window.vllm.configureMetrics === 'function' && result.endpoint) {
          await window.vllm.configureMetrics(result.endpoint).catch(() => {});
        }
        // Update the endpoint input field so the user can see what's active.
        const input = $('#cfg-endpoint');
        if (input && result.endpoint) input.value = result.endpoint;
        if (saved) {
          saved.textContent = `detected ${kindLabel} on ${result.endpoint}` + (d.model ? ` · ${d.model}` : '');
          saved.classList.add('cfg-saved--ok');
        }
      } else if (result && result.ok) {
        if (saved) {
          saved.textContent = `detected ${result.endpoint} — not saved`;
          saved.classList.add('cfg-saved--ok');
        }
      } else {
        if (saved) { saved.textContent = 'no local model server found'; saved.classList.add('cfg-saved--err'); }
      }
    } catch (e) {
      if (saved) { saved.textContent = `detect failed: ${e.message}`; saved.classList.add('cfg-saved--err'); }
    }
  },
  // Load the preset list into the dropdown.
  async loadPresets() {
    if (!window.vllm || typeof window.vllm.listPresets !== 'function') return;
    const presets = await window.vllm.listPresets().catch(() => []);
    const select = $('#cfg-preset');
    if (!select) return;
    // Keep the first "— Custom —" option, remove any old preset options.
    Array.from(select.options).forEach((opt) => {
      if (opt.value !== '') select.remove(opt);
    });
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      opt.dataset.description = p.description || '';
      select.appendChild(opt);
    }
  },
  async load() {
    if (!window.vllm || typeof window.vllm.getConfig !== 'function') return Promise.resolve();
    return window.vllm.getConfig().then(async (c) => {
      if (!c) return;
      const ep = $('#cfg-endpoint');
      const cmd = $('#cfg-command');
      const preset = $('#cfg-preset');
      const desc = $('#cfg-preset-desc');
      if (ep) ep.value = c.vllmEndpoint || '';
      if (cmd) cmd.value = c.vllmCommand || '';
      // Set the preset dropdown to the matching preset (or profiles) or "Custom".
      if (preset) {
        if (c.activePresetId) {
          preset.value = c.activePresetId;
        } else if (c.activeProfileId) {
          preset.value = '__custom_profile__';
          // We also highlight that profile in the profiles list.
          this.highlightProfile(c.activeProfileId);
        } else {
          // No activePresetId — try to match saved command against presets.
          const matchedId = await window.vllm.matchPreset(c.vllmCommand).catch(() => null);
          if (matchedId) {
            preset.value = matchedId;
          } else {
            preset.value = '';
          }
        }
      }
      // Show the description of the selected preset.
      if (desc) {
        const selected = preset && preset.selectedOptions[0];
        desc.textContent = (selected && selected.dataset.description) || '';
      }
      // Extract container name for the server control panel meta.
      const m = (c.vllmCommand || '').match(/--name[= ]([^\s"']+)/);
      if (m && m[1]) serverCtl.setName(m[1]);
      // Load profile list into the profiles section.
      this.loadProfiles();
    }).catch(() => {});
  },
  // Called when the user picks a preset from the dropdown.
  async selectPreset(presetId) {
    const preset = $('#cfg-preset');
    const desc = $('#cfg-preset-desc');
    const cmd = $('#cfg-command');
    if (presetId === '__custom_profile__') {
      // Selected a custom profile → load the profile list, highlight it,
      // don't change the command (user already sees their current command).
      if (preset) {
        // Find matching profile and mention it.
      }
      return;
    }
    if (!presetId) {
      // "Custom" selected — clear the description, leave the command as-is.
      if (desc) desc.textContent = '';
      this.unhighlightProfile();
      return;
    }
    if (!window.vllm || typeof window.vllm.selectPreset !== 'function') return;
    const result = await window.vllm.selectPreset(presetId).catch((e) => ({ ok: false, error: e.message }));
    if (result.ok) {
      // Update the command textarea with the preset's command.
      if (cmd) {
        const c = await window.vllm.getConfig().catch(() => null);
        if (c && c.vllmCommand) cmd.value = c.vllmCommand;
      }
      // Show the description.
      if (desc) {
        const selected = preset && preset.selectedOptions[0];
        desc.textContent = (selected && selected.dataset.description) || '';
      }
      // Update the container name.
      const m = (cmd.value || '').match(/--name[= ]([^\s"']+)/);
      if (m && m[1]) serverCtl.setName(m[1]);
      this.unhighlightProfile();
    } else {
      if (desc) desc.textContent = `Error: ${result.error}`;
    }
  },
  async save(restartServer) {
    const ep = $('#cfg-endpoint');
    const cmd = $('#cfg-command');
    const saved = $('#config-saved');
    const patch = {
      vllmEndpoint: ep ? ep.value.trim() : '',
      vllmCommand: cmd ? cmd.value : '',
    };
    if (saved) { saved.textContent = 'saving…'; saved.classList.remove('cfg-saved--ok', 'cfg-saved--err'); }
    let result = { ok: false, error: 'IPC unavailable' };
    try {
      result = await window.vllm.saveConfig(patch);
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    if (saved) {
      if (result.ok) {
        saved.textContent = restartServer ? 'saved + restarting…' : `saved → ${result.path}`;
        saved.classList.add('cfg-saved--ok');
      } else {
        saved.textContent = `save failed: ${result.error}`;
        saved.classList.add('cfg-saved--err');
      }
    }
    if (restartServer && result.ok && window.vllm) {
      try { await window.vllm.restartServer(); } catch (_) {}
    }
    if (result.ok) {
      topbar.endpoint(patch.vllmEndpoint);
      // Clear old log data so new log source won't intermix.
      logs.clear();
      // Re-trigger load to refresh preset/profile dropdown selection.
      this.load();
    }
  },

  // -----------------------------------------------------------------------
  // Config Profiles
  // -----------------------------------------------------------------------

  /**
   * Load the list of saved profiles and render them in the profiles section.
   */
  async loadProfiles() {
    const list = $('#profiles-list');
    if (!list || !window.vllm || typeof window.vllm.listProfiles !== 'function') return;
    const items = await window.vllm.listProfiles().catch(() => []);
    list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'cfg-preset-desc';
      empty.textContent = 'No saved config profiles yet. Edit the launch command above and click "Create Custom Config" to save one.';
      list.appendChild(empty);
      return;
    }
    for (const p of items) {
      const row = document.createElement('div');
      row.className = 'profile-row';
      row.dataset.profileId = p.id;
      row.title = 'Click to load this profile';
      // Name (clickable)
      const name = document.createElement('span');
      name.className = 'profile-row__name';
      name.textContent = p.name;
      row.appendChild(name);
      // Date
      const meta = document.createElement('span');
      meta.className = 'profile-row__meta';
      try {
        meta.textContent = new Date(p.createdAt).toLocaleDateString();
      } catch (_) {
        meta.textContent = '';
      }
      row.appendChild(meta);
      // Delete button
      const del = document.createElement('button');
      del.className = 'profile-row__delete';
      del.textContent = '×';
      del.title = `Delete profile "${p.name}"`;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteProfile(p.id);
      });
      row.appendChild(del);
      // Click to load
      row.addEventListener('click', () => this.loadProfileViaDropdown(p.id));
      list.appendChild(row);
    }
  },

  /**
   * Highlight a profile row as active in the profiles list.
   */
  highlightProfile(profileId) {
    const rows = $('#profiles-list').querySelectorAll('.profile-row');
    rows.forEach((r) => {
      r.classList.toggle('profile-row--active', r.dataset.profileId === profileId);
    });
  },

  /**
   * Remove the active highlight from all profile rows.
   */
  unhighlightProfile() {
    const rows = $('#profiles-list').querySelectorAll('.profile-row');
    rows.forEach((r) => r.classList.remove('profile-row--active'));
  },

  /**
   * Create a new custom config profile from the current launch command.
   */
  async addProfile() {
    const saved = $('#profile-saved');
    if (saved) { saved.textContent = 'saving…'; saved.classList.remove('cfg-saved--ok', 'cfg-saved--err'); }

    if (!window.vllm || typeof window.vllm.createProfile !== 'function') {
      if (saved) { saved.textContent = 'save unsupported'; saved.classList.add('cfg-saved--err'); }
      return;
    }

    // Ask the user for a name.
    const cmd = $('#cfg-command');
    const defaultName = (cmd.value || '').match(/--served-model-name\s+([^\s"',"]+)/)
      ? (RegExp.$1 || 'Custom Config')
      : 'Custom Config';
    const name = prompt('Name for this config profile:', defaultName || 'Custom Config');
    if (!name || !name.trim()) {
      if (saved) { saved.textContent = 'cancelled'; saved.classList.remove('cfg-saved--ok', 'cfg-saved--err'); }
      return;
    }

    try {
      const result = await window.vllm.createProfile(name);
      if (result && result.ok) {
        if (saved) {
          saved.textContent = `profile "${result.profile.name}" saved`;
          saved.classList.add('cfg-saved--ok');
        }
        // Reload the profile list.
        this.loadProfiles();
      } else {
        if (saved) {
          saved.textContent = `create failed: ${result.error}`;
          saved.classList.add('cfg-saved--err');
        }
      }
    } catch (e) {
      if (saved) {
        saved.textContent = `create error: ${e.message}`;
        saved.classList.add('cfg-saved--err');
      }
    }
  },

  /**
   * Load a profile by populating the dropdown with a temporary entry and selecting it.
   * Also populates the command field.
   */
  async loadProfileViaDropdown(profileId) {
    if (!window.vllm || typeof window.vllm.selectProfile !== 'function') return;
    const result = await window.vllm.selectProfile(profileId).catch((e) => ({ ok: false, error: e.message }));
    if (result.ok) {
      const cmd = $('#cfg-command');
      if (cmd) {
        const c = await window.vllm.getConfig().catch(() => null);
        if (c && c.vllmCommand) {
          cmd.value = c.vllmCommand;
        }
      }
      // Highlight this profile in the list.
      this.highlightProfile(profileId);
      // Set the dropdown to the custom profile marker.
      const preset = $('#cfg-preset');
      if (preset) preset.value = '__custom_profile__';
    } else {
      const saved = $('#profile-saved');
      if (saved) {
        saved.textContent = `load failed: ${result.error}`;
        saved.classList.add('cfg-saved--err');
      }
    }
  },

  /**
   * Delete a saved config profile.
   */
  async deleteProfile(profileId) {
    if (!window.vllm || typeof window.vllm.deleteProfile !== 'function') return;
    const result = await window.vllm.deleteProfile(profileId).catch((e) => ({ ok: false, error: e.message }));
    if (result && result.ok) {
      this.loadProfiles();
    }
  },
};

// ---------------------------------------------------------------------------
// Top bar: connection badge + endpoint + theme toggle
// ---------------------------------------------------------------------------
const topbar = {
  endpoint(text) {
    setText('#server-endpoint', text || 'http://127.0.0.1:8000');
  },
  connBadge(state, detail) {
    const badge = $('#conn-badge');
    if (!badge) return;
    badge.classList.remove('badge--running', 'badge--stopped', 'badge--neutral');
    const label = badge.querySelector('.badge__label');
    if (state === 'live') {
      badge.classList.add('badge--running');
      label.textContent = detail || 'Live';
    } else if (state === 'down') {
      badge.classList.add('badge--stopped');
      label.textContent = detail || 'Down';
    } else {
      badge.classList.add('badge--neutral');
      label.textContent = detail || '…';
    }
  },
  initThemeToggle() {
    const btn = $('#theme-toggle');
    if (!btn) return;
    const saved = localStorage.getItem('vllm-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
      btn.querySelector('.icon-btn__glyph').textContent = saved === 'light' ? '☀' : '☾';
    }
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('vllm-theme', next);
      btn.querySelector('.icon-btn__glyph').textContent = next === 'light' ? '☀' : '☾';
    });
  },
};

// ---------------------------------------------------------------------------
// System Monitor panel
// ---------------------------------------------------------------------------
const sysmon = {
  update(snapshot) {
    if (!snapshot || !snapshot.ok) {
      setText('#sysmon-meta', 'error');
      return;
    }
    const { gpu, system } = snapshot;
    setText('#sysmon-meta', formatTime(snapshot.at));

    // GPU
    setText('#sysmon-gpu-name', gpu.name || 'N/A');
    const utilPct = gpu.utilizationPct;
    setText('#sysmon-gpu-util', utilPct != null ? utilPct + '%' : 'N/A');
    const clockMhz = gpu.clockMhz;
    setText('#sysmon-gpu-clock', clockMhz != null ? clockMhz + ' MHz' : 'N/A');
    const tempC = gpu.temperatureC;
    setText('#sysmon-gpu-temp', tempC != null ? tempC + '°C' : 'N/A');
    const powerW = gpu.powerW;
    setText('#sysmon-gpu-power', powerW != null ? powerW.toFixed(1) + ' W' : 'N/A');
    setText('#sysmon-gpu-driver', gpu.driverVersion || 'N/A');

    // Color-coded temp bar + value color
    if (tempC != null) {
      const bar = $('#sysmon-temp-bar');
      if (bar) {
        bar.style.width = Math.min(100, tempC) + '%';
        bar.className = 'sysmon-temp-bar__fill';
        if (tempC >= 90) bar.classList.add('sysmon-temp-bar__fill--red');
        else if (tempC >= 80) bar.classList.add('sysmon-temp-bar__fill--orange');
        else if (tempC >= 70) bar.classList.add('sysmon-temp-bar__fill--yellow');
        else bar.classList.add('sysmon-temp-bar__fill--green');
      }
      // Color the temp value text too
      const tempVal = $('#sysmon-gpu-temp');
      if (tempVal) {
        tempVal.classList.remove('sysmon-value--warn', 'sysmon-value--error');
        if (tempC >= 80) tempVal.classList.add('sysmon-value--error');
        else if (tempC >= 70) tempVal.classList.add('sysmon-value--warn');
      }
    }
    // Color-coded power bar
    if (powerW != null) {
      const bar = $('#sysmon-power-bar');
      if (bar) {
        // Scale: 0-500W range (GB10 max ~500W)
        bar.style.width = Math.min(100, (powerW / 500) * 100) + '%';
        bar.className = 'sysmon-power-bar__fill';
        if (powerW >= 500) bar.classList.add('sysmon-power-bar__fill--red');
        else if (powerW >= 400) bar.classList.add('sysmon-power-bar__fill--yellow');
        else bar.classList.add('sysmon-power-bar__fill--green');
      }
    }

    // VRAM / Memory — unified memory on GB10
    const memEl = $('#sysmon-gpu-mem');
    const memBar = $('#sysmon-gpu-mem-bar');
    if (gpu.memoryTotalMiB != null && gpu.memoryUsedMiB != null) {
      const totalGiB = (gpu.memoryTotalMiB / 1024).toFixed(1);
      const usedGiB = (gpu.memoryUsedMiB / 1024).toFixed(1);
      const pct = (gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100;
      if (memEl) memEl.textContent = `${usedGiB} / ${totalGiB} GiB (${pct.toFixed(0)}%)`;
      if (memBar) memBar.style.width = Math.min(100, pct) + '%';
    } else {
      // GB10 unified memory: nvidia-smi reports N/A. Use /proc/meminfo.
      if (system && system.memTotalGiB) {
        const total = system.memTotalGiB.toFixed(0);
        const avail = system.memAvailableGiB.toFixed(1);
        const used = (system.memTotalGiB - system.memAvailableGiB).toFixed(1);
        const pct = system.memTotalGiB > 0 ? ((system.memTotalGiB - system.memAvailableGiB) / system.memTotalGiB * 100) : 0;
        if (memEl) memEl.textContent = `${used} / ${total} GiB unified (${pct.toFixed(0)}%)`;
        if (memBar) memBar.style.width = Math.min(100, pct) + '%';
      } else {
        if (memEl) memEl.textContent = 'N/A';
        if (memBar) memBar.style.width = '0%';
      }
    }

    // System
    setText('#sysmon-os', system.os || 'N/A');
    setText('#sysmon-arch', system.arch || 'N/A');
    setText('#sysmon-cpu', system.cpuModel || 'N/A');
    setText('#sysmon-cores', system.cpuCores || 'N/A');
    setText('#sysmon-kernel', system.kernel || 'N/A');

    // System memory
    const sysMemEl = $('#sysmon-mem');
    const sysMemBar = $('#sysmon-mem-bar');
    if (system.memTotalGiB > 0) {
      const total = system.memTotalGiB.toFixed(0);
      const avail = system.memAvailableGiB.toFixed(1);
      const used = (system.memTotalGiB - system.memAvailableGiB).toFixed(1);
      const pct = (system.memTotalGiB - system.memAvailableGiB) / system.memTotalGiB * 100;
      if (sysMemEl) sysMemEl.textContent = `${used} / ${total} GiB`;
      if (sysMemBar) sysMemBar.style.width = Math.min(100, pct) + '%';
    } else {
      if (sysMemEl) sysMemEl.textContent = 'N/A';
      if (sysMemBar) sysMemBar.style.width = '0%';
    }
  },
};
// ---------------------------------------------------------------------------
// App version — read from .version file, displayed in the top bar
// ---------------------------------------------------------------------------
function loadAppVersion() {
  const el = document.getElementById('app-version');
  if (!el) return;
  if (window.vllm && typeof window.vllm.versions === 'function') {
    try {
      const v = window.vllm.versions();
      if (v && v.app) {
        el.textContent = v.app;
        // Also set the commit badge if available
        const commitEl = document.getElementById('app-commit');
        if (commitEl) {
          if (v.commit) commitEl.textContent = v.commit;
          else commitEl.style.display = 'none';
        }
        return;
      }
    } catch (_) { /* versions() may fail in dev */ }
  }
  // Ultimate fallback: hard-coded.
  el.textContent = 'v0.1.0';
}


// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  loadAppVersion();
  logs.init();
  serverCtl.init();
  config.init();
  // Load presets into the dropdown first, then load the saved config.
  config.loadPresets().then(() => config.load());
  topbar.initThemeToggle();

  // Pull current metrics settings from main to display the endpoint.
  if (window.vllm && typeof window.vllm.getMetricsSettings === 'function') {
    window.vllm.getMetricsSettings().then((settings) => {
      if (settings && settings.endpoint) topbar.endpoint(settings.endpoint);
    }).catch(() => {});
  }

  // Subscribe to metrics updates.
  if (window.vllm) {
    window.vllm.onMetricsUpdate((snapshot) => {
      health.update(snapshot);
      throughput.update(snapshot);
      prefixCache.update(snapshot);
      contextFill.update(snapshot);
      topbar.connBadge(snapshot.ok ? 'live' : 'down',
        snapshot.ok ? 'Live' : (snapshot.error || 'Down'));
    });
    window.vllm.onHealth((info) => health.health(info));
    window.vllm.onLogLine((entry) => logs.push(entry));
    window.vllm.onLogStatus((status) => {
      const panel = $('#panel-logs');
      if (!panel) return;
      let target = $('#log-meta');
      if (!target) {
        // First time — create the meta span inside the panel header.
        const header = panel.querySelector('.panel__header');
        if (!header) return;
        target = document.createElement('span');
        target.className = 'panel__meta';
        target.id = 'log-meta';
        header.appendChild(target);
      }
      target.textContent = status.active ? status.detail : (status.detail || 'idle');
    });
    // Server control events
    window.vllm.onServerState((info) => serverCtl.state(info));
    window.vllm.onServerOutput((entry) => serverCtl.output(entry));

    // Provenance / Monitor mode
    if (typeof window.vllm.getProvenance === 'function') {
      window.vllm.getProvenance().then((snapshot) => {
        provenance.update(snapshot);
      }).catch(() => {});
    }
    // Auto-detect on startup: if the saved endpoint isn't responding but a
    // vLLM is running on another port, reconfigure the metrics poller.
    // Also re-try periodically if metrics keep failing.
    if (typeof window.vllm.detectServer === 'function'
        && typeof window.vllm.configureMetrics === 'function') {
      let detectAttempted = false;
      let retryCount = 0;
      const MAX_RETRIES = 3;
      async function tryAutoDetect() {
        if (detectAttempted) return;
        detectAttempted = true;
        try {
          const result = await window.vllm.detectServer();
          if (result && result.ok && result.endpoint) {
            const current = await window.vllm.getMetricsSettings().catch(() => null);
            if (current && current.endpoint && current.endpoint !== result.endpoint) {
              await window.vllm.configureMetrics(result.endpoint).catch(() => {});
              const input = $('#cfg-endpoint');
              if (input) input.value = result.endpoint;
            }
          }
        } catch (_) {
          detectAttempted = false; // allow retry below
        }
      }
      // Run on startup with a small delay to let the app settle.
      setTimeout(() => tryAutoDetect(), 2000);
      // Staggered re-detect if the poller keeps failing:
      // after 1st failure wait 5 s, 2nd wait 10 s, 3rd wait 15 s.
      window.vllm.onMetricsUpdate((snapshot) => {
        if (!snapshot || snapshot.ok || retryCount >= MAX_RETRIES) return;
        retryCount++;
        setTimeout(() => tryAutoDetect(), 5000 * retryCount);
      });
    }
    window.vllm.onProvenanceUpdate((snapshot) => provenance.update(snapshot));

    // System monitor (GPU + system telemetry)
    window.vllm.onSystemMonitorUpdate((snapshot) => sysmon.update(snapshot));
  }

  // Initial paint so panels aren't blank on first frame.
  health.update({ ok: false, at: null, kvCachePct: null, numRunning: null, numWaiting: null,
    promptTokS: null, genTokS: null, promptTokensTotal: null, genTokensTotal: null,
    prefixCacheHits: null, prefixCacheQueries: null, prefixCacheHitRate: null });
  throughput.update({ promptTokS: null, genTokS: null, ttftMs: null, itlMs: null, promptTokensTotal: null, genTokensTotal: null });
  prefixCache.update({ prefixCacheHitRate: null, prefixCacheHits: null, prefixCacheQueries: null });
  contextFill.update(null);
  provenance.renderBadge();
  serverCtl.setProvenanceState('none');
});
