# vLLM Dashboard — Plan

## Overview

Build a lightweight Electron app ("vLLM Dashboard") that monitors a local vLLM server
running the PPLX 27B model on a DGX Spark. Inspired by vLLM-Playground's server
management UI but focused on read-only health/telemetry (no server control).

## Target vLLM Server

Model: `qwen38-27b-dflash2-20260824` (Qwen3_5, 64 layers, FP8 mixed-precision)
Endpoint: `http://127.0.0.1:8000/v1` (OpenAI-compatible API)
Metrics: `http://127.0.0.1:8000/metrics` (Prometheus format)

### Tuned vLLM Flags (for reference)

#### Qwen38-27B-dflash2 (PPLX 27B, current default)

```bash
docker run -d --gpus all --ipc=host \
  -p 127.0.0.1:8000:8000 \
  -v /home/ai-dev/.local/share/perplexity-rpc-server/local-models/models--perplexity-ai--pplx-computer-qwen-3-8-27b-dflash2-20260824:/models/repo:ro \
  -v /home/ai-dev/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm \
  -v /home/ai-dev/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer \
  -v /home/ai-dev/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv \
  --name my-vllm \
  vllm-dflash2:lmheadfix \
  /models/repo/snapshots/f1cb0e1cb8dba5876a51b44f276c2143adf7f27c \
    --served-model-name qwen38-27b-dflash2-20260824 \
    --host 0.0.0.0 --port 8000 \
    --gpu-memory-utilization 0.80 \
    --max-model-len 262144 \
    --max-num-seqs 6 \
    --max-num-batched-tokens 8192 \
    --enable-prefix-caching \
    --enable-chunked-prefill \
    --async-scheduling \
    --kv-cache-dtype fp8 \
    --speculative-config '{"method":"dflash","model":"/models/repo/snapshots/f1cb0e1cb8dba5876a51b44f276c2143adf7f27c/draft","num_speculative_tokens":7}' \
    --reasoning-parser qwen3 \
    --tool-call-parser qwen3_coder \
    --enable-auto-tool-choice
```

#### Qwen3.6-35B-A3B-FP8 (Qwen3.6, MoE 35B/3B active, FP8)

```bash
docker run -d --gpus all --ipc=host \
  -p 127.0.0.1:8000:8000 \
  -v /home/ai-dev/models/Qwen3.6-35B-A3B-FP8:/models/qwen36:ro \
  -v /home/ai-dev/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm \
  -v /home/ai-dev/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer \
  -v /home/ai-dev/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv \
  --name my-vllm \
  vllm-dflash2:lmheadfix \
  /models/qwen36 \
    --served-model-name qwen3.6-35b-a3b-fp8 \
    --host 0.0.0.0 --port 8000 \
    --gpu-memory-utilization 0.85 \
    --max-model-len 262144 \
    --max-num-seqs 6 \
    --max-num-batched-tokens 8192 \
    --enable-prefix-caching \
    --enable-chunked-prefill \
    --async-scheduling \
    --kv-cache-dtype fp8 \
    --speculative-config '{"method":"mtp","num_speculative_tokens":1}' \
    --reasoning-parser qwen3 \
    --tool-call-parser qwen3_xml \
    --enable-auto-tool-choice
```

**Flag rationale for Qwen3.6-35B-A3B-FP8:**

| Flag | Value | Why |
|---|---|---|
| `--gpu-memory-utilization` | `0.85` | 35B FP8 ≈ 35 GB weights + ~1 GB MTP draft = ~36 GB. At 0.85 × 121.69 GiB = 103.4 GiB reserved, leaving ~18 GiB headroom. More headroom than the 27B dflash2 (which needed 0.80 because dflash draft + NCCL buffers pushed it to ~117 GB). |
| `--max-model-len` | `262144` | Model's native `max_position_embeddings` is 262144 (256K). No need to cap it. |
| `--max-num-seqs` | `6` | Same as 27B — supports 1 main + up to 5 spawn_agents. MoE models batch well; can raise to 8–12 if concurrency is needed. |
| `--kv-cache-dtype` | `fp8` | Halves KV cache memory (128 KB/token vs 256 KB). The model's `dtype` is `bfloat16` but the KV cache can still be quantised to FP8 without quality loss. |
| `--speculative-config` | `{"method":"mtp","num_speculative_tokens":1}` | The model ships an MTP head (`mtp_num_hidden_layers: 1`, `mtp.safetensors` in the model dir). vLLM 0.27.2+ supports `qwen3_5_mtp` natively — no separate draft model path needed. `num_speculative_tokens: 1` matches `mtp_num_hidden_layers: 1` (one MTP layer = one draft token per step). |
| `--tool-call-parser` | `qwen3_xml` | Qwen3.6 uses XML-style tool calls (not the `qwen3_coder` JSON style the 27B uses). |
| `--reasoning-parser` | `qwen3` | Same as 27B — Qwen3.6 uses the same `think`/`/think` reasoning markers. |
| No `--generation-config` | — | The model's `generation_config.json` has `temperature: 0.6, top_k: 20, top_p: 0.95`. vLLM auto-discovers it from the model directory. Do **not** pass `--generation-config` explicitly (vLLM's `get_config()` treats it as a directory and fails with `Invalid repository ID`). |
| No `--attention-backend` | — | Default (flashinfer) is correct for this model. The user's private setup used `flashinfer` explicitly; the docker image defaults to it. |
| No `--load-format` | — | Default `auto` works. The user's private setup used `fastsafetensors` for the local venv; the docker image's default loader handles the 40-layer sharded safetensors fine. |
| No `VLLM_USE_DEEP_GEMM=0` | — | That env var was for the local venv's Triton/GEMM backend. The docker image's CUDA build doesn't need it. |

## Features (MVP)

### 1. Server Health Panel
- **Status indicator** — green/red dot + "Server Running" / "Server Stopped"
  - Poll `GET /v1/models` every 5s; 200 = running, 4xx/5xx/connection-refused = stopped
- **KV Cache usage** — percentage bar
  - From `/metrics`: `vllm:gpu_cache_usage_zscore` or
    `vllm:num_requests_waiting` + `vllm:num_requests_running` vs `--max-num-seqs`
  - Alternative: `vllm:gpu_memory_usage` if exposed
- **Requests** — `running / waiting` (e.g. "3/6")
  - `vllm:num_requests_running` and `vllm:num_requests_waiting`

### 2. Throughput Panel
- **Prompt tok/s** — prefill throughput
  - Compute from `vllm:prompt_tokens_total` delta over polling interval
- **Generation tok/s** — decode throughput
  - Compute from `vllm:generation_tokens_total` delta over polling interval
- Show as large numerals with "tok/s" suffix (matching reference UI)

### 3. Prefix Cache Panel
- **Hit Rate** — percentage
  - `vllm:prefix_cache_hits` / (`vllm:prefix_cache_hits` + `vllm:prefix_cache_misses`) × 100
  - If metrics not available, show "--"

### 4. Server Logs Panel
- Tail vLLM container logs in real-time
  - `docker logs -f my-vllm --tail 200` (or read from a log file if not using Docker)
  - Monospace, scrollable, auto-scroll toggle
  - Color-code: INFO=white, WARN=yellow, ERROR=red
- Collapsible panel (toggle open/closed)

### 5. Top Bar
- App title: "vLLM Dashboard"
- Server endpoint: `http://127.0.0.1:8000` (configurable via settings)
- Connection status badge (Docker / Direct)
- Server running/stopped indicator
- Dark/light theme toggle

## Architecture

```
vllm-dashboard/
├── package.json
├── electron/
│   ├── main.js              # Electron main process: window, IPC, log tailing
│   ├── preload.js           # Context bridge for renderer
│   └── metrics.js           # Poll /metrics, parse Prometheus, compute deltas
├── src/
│   ├── index.html           # Single-page layout
│   ├── styles.css           # Dark theme, panel grid
│   ├── app.js               # Renderer: render panels, handle IPC events
│   └── components/
│       ├── health.js        # Server health panel
│       ├── throughput.js    # Throughput panel
│       ├── prefix-cache.js  # Prefix cache panel
│       └── logs.js          # Server logs panel
├── assets/
│   └── icon.png             # App icon
└── README.md
```

### Data Flow

```
vLLM /metrics (Prometheus)
       │
       ▼
  metrics.js (main process)
  - poll every 2s
  - parse text format
  - compute deltas (tok/s, hit rate)
       │
       ▼
  IPC → renderer (app.js)
       │
       ▼
  Panels re-render (no React, vanilla JS)
```

### Log Tailing

- Main process spawns `docker logs -f my-vllm --tail 200`
- Pipes stdout to renderer via IPC (throttled to 50 lines/sec max)
- If not in Docker mode: read from a log file path (user-configurable)

## Tech Choices

| Decision | Choice | Why |
|---|---|---|
| Framework | Electron (plain) | Matches vLLM-Playground, no build step needed |
| UI | Vanilla JS + CSS | No React/Vue overhead; 4 panels is simple enough |
| Metrics parsing | `prometheus-parsing` npm pkg | Handles Prometheus text format |
| Log tailing | `child_process.spawn` | `docker logs -f` is the most reliable source |
| Packaging | `electron-builder` | Produces .AppImage for Linux |
| Theme | CSS custom properties, dark default | Matches reference screenshots |

## Milestones

1. **Scaffold** — Electron window, dark theme, panel grid layout
2. **Metrics polling** — Fetch `/metrics`, parse, display KV cache + request counts
3. **Throughput** — Compute token deltas, display tok/s
4. **Prefix cache** — Hit rate from metrics
5. **Log tailing** — Docker log stream into scrollable panel
6. **Settings** — Endpoint URL, poll interval, log source (Docker vs file)
7. **Packaging** — electron-builder .AppImage

### Next features (post-MVP)

8. **Model selector dropdown** — pick between pre-tuned model presets
   (Qwen38-27B-dflash2, Qwen3.6-35B-FP8, …) in the vLLM Config panel;
   selecting swaps the saved `vllmCommand` to that model's preset.
9. **Session token counter** — show cumulative prompt + generation tokens
   since the container last started ("this session").
10. **Session list** — table of past sessions (per container lifetime)
    with start/end time, total tokens, peak concurrency, avg tok/s.
    Persisted to `~/.config/vllm-dashboard/sessions.json`.
11. **System Monitor panel** — live GPU + system telemetry (nvidia-smi + /proc). ✅ done.
12. **Monitor mode / server provenance** — see below.

## Monitor Mode & Server Provenance (Milestone 12)

The dashboard must serve two use cases from one UI:

- **Launch mode** (existing): the user owns the vLLM container
  (`my-vllm` or a preset's `--name`) and drives it via Start/Stop/Restart.
- **Monitor mode** (new): a *different* server already owns the endpoint —
  typically the Perplexity portable computer's built-in local-model server —
  and the dashboard is **read-only**: it shows machine + server telemetry,
  and the Start/Stop/Restart buttons are **locked** until that external
  server stops.

### Provenance model (agreed)

- **Active server = whatever answers on the saved endpoint.** We do not need
  to know *who* launched it, only *what* it serves.
- **Ours vs External by Docker container name.** If a container with the
  dashboard's known name (`my-vllm`, or the preset's `--name`) is running,
  the endpoint is **ours**. If *something else* is answering the endpoint
  with no matching container, it's **external** (e.g. Perplexity built-in).
- Display a **provenance badge** in the top bar: `Ours · <model>` or
  `External · <model> · (Ollama|vLLM|unknown)`.

### The key real-world finding (tested live, 2026-09-22)

The Perplexity portable computer's local model is **Ollama on `:11434`**,
*not* vLLM. Confirmed:
- `GET /v1/models` → **200** (OpenAI-compatible): `qwen2.5-coder:32b`,
  `deepseek-r1:32b`, `qwen2.5:32b`, `qwen2.5vl:32b` (all 32B, GGUF Q4_K_M).
- `GET /metrics` → **404** — Ollama does **not** expose Prometheus metrics.
- Ollama is a native binary (no Docker container), so **container-name
  detection will always report it as external** — which is correct.

**Consequence:** the vLLM-specific panels (KV cache, throughput, prefix cache)
cannot populate against Ollama. Monitor mode must therefore:
1. Detect the server **type** (`/metrics` reachable → vLLM; else if `/v1/models`
   or `/api/tags` reachable → Ollama; else → unknown).
2. Populate **only what's available**:
   - **Machine telemetry** (System Monitor panel) — always works, host-level.
   - **Server identity** — model name(s) from `/v1/models` (works for both
     vLLM and Ollama).
   - **vLLM panels** — show a clear `n/a — not a vLLM server` (or
     `unsupported by this server`) instead of a misleading `--`.
3. **Never** attempt Start/Stop/Restart while the endpoint is external.

### State machine (main process, `ServerControl` + new `Provenance`)

```
every poll (reuse the 5s health interval):
  1. probe endpoint:
       GET {endpoint}/v1/models   -> modelList (or null)
       GET {endpoint}/metrics     -> metricsOk (bool, vLLM-only)
  2. docker ps --filter name=<ourName>  -> ourContainerState
  3. decide provenance:
       if ourContainerState in {running,paused,restarting}  => Ours
       else if endpoint answering (modelList or metricsOk)  => External
       else                                                 => None
  4. emit 'provenance' -> { state:'ours'|'external'|'none',
                            kind:'vllm'|'ollama'|'unknown',
                            model, models[], at }
```

The endpoint the poller uses is the **saved endpoint** (`vllmEndpoint`).
Add a **"Detect"** button (Monitor mode) that scans a small port list
(`:40181`, `:8000`, `:8080`, `:4000`, `:7001`, `:11434` — vLLM ports first,
Ollama last) plus any Docker-discovered host ports, and **reports** the first
endpoint that answers `/v1/models` or `/metrics` in the vLLM Config status
line. **Detect is read-only**: it does **not** modify the saved endpoint,
the endpoint field, the top-bar badge, or any panel state. The user must
explicitly edit the endpoint field and click **Save** to change the
monitored endpoint. Keep it to the saved endpoint + an explicit Detect
action (no background scanning).

### UI behavior

- **Top bar provenance badge:** `Ours · qwen38-27b-dflash2` /
  `External · Ollama · qwen2.5-coder:32b` / `No server`.
- **Server Control panel:**
  - `Ours` → Start/Stop/Restart enabled (today's behavior).
  - `External` → Start/Stop/Restart **disabled (locked)** with a hint:
    "External server detected on :11434 (Ollama). Stop it to launch yours."
  - `None` → Start enabled (nothing to conflict with); Stop/Restart disabled.
- **vLLM panels under an external non-vLLM server:** each shows
  `n/a — server is Ollama, not vLLM` (distinct from the `--` "no data" state).
- **System Monitor panel:** always live (host-level, server-independent).

### Files to touch (implementation plan)

| File | Change |
|---|---|
| `electron/provenance.js` | **NEW** — `Provenance` class: probes endpoint + docker, emits `update` with `{state,kind,model,models}` |
| `electron/main.js` | wire `Provenance`, expose `prov:update` + `prov:detect` IPC; gate server-control IPC on `state==='ours'` |
| `electron/server-control.js` | add `assertOurs()` guard so start/stop/restart no-op (and report) when external |
| `electron/preload.js` | `onProvenanceUpdate`, `detectServer()` |
| `src/app.js` | render provenance badge; lock/unlock Server Control buttons; mark vLLM panels `n/a` when `kind==='ollama'` |
| `src/index.html` | top-bar badge span; "Detect" button in Monitor/vLLM Config |
| `src/styles.css` | `.prov-badge--ours/external/none`, `.panel--na` state |

### Testing plan

- **Unit (mock):** point `Provenance` at a local mock HTTP server that serves
  `/v1/models` (Ollama-shaped) and *not* `/metrics`; assert `kind='ollama'`,
  `state='external'`. Point it at a mock that serves both; assert `vllm`.
- **Live (Ollama):** with the portable computer's Ollama on `:11434`, the
  dashboard should badge `External · Ollama`, lock the buttons, and mark the
  vLLM panels `n/a`. (Validates the exact user scenario.)
- **Live (ours):** start `my-vllm`; badge flips to `Ours`, buttons unlock.
- **Edge:** endpoint down → `None`, Start enabled.

### Risks / notes

- Ollama may bind `:11434` only on some launches; the Detect port list should
  stay short and configurable.
- If the user *does* want to launch vLLM while Ollama holds a different port,
  that's fine (different port → no conflict). The lock only triggers when
  **the saved endpoint itself** is external.
- Docker must be reachable for the "ours" check; if the Docker daemon is down,
  treat container detection as "not ours" (never assume ours without proof).

## Out of Scope (MVP)

- Server control (start/stop/restart vLLM)
- Chat interface / model testing
- Multi-server management
- Historical graphs (could add later with a time-series store)
- GPU utilization / memory graphs (nvidia-smi integration) ✅ now covered by Milestone 11
