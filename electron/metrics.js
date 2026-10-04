'use strict';

const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// Minimal Prometheus text-format parser (no external dependency for MVP).
// Handles:
//   # HELP / # TYPE lines (skipped)
//   metric_name{label="v",...} value [timestamp]
//   metric_name value [timestamp]
// ---------------------------------------------------------------------------
function parsePrometheus(text) {
  const metrics = {}; // name -> { labels: value, value: Number, timestamp: Number|undefined }
  // Keep the LAST sample per (name + labels) in case of duplicates.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?(?:\d+\.?\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)(?:\s+(\d+))?$/);
    if (!m) continue;

    const name = m[1];
    const labelsRaw = m[2];
    const valueStr = m[3];
    const tsRaw = m[4];

    if (valueStr === undefined || valueStr === '+NaN') continue;

    // Parse labels
    const labels = {};
    if (labelsRaw) {
      const labelRe = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
      let lm;
      while ((lm = labelRe.exec(labelsRaw)) !== null) {
        labels[lm[1]] = lm[2].replace(/\\(.)/g, '$1');
      }
    }

    const value = Number(valueStr);
    if (Number.isNaN(value)) continue;

    const key = labelsRaw
      ? name + '{' + labelsRaw + '}'
      : name;
    metrics[key] = { name, labels, value, timestamp: tsRaw ? Number(tsRaw) : undefined };
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getValue(metrics, name, labelFilter = {}) {
  for (const [key, m] of Object.entries(metrics)) {
    if (m.name !== name) continue;
    let ok = true;
    for (const [k, v] of Object.entries(labelFilter)) {
      if (m.labels[k] !== String(v)) { ok = false; break; }
    }
    if (ok) return m.value;
  }
  return null;
}

function getFirstValue(metrics, name) {
  for (const m of Object.values(metrics)) {
    if (m.name === name) return m.value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MetricsPoller
// ---------------------------------------------------------------------------
class MetricsPoller extends EventEmitter {
  constructor({ endpoint, intervalMs = 2000, healthIntervalMs = 5000 }) {
    super();
    // Normalise the endpoint to a *base* URL (no trailing slash, no `/v1`
    // suffix). vLLM exposes:
    //   GET /v1/models    -> OpenAI-compatible model list (health check)
    //   GET /metrics      -> Prometheus metrics (NOT under /v1)
    // Users commonly paste `http://host:8000/v1` because that's what they put
    // in the OpenAI client. Strip the trailing `/v1` so both URL builders
    // below land on the correct paths regardless of what was pasted.
    this.endpoint = this._normalizeEndpoint(endpoint);
    this.intervalMs = intervalMs;
    this.healthIntervalMs = healthIntervalMs;
    this.timer = null;
    this.healthTimer = null;
    this.last = null; // last parsed metrics
    this.lastAt = 0;  // epoch ms when last metrics were fetched
    this.lastSuccessTotal = null; // cumulative request success counter for delta
    this.lastTtftCount = null;   // cumulative _count for time_to_first_token_seconds
  }

  // Strip trailing slash and any trailing `/v1` (with or without trailing
  // slash). Preserves the host:port and any path prefix that isn't /v1.
  _normalizeEndpoint(raw) {
    let ep = String(raw || '').replace(/\/+$/, '');
    // Remove a trailing `/v1` segment. Only the very last segment, so that
    // e.g. `http://host:8000/proxy/v1` -> `http://host:8000/proxy` but
    // `http://host:8000/v1` -> `http://host:8000`.
    ep = ep.replace(/\/v1$/, '');
    return ep || 'http://127.0.0.1:8000';
  }

  start() {
    this._poll();
    this._checkHealth();
    this.timer = setInterval(() => this._poll(), this.intervalMs);
    this.healthTimer = setInterval(() => this._checkHealth(), this.healthIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
  }

  async _fetch(url) {
    // Electron 12+ exposes a global fetch in the main process.
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  // Parse Prometheus histogram buckets and return an array of representative
  // latency values (in ms).  We emit e2e_request_latency_seconds samples so
  // the frontend can render a latency distribution.
  _parseLatencyHistograms(metrics) {
    const rawBuckets = {};
    for (const [key, m] of Object.entries(metrics)) {
      if (!key.startsWith('vllm:e2e_request_latency_seconds_bucket{')) continue;
      const leMatch = key.match(/le="([\d.eE+-]+)"/);
      if (!leMatch) continue;
      rawBuckets[leMatch[1]] = m.value;
    }
    const leValues = Object.keys(rawBuckets).map(Number).sort((a, b) => a - b);
    if (leValues.length === 0) return [];

    const samples = [];
    const samplesPerBucket = 3;
    let prevCount = 0;
    for (const le of leValues) {
      const bucketCount = rawBuckets[le] - prevCount;
      prevCount = rawBuckets[le];
      if (bucketCount <= 0) continue;
      const midpoint = le / 2;
      for (let i = 0; i < samplesPerBucket; i++) {
        samples.push(midpoint * 1000); // convert to ms
      }
    }
    return samples;
  }

  // Parse a specific histogram metric and return its median value (p50) in ms.
  // Returns null when the metric is not exposed by the server.
  _parseLatencyHistogramsForMetric(metrics, metricName) {
    const rawBuckets = {};
    const bucketKey = metricName + '_bucket{';
    for (const [key, m] of Object.entries(metrics)) {
      if (!key.startsWith(bucketKey)) continue;
      // Skip _count and _sum variants
      if (key.endsWith('_count') || key.endsWith('_sum')) continue;
      const leMatch = key.match(/le="([\d.eE+-]+)"/);
      if (!leMatch) continue;
      // Store using the original le string to avoid JavaScript type coercion issues
      // when Number("1.0") !== "1" (property key lookup). See GitHub issue re: TTFT
      // showing 2560s instead of proper median.
      rawBuckets[leMatch[1]] = m.value;
    }
    // Use the original string keys for lookup consistency; sort by numeric value.
    const leStringValues = Object.keys(rawBuckets).sort(
      (a, b) => Number(a) - Number(b)
    );
    if (leStringValues.length === 0) return null;

    // Compute bucket counts and find median (p50).
    let prevCount = 0;
    let totalBuckets = 0;
    const counts = [];
    for (const le of leStringValues) {
      const bucketCount = rawBuckets[le] - prevCount;
      prevCount = rawBuckets[le];
      if (bucketCount <= 0) continue;
      const midpoint = Number(le) * 1000; // convert seconds to ms
      counts.push({ le, midpoint, count: bucketCount });
      totalBuckets += bucketCount;
    }
    if (totalBuckets === 0) return null;

    const medianThreshold = Math.ceil(totalBuckets / 2);
    let runningCount = 0;
    for (const c of counts) {
      runningCount += c.count;
      if (runningCount >= medianThreshold) {
        return c.midpoint;
      }
    }
    return counts[counts.length - 1] ? counts[counts.length - 1].midpoint : null;
  }

  async _poll() {
    try {
      const text = await this._fetch(`${this.endpoint}/metrics`);
      const metrics = parsePrometheus(text);
      const now = Date.now();
      const snapshot = this._buildSnapshot(metrics, now);
      this.last = metrics;
      this.lastAt = now;
      this.emit('update', snapshot);
    } catch (err) {
      this.emit('update', this._buildErrorSnapshot(err));
    }
  }

  async _checkHealth() {
    let status = 'stopped';
    let detail = '';
    try {
      const res = await fetch(`${this.endpoint}/v1/models`, { cache: 'no-store' });
      if (res.status === 200) {
        status = 'running';
        const body = await res.json().catch(() => ({}));
        const models = Array.isArray(body.data) ? body.data : [];
        detail = models.length ? models[0].id || models[0].name || `${models.length} model(s)` : 'up';
      } else {
        status = 'stopped';
        detail = `HTTP ${res.status}`;
      }
    } catch (err) {
      status = 'stopped';
      detail = err && err.message ? err.message : 'unreachable';
    }
    this.emit('health', { status, detail, at: Date.now() });
  }

  // Build the payload the renderer displays.
  _buildSnapshot(metrics, now) {
    const prevAt = this.lastAt;
    const dtSec = prevAt ? Math.max(0, (now - prevAt) / 1000) : 0;

    const numRunning = getFirstValue(metrics, 'vllm:num_requests_running');
    const numWaiting = getFirstValue(metrics, 'vllm:num_requests_waiting');

    // Server uptime: vLLM exposes process_start_time_seconds via Prometheus.
    const startTimeSec = getFirstValue(metrics, 'process_start_time_seconds');
    const uptimeMs = startTimeSec != null ? now - startTimeSec * 1000 : null;

    const promptTokensTotal = getFirstValue(metrics, 'vllm:prompt_tokens_total');
    const genTokensTotal = getFirstValue(metrics, 'vllm:generation_tokens_total');
    const promptTokensPrev = this.last ? getFirstValue(this.last, 'vllm:prompt_tokens_total') : null;
    const genTokensPrev = this.last ? getFirstValue(this.last, 'vllm:generation_tokens_total') : null;

    const promptTokS = promptTokensTotal != null && promptTokensPrev != null && dtSec > 0
      ? Math.max(0, (promptTokensTotal - promptTokensPrev) / dtSec)
      : null;
    const genTokS = genTokensTotal != null && genTokensPrev != null && dtSec > 0
      ? Math.max(0, (genTokensTotal - genTokensPrev) / dtSec)
      : null;

    // KV cache usage: vLLM exposes `vllm:kv_cache_usage_perc` (fraction 0..1)
    // in recent builds. Older builds used `vllm:gpu_cache_usage` (also 0..1).
    // Accept either, and also handle the case where the value is already a
    // percentage (>1) for forward-compat.
    const kvUsage =
      getFirstValue(metrics, 'vllm:kv_cache_usage_perc') ??
      getFirstValue(metrics, 'vllm:gpu_cache_usage');
    let kvUsagePct = null;
    if (kvUsage != null && kvUsage <= 1) kvUsagePct = kvUsage * 100;
    else if (kvUsage != null && kvUsage > 1) kvUsagePct = kvUsage; // already a percent

    // Prefix cache: vLLM exposes cumulative counters
    //   vllm:prefix_cache_hits_total     (tokens served from cache)
    //   vllm:prefix_cache_queries_total  (total prefix lookups, hits + misses)
    // Hit rate = hits / queries * 100. (Legacy names prefix_cache_hits /
    // prefix_cache_misses are also accepted for older builds.)
    const cacheHits =
      getFirstValue(metrics, 'vllm:prefix_cache_hits_total') ??
      getFirstValue(metrics, 'vllm:prefix_cache_hits');
    const cacheQueries =
      getFirstValue(metrics, 'vllm:prefix_cache_queries_total') ??
      (cacheHits != null && getFirstValue(metrics, 'vllm:prefix_cache_misses') != null
        ? cacheHits + getFirstValue(metrics, 'vllm:prefix_cache_misses')
        : null);
    let hitRate = null;
    if (cacheHits != null && cacheQueries != null && cacheQueries > 0) {
      hitRate = (cacheHits / cacheQueries) * 100;
    }

    // Context Fill — prefix cache state gauges (vLLM v0.10+)
    //   vllm:num_prefix_cached_blocks  — number of blocks in the prefix cache
    //   vllm:num_kv_cache_total_blocks — total KV cache block capacity
    const cachedBlocks = getFirstValue(metrics, 'vllm:num_prefix_cached_blocks');
    const totalBlocks = getFirstValue(metrics, 'vllm:num_kv_cache_total_blocks');
    let prefixCacheTokensUsed = null;
    let prefixCacheMaxTokens = null;
    if (cachedBlocks != null && totalBlocks != null && totalBlocks > 0) {
      // Each block = 16 tokens by default; use cachedBlocks/totalBlocks ratio
      // and scale by a typical block capacity. For a rough estimate, we store
      // block counts directly — the frontend can compute usage %.
      prefixCacheTokensUsed = cachedBlocks * 16;
      prefixCacheMaxTokens = totalBlocks * 16;
    } else {
      // Fallback for older vLLM builds (e.g. Atlas/vllm-dflash2) that don't
      // expose block-count gauges. Use the KV cache usage percentage × the
      // max model length as a rough proxy.  16 bytes/token (FP8 KV) is the
      // per-token KV cache footprint per sequence.
      if (kvUsagePct != null) {
        prefixCacheMaxTokens = 262144 * 8;     // rough max tokens * 16 bytes / 2
        prefixCacheTokensUsed = Math.round((kvUsagePct / 100) * prefixCacheMaxTokens);
      }
    }

    // Recent requests — derive from request counters.
    // vllm:request_success_total is a cumulative counter keyed by model and
    // finished_reason. We track the delta between polls to report how many
    // requests completed since the last poll.  We also pull request latency
    // histograms for the latency distribution panel.
    const successTotal = getFirstValue(metrics, 'vllm:request_success_total');
    let completedSinceLast = null;
    if (successTotal != null && this.lastSuccessTotal != null) {
      completedSinceLast = Math.max(0, successTotal - this.lastSuccessTotal);
    }
    this.lastSuccessTotal = successTotal;

    // Request latency histograms — compute rough percentiles from the
    // histogram buckets.  vllm:e2e_request_latency_seconds is a Prometheus
    // histogram with _count and _sum suffixes.  vllm:time_to_first_token_seconds,
    // vllm:inter_token_latency_seconds, etc. follow the same pattern.
    const latencies = this._parseLatencyHistograms(metrics);

    // TTFT — parse vllm:time_to_first_token_seconds histogram
    // Return the median (p50) from the bucket samples in ms.
    // Prometheus histograms are cumulative, so the median can persist
    // indefinitely from a single old request.  Only surface a value when
    // the _count has increased since the last poll (new requests completed).
    // On first poll we show the value; on subsequent polls we show -- unless
    // the count has advanced, proving fresh data exists.
    const ttftCount = getFirstValue(metrics, 'vllm:time_to_first_token_seconds_count');
    let ttftMs = null;
    if (ttftCount != null) {
      const prevCount = this.lastTtftCount;
      this.lastTtftCount = ttftCount;
      // Show value on first poll (prevCount is null) OR when count has advanced.
      if (prevCount === null || ttftCount > prevCount) {
        ttftMs = this._parseLatencyHistogramsForMetric(metrics, 'vllm:time_to_first_token_seconds');
      }
    }

    // E2E — parse vllm:e2e_request_latency_seconds histogram (p50 median in ms).
    // This is needed as the base for the ITL calculation.
    const e2eMs = this._parseLatencyHistogramsForMetric(metrics, 'vllm:e2e_request_latency_seconds');

    // Inter-Token Latency (ITL) — calculated from E2E and TTFT:
    //   ITL = (E2E_total - TTFT_total) / num_output_tokens
    // where num_output_tokens is derived from the delta between consecutive
    // poll snapshots: output_tokens_delta / completed_requests.
    // This gives the average time spent per output token across the entire
    // request (after the first token), which is the true inter-token latency.
    let itlMs = null;
    if (e2eMs != null && ttftMs != null) {
      const outputTokensDelta = genTokensTotal != null && genTokensPrev != null && genTokensTotal >= genTokensPrev
        ? Math.max(0, genTokensTotal - genTokensPrev)
        : 0;
      if (outputTokensDelta > 0) {
        const deltaSec = dtSec > 0 ? dtSec : 1;
        const completed = completedSinceLast != null ? completedSinceLast : 1;
        const outputTokensPerRequest = Math.max(1, outputTokensDelta / completed);
        itlMs = (e2eMs - ttftMs) / outputTokensPerRequest;
        // Guard against negative (e.g. if TTFT > E2E due to noise)
        if (itlMs < 0) itlMs = 0;
      }
    }

    return {
      at: now,
      ok: true,
      kvCachePct: kvUsagePct,
      numRunning: numRunning != null ? numRunning : 0,
      numWaiting: numWaiting != null ? numWaiting : 0,
      promptTokS,
      genTokS,
      promptTokensTotal,
      genTokensTotal,
      prefixCacheHits: cacheHits,
      prefixCacheQueries: cacheQueries,
      prefixCacheHitRate: hitRate,
      uptime: uptimeMs,
      // Context Fill data
      prefixCacheTokensUsed,
      prefixCacheMaxTokens,
      // Recent Requests
      completedSinceLast,
      // Latency Distribution
      latencies,
      // Performance metrics
      ttftMs,
      itlMs,
    };
  }

  _buildErrorSnapshot(err) {
    return {
      at: Date.now(),
      ok: false,
      error: (err && err.message) ? err.message : String(err),
      kvCachePct: null,
      numRunning: null,
      numWaiting: null,
      promptTokS: null,
      genTokS: null,
      promptTokensTotal: null,
      genTokensTotal: null,
      prefixCacheHits: null,
      prefixCacheQueries: null,
      prefixCacheHitRate: null,
      uptime: null,
      prefixCacheTokensUsed: null,
      prefixCacheMaxTokens: null,
      completedSinceLast: null,
      latencies: [],
      ttftMs: null,
      itlMs: null,
    };
  }
}

module.exports = { MetricsPoller, parsePrometheus };
