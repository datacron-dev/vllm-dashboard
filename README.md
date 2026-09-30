# vLLM Dashboard

Lightweight Electron app for monitoring a local vLLM server on DGX Spark.

Shows: server health, KV cache usage, throughput (tok/s), prefix cache hit rate, and live server logs.

## Quick Start

```bash
npm install
npm start
```

## Configuration

Edit `electron/main.js` → `SETTINGS` object, or use the settings panel (coming soon):

```js
const SETTINGS = {
  vllmEndpoint: 'http://127.0.0.1:8000',
  pollIntervalMs: 2000,
  logSource: 'docker',          // 'docker' | 'file'
  dockerContainer: 'my-vllm',
  logFile: '/var/log/vllm.log', // used when logSource === 'file'
};
```

## Tuned vLLM Server Flags

See [PLAN.md](./PLAN.md) for the full docker run command with tuned flags
(`--gpu-memory-utilization 0.80`, `--max-num-seqs 6`, `--kv-cache-dtype fp8`,
`--enable-prefix-caching`, `--enable-chunked-prefill`, dflash speculative decoding).

> **Memory headroom on DGX Spark (122 GB unified):** vLLM's total footprint is the
> sum of model weights + KV-cache reservation + CUDA/flashinfer/NCCL buffers + the
> dflash draft model. At `--gpu-memory-utilization 0.85` the process lands at
> ~117 GB / 122 GB — too tight. `0.80` trims the KV reservation by ~6 GiB, landing
> at ~110–111 GB total and leaving ~12 GiB headroom for the OS and other processes.
> The KV cache still holds ~7 M tokens (~11% fewer blocks than 0.85), which is
> plenty for `--max-model-len 262144` with `--max-num-seqs 6`.

## Build

```bash
npm run build    # produces .AppImage in ./dist
```

## Project Layout

```
vllm-dashboard/
├── package.json
├── electron/
│   ├── main.js              # Electron main process: window, IPC, settings, lifecycle
│   ├── preload.js           # Context bridge for renderer
│   ├── metrics.js           # Poll /metrics, parse Prometheus, compute deltas
│   ├── logs.js              # Tail docker logs or a log file, emit lines via IPC
│   └── server-control.js    # Start / stop / restart the vLLM container
├── src/
│   ├── index.html           # Single-page layout (top bar + 6-panel grid)
│   ├── styles.css           # Dark theme (default) + light theme, panel grid
│   └── app.js               # Renderer: render panels, handle IPC events
└── assets/
    └── icon.png             # App icon
```

## Panels

| Panel | Purpose |
|---|---|
| **Server Control** | Start / Stop / Restart the vLLM container via Docker. Status badge + last-action log. |
| **Server Health** | KV cache usage bar, running/waiting request counts, last `/metrics` fetch time. |
| **Throughput** | Prompt + generation tok/s (delta over poll interval). |
| **Prefix Cache** | Hit rate (%) from `vllm:prefix_cache_hits/misses`. |
| **Server Logs** | Live tail of `docker logs -f` (or file). Color-coded, auto-scroll, collapsible. |
| **vLLM Config** | Editable launch command (docker run + vllm serve flags), endpoint, and model preset. Save to `config.json`. |
| **System Monitor** | Live GPU + system telemetry: GPU name/util/clock/temp/power/VRAM, OS/arch/CPU/RAM/kernel. Polls `nvidia-smi` + `/proc` every 3 s. On GB10 (unified memory), VRAM falls back to system RAM. |

## Configuration

Settings are persisted to `~/Library/Application Support/vllm-dashboard/vllm-dashboard-config.json`
(macOS) or `~/.config/vllm-dashboard/vllm-dashboard-config.json` (Linux).

You can edit them live in the **vLLM Config** panel, or pre-populate by creating the file:

```json
{
  "vllmEndpoint": "http://127.0.0.1:8000",
  "vllmCommand": "docker run -d ... vllm serve ...",
  "logSource": "docker",
  "dockerContainer": "my-vllm",
  "logFile": "/var/log/vllm.log",
  "pollIntervalMs": 2000
}
```

The default `vllmCommand` mirrors the tuned vLLM server in [PLAN.md](./PLAN.md).

## Build & Package

```bash
npm install          # install electron + electron-builder
npm run build        # produces dist/vllm-dashboard-0.1.0-arm64.AppImage
npm run build:dir    # (optional) produces dist/linux-arm64-unpacked/ (no AppImage wrapper)
```

The AppImage is self-contained: it bundles Electron, the app, and the icon.
Run it with:

```bash
./dist/vllm-dashboard-0.1.0-arm64.AppImage
```

## Install as a Desktop Application

After building, run the installer:

```bash
./install-desktop.sh
```

This:
1. Copies the AppImage to `~/.local/bin/vllm-dashboard.AppImage` (stable, on PATH)
2. Copies the vLLM-Playground SVG icon to `~/.local/share/icons/vllm-dashboard.svg`
3. Writes a `.desktop` launcher to `~/.local/share/applications/vllm-dashboard.desktop`
4. Installs a wrapper script at `~/.local/bin/vllm-dashboard`
5. Refreshes the desktop database so the app appears in the application menu

The launcher uses the vLLM-Playground "V" mark (the two-triangle amber/blue icon)
as its icon, matching the reference app.

### Launch flags (baked into the launcher)

The `.desktop` entry and the wrapper script both pass two flags automatically:

| Flag | Why |
|---|---|
| `--no-sandbox` | Electron's SUID `chrome-sandbox` helper is not root-owned inside an AppImage. Disabling the OS-level sandbox is safe here: the renderer is already isolated via `contextIsolation` + `sandbox:true` (V8/Node isolation), and the app only talks to a local vLLM endpoint + Docker. |
| `--disable-gpu` | The GPU process crashes on headless/SSH sessions (no usable GPU). Software rendering is sufficient for a DOM-based dashboard. |

If you ever want to force GPU on (e.g. on a machine with a working display),
set `VLLM_DASHBOARD_GPU=1` in your environment — `main.js` will skip the
auto-disable in that case.

## Icon

The app icon is the vLLM-Playground "V" mark (two triangles: amber `#FDB515` + blue `#30A2FF`),
rendered from the SVG at `/home/ai-dev/.local/share/icons/vllm-Playground.svg` to a 512×512 PNG
via `assets/render-icon.js` (no external dependencies — pure Node rasterizer).

## Tuned vLLM Server Flags

See [PLAN.md](./PLAN.md) for the full docker run command with tuned flags
(`--gpu-memory-utilization 0.80`, `--max-num-seqs 6`, `--kv-cache-dtype fp8`,
`--enable-prefix-caching`, `--enable-chunked-prefill`, dflash speculative decoding).

## Tuned vLLM Server Flags

See [PLAN.md](./PLAN.md) for the full docker run command with tuned flags
(`--gpu-memory-utilization 0.80`, `--max-num-seqs 6`, `--kv-cache-dtype fp8`,
`--enable-prefix-caching`, `--enable-chunked-prefill`, dflash speculative decoding).

> **Note:** The `vllm-dflash2:lmheadfix` image already sets `ENTRYPOINT ["vllm", "serve"]`.
> The saved launch command therefore passes *only* the model path and flags as arguments —
> it does **not** repeat `vllm serve`. Repeating the subcommand makes `vllm`'s CLI parser
> reject the container with `error: unrecognized arguments: serve …`.
>
> Likewise, the `--generation-config` flag is omitted: it points at a *file* inside the
> model snapshot, but `vllm`'s `get_config()` treats that argument as a *directory* and
> fails with `ValueError: Invalid repository ID or local directory`. vLLM auto-discovers
> `generation_config.json` from the model directory.

## Status

- ✅ Milestone 1 — Scaffold (Electron window, dark theme, panel grid)
- ✅ Milestone 2 — Metrics polling (KV cache, request counts, endpoint health)
- ✅ Milestone 3 — Throughput (prompt/generation tok/s from deltas)
- ✅ Milestone 4 — Prefix cache hit rate
- ✅ Milestone 5 — Log tailing (docker or file, color-coded, auto-scroll, collapsible)
- ✅ Server control — Start / Stop / Restart the vLLM container from the dashboard
- ✅ vLLM Config — Editable launch command + endpoint, persisted to `config.json`
- ✅ Milestone 7 — electron-builder .AppImage packaging + desktop launcher
- ✅ Milestone 8 — Model preset dropdown (27B dflash2 + Qwen3.6-35B-A3B-FP8)
- ✅ System Monitor — Live GPU + system telemetry (nvidia-smi + /proc polling)
- ✅ Milestone 12 — Monitor Mode / server provenance. Provenance badge in the
  top bar (Ours / External / No server), Start/Stop/Restart locked while an
  external server owns the endpoint, Detect button scans common ports,
  vLLM-only panels show `n/a` when the active server is not vLLM.
- ⏳ Milestone 6 — Full settings panel (poll interval, log source toggles in UI)
- ⏳ Milestone 9 — Per-session token counter
- ⏳ Milestone 10 — Session list with per-session context/token counts

## Known vLLM metric names (for debugging)

The dashboard reads these Prometheus metrics from `GET /metrics` (NOT `/v1/metrics`):

| Panel | Metric | Notes |
|---|---|---|
| KV cache | `vllm:kv_cache_usage_perc` | fraction 0..1; legacy `vllm:gpu_cache_usage` also accepted |
| Requests | `vllm:num_requests_running` / `vllm:num_requests_waiting` | |
| Throughput | `vllm:prompt_tokens_total` / `vllm:generation_tokens_total` | tok/s computed as delta over poll interval |
| Prefix cache | `vllm:prefix_cache_hits_total` / `vllm:prefix_cache_queries_total` | hit rate = hits / queries × 100 |

If a panel shows `--` while the server is healthy, check that:
1. The endpoint in the **vLLM Config** panel is `http://127.0.0.1:8000` (the
   `/v1` suffix is optional — the poller strips it automatically).
2. `curl http://127.0.0.1:8000/metrics` returns 200 (not 404).
3. The metric names above match what your vLLM build exposes (`grep -E '^(vllm|process):'` on the output).

## Generation throughput on DGX Spark (27B FP8 + dflash)

A single-stream decode on a 27B FP8 model with dflash speculative decoding
lands at **~20–30 tok/s** on DGX Spark (128 GB unified memory, ~1.5 TB/s
bandwidth). This is expected, not a bug. The vLLM log line
`Mean acceptance length: 3.4, Avg Draft acceptance rate: 35%` confirms the
draft model is only accepting ~1 in 3 drafted tokens — the rest of the work
is wasted. If you want to push higher:

- **Increase `--max-num-seqs`** (currently 6) — batching multiple requests
  recovers throughput even at the cost of per-request latency.
- **Trim `num_speculative_tokens`** in `--speculative-config` (currently 7)
  — the per-position acceptance rate falls off steeply (0.80 → 0.58 → 0.39 →
  0.23 → 0.20 → 0.16 → 0.10). Dropping to 4 saves the low-value draft slots.
- **Raise `--gpu-memory-utilization`** if you have headroom — a larger KV
  cache means more batches can be in flight at once.
