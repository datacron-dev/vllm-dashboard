'use strict';

const { EventEmitter } = require('events');
const { exec } = require('child_process');

// ---------------------------------------------------------------------------
// Provenance — determine who owns the saved endpoint.
//
// The dashboard supports two modes:
//   1. Launch mode: our Docker container owns the endpoint.
//   2. Monitor mode: an external vLLM server owns the endpoint.
//
// Decision rule:
//   - Probe the saved endpoint for /v1/models and /metrics.
//   - Run `docker ps --filter name=<ourName>` and inspect the container.
//   - If our container exists and is active, classify as 'ours'.
//   - If the endpoint is answering but our container is not active,
//     classify as 'external'.
//   - Otherwise classify as 'none'.
//
// Server type detection:
//   - If /metrics is reachable and looks like Prometheus, kind='vllm'.
//   - Otherwise kind='unknown' when the endpoint answers.
//
// Emits:
//   'update' -> {
//     state: 'ours' | 'external' | 'none',
//     kind: 'vllm' | 'unknown',
//     model: string|null,
//     models: string[],
//     endpoint: string,
//     dockerAvailable: boolean,
//     ourContainer: string|null,
//     ourContainerState: string|null,
//     modelsOk: boolean,
//     metricsOk: boolean,
//     at: number,
//   }
// ---------------------------------------------------------------------------

class Provenance extends EventEmitter {
  constructor({
    endpoint = 'http://127.0.0.1:8000',
    containerName = 'my-vllm',
    intervalMs = 5000,
  } = {}) {
    super();
    this.endpoint = Provenance.normalizeEndpoint(endpoint);
    this.containerName = containerName;
    this.intervalMs = Math.max(1000, intervalMs || 5000);
    this.timer = null;
    this.last = null;
  }

  setEndpoint(rawEndpoint) {
    const next = Provenance.normalizeEndpoint(rawEndpoint);
    if (next !== this.endpoint) {
      this.endpoint = next;
      this._poll();
    }
  }

  setContainerName(name) {
    if (name && name !== this.containerName) {
      this.containerName = name;
      this._poll();
    }
  }

  async start() {
    this.stop();
    await this._poll();
    this.timer = setInterval(() => this._poll(), this.intervalMs);
    return this.last;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async detect(ports = [40181, 8000, 8080, 4000, 7001]) {
    // Detect is read-only: it reports which endpoint is answering, but does
    // not mutate this.endpoint or SETTINGS.vllmEndpoint.
    const staticPorts = Array.isArray(ports) && ports.length ? ports : [40181, 8000, 8080, 4000, 7001];
    const dockerPorts = await Provenance.dockerPorts();
    // Build candidate list.  Docker-discovered ports are placed FIRST so that
    // a vLLM container the user is actually running wins over any other port.
    const allPorts = [...new Set([...dockerPorts, ...staticPorts])];

    const candidates = allPorts
      .map((port) => {
        const base = Provenance.normalizeEndpoint(this.endpoint || 'http://127.0.0.1:8000');
        try {
          const url = new URL(base);
          url.port = String(Number(port));
          return url.toString().replace(/\/$/, '');
        } catch (_) {
          return `http://127.0.0.1:${port}`;
        }
      });

    // Probe all candidates in parallel, then pick the best match.
    // Within the same kind, earlier ports win (Docker-discovered ports
    // come first in the array).
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        const probe = await this._probeEndpoint(candidate);
        return { candidate, probe };
      })
    );

    // Find the best result.
    let best = null;
    for (const { candidate, probe } of results) {
      if (!(probe.modelsOk || probe.metricsOk)) continue;
      let kind = 'unknown';
      if (probe.metricsOk && Provenance.looksLikePrometheus(probe.metricsBody || '')) {
        kind = 'vllm';
      }
      if (!best) {
        best = { candidate, probe, kind };
      } else {
        // Prefer a vLLM-shaped endpoint over an unknown one.
        if (kind === 'vllm' && best.kind !== 'vllm') {
          best = { candidate, probe, kind };
        }
      }
    }

    if (best) {
      const snapshot = await this._buildSnapshot(best.candidate, best.probe);
      // Keep the saved/active endpoint authoritative for provenance state.
      // The discovered endpoint is reported in `endpoint`/`detected` fields
      // only; the badge reflects who owns the *saved* endpoint.
      snapshot.endpoint = this.endpoint;
      snapshot.detectedEndpoint = best.candidate;
      snapshot.detectedKind = best.kind;
      snapshot.detectedState = best.probe.modelsOk || best.probe.metricsOk ? 'external' : 'none';
      snapshot.detectedModel = snapshot.model;
      return {
        ok: true,
        endpoint: best.candidate,
        detected: snapshot,
        snapshot: await this._buildSnapshot(this.endpoint, best.probe),
        scanned: candidates,
      };
    }

    return { ok: false, endpoint: this.endpoint, scanned: candidates };
  }

  async _poll() {
    const probe = await this._probeEndpoint(this.endpoint);
    const snapshot = await this._buildSnapshot(this.endpoint, probe);
    this.last = snapshot;
    this.emit('update', snapshot);
    return snapshot;
  }

  static normalizeEndpoint(raw) {
    let ep = String(raw || '').trim().replace(/\/+$/, '');
    ep = ep.replace(/\/v1$/, '');
    return ep || 'http://127.0.0.1:8000';
  }

  async _probeEndpoint(endpoint) {
    const base = Provenance.normalizeEndpoint(endpoint);
    const [models, metrics] = await Promise.all([
      Provenance.fetchJson(`${base}/v1/models`),
      Provenance.fetchText(`${base}/metrics`),
    ]);
    return {
      modelsOk: !!models && Array.isArray(models.data),
      models: models && Array.isArray(models.data) ? models.data : [],
      metricsOk: metrics.ok,
      metricsBody: metrics.body,
    };
  }

  async _buildSnapshot(endpoint, probe) {
    const base = Provenance.normalizeEndpoint(endpoint);
    const docker = await Provenance.dockerState(this.containerName);
    const ourActive = Provenance.isActiveContainerState(docker.state);

    const modelIds = probe.models.map((m) => m.id || m.name).filter(Boolean);
    const primaryModel = modelIds[0] || null;

    let kind = 'unknown';
    if (probe.metricsOk && Provenance.looksLikePrometheus(probe.metricsBody || '')) {
      kind = 'vllm';
    }

    let state = 'none';
    if (ourActive) {
      state = 'ours';
    } else if (probe.modelsOk || probe.metricsOk) {
      state = 'external';
    }

    return {
      state,
      kind,
      model: primaryModel,
      models: modelIds,
      endpoint: base,
      dockerAvailable: docker.available,
      ourContainer: docker.state ? this.containerName : null,
      ourContainerState: docker.state,
      modelsOk: probe.modelsOk,
      metricsOk: probe.metricsOk,
      at: Date.now(),
    };
  }

  static isActiveContainerState(state) {
    return ['running', 'paused', 'restarting'].includes(state);
  }

  /**
   * Discover host ports from running Docker containers.
   * Parses `docker ps` output for published ports (e.g. "127.0.0.1:40181->8000/tcp").
   * Returns an array of unique host port numbers.
   */
  static async dockerPorts() {
    const out = await new Promise((resolve) => {
      exec('docker ps --format {{.Ports}}', {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) { resolve(''); return; }
        resolve(String(stdout || ''));
      });
    });
    if (!out.trim()) return [];
    const ports = new Set();
    // Match patterns like "127.0.0.1:40181->8000/tcp" or "0.0.0.0:8080->8080/tcp"
    const re = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)->/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      const port = parseInt(m[1], 10);
      if (port > 0 && port < 65536) ports.add(port);
    }
    return [...ports];
  }

  static async dockerState(name) {
    if (!name) return { available: false, state: null };
    const out = await new Promise((resolve) => {
      exec(`docker ps -a --filter name=^${name}$ --format {{.State}}`, {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ available: false, state: null, error: String(stderr || error.message).trim() });
          return;
        }
        const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
        resolve({ available: true, state: lines[0] ? lines[0].trim().toLowerCase() : null });
      });
    });
    return out;
  }

  static async fetchJson(url, timeoutMs = 2500) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  static async fetchText(url, timeoutMs = 2500) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, body: null };
      const body = await res.text();
      return { ok: true, body };
    } catch (_) {
      return { ok: false, body: null };
    }
  }

  static looksLikePrometheus(body) {
    if (!body) return false;
    // vLLM exposes namespaced metrics such as `vllm:num_requests_running`.
    return /(?:^|\n)vllm:[a-z0-9_:]+/.test(body) || /# TYPE\s+vllm:/.test(body);
  }
}

module.exports = { Provenance };
