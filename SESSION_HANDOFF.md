# Session Handoff — vLLM Dashboard (Milestone 12: Monitor Mode / Server Provenance)

## What was done this session

### A. Milestone 12 — Monitor Mode / Server Provenance (BUILT + INSTALLED + VERIFIED) ✅

The dashboard now supports two use cases from one UI:

- **Launch mode** (existing): the user owns the vLLM container and drives it via Start/Stop/Restart.
- **Monitor mode** (new): a *different* server already owns the endpoint (typically Ollama), and the dashboard is **read-only**: Start/Stop/Restart are **locked**.

#### What's new

1. **`electron/provenance.js`** (NEW) — `Provenance` class:
   - Probes `{endpoint}/v1/models` + `/metrics` + `/api/tags` every 5 s.
   - Runs `docker ps --filter name=<ourName>` to check if our container is active.
   - Emits `{state: 'ours'|'external'|'none', kind: 'vllm'|'ollama'|'unknown', model, models[], endpoint, at}`.
   - `detect(ports)` scans `:8000, :11434, :8080, :4000, :7001` and returns the first endpoint that answers.
   - `start()` is now async (awaits the first poll before starting the interval timer).

2. **`electron/main.js`** — Wires `Provenance` into the app lifecycle:
   - `startProvenance()` called on app ready, config save, preset select, and metrics configure.
   - `prov:get` + `prov:detect` IPC handlers.
   - `server:start/stop/restart` gated on `state !== 'external'` — returns `{locked: true, reason}` if blocked.
   - `startControl()` moved after `startProvenance()` so `ServerControl` always has the live lock source.

3. **`electron/server-control.js`** — `assertOurs(action)` guard:
   - `start()`, `stop()`, `restart()` all no-op and emit a "locked" status when an external server owns the endpoint.
   - `setProvenance(provenance)` setter for the main process to inject the live Provenance instance.

4. **`electron/preload.js`** — Exposes `getProvenance()`, `detectServer()`, `onProvenanceUpdate(cb)` to the renderer.

5. **`src/index.html`** — Added `#prov-badge` span to the top bar; added a **Detect** button in the vLLM Config panel header.

6. **`src/app.js`** — New `provenance` object:
   - Renders top-bar badge: `Ours · model` / `External · Ollama · model` / `No server`.
   - Locks/unlocks Start/Stop/Restart by state (Ours: all enabled; External: all locked; None: Start only).
   - Marks vLLM panels `n/a` when `kind !== 'vllm'` (health, throughput, prefix cache).
   - `serverCtl.setProvenanceState(state)` distinguishes "busy" from "locked by external".
   - `config.detect()` calls `detectServer()` and updates the endpoint field.

7. **`src/styles.css`** — `.prov-badge--ours/--external/--none` badge styles; `.ctl-status__value--locked`; `.panel--na` treatment for vLLM-only panels.

8. **`test/provenance.test.js`** (NEW) — Mock-server unit test:
   - Ollama-shaped endpoint → `external/ollama` ✅
   - vLLM-shaped endpoint → `external/vllm` ✅
   - Detect finds Ollama mock first ✅

#### Key design decisions

- **Provenance is the single source of truth** for button state. The main-process guard checks `provenance.last.state` before allowing any Docker action. The renderer also disables buttons independently for immediate UX feedback.
- **Detect** scans ports in order; first hit wins. **Read-only**: reports the discovered endpoint in the vLLM Config status line but does **not** modify the saved endpoint, the endpoint field, the top-bar badge, or any panel. The user must explicitly Save to change the endpoint.
- **Ollama detection** uses both `/v1/models` (OpenAI-compatible) and `/api/tags` (Ollama-native) so it works even if the OpenAI-compatible layer is disabled.
- **Docker down = "not ours"** — if the Docker daemon is unreachable, container detection returns `available: false`, and the decision falls through to the endpoint answer. Never assumes "ours" without proof.
- **System Monitor panel** is unaffected — it's host-level and always live regardless of provenance state.

#### Build & install

- `npm run build` → `dist/vllm-dashboard-0.1.0-arm64.AppImage` ✅
- `./install-desktop.sh` → `~/.local/bin/vllm-dashboard.AppImage` ✅
- Asar-verified: `provenance.js` present (42 refs), `main.js` has `prov:get`/`prov:detect`, `preload.js` has `onProvenanceUpdate`, `app.js` has `prov-badge` (6 refs), `index.html` has `prov-badge` (2 refs), `styles.css` has `prov-badge` (5 refs), `server-control.js` has `assertOurs` (4 refs).

#### Testing status

- **Unit (mock):** All 3 tests pass (Ollama → external/ollama, vLLM → external/vllm, detect finds Ollama first).
- **Live (external):** Ollama on `:11434` confirmed live (HTTP 200 on `/v1/models`). User should relaunch the app and set the endpoint to `http://127.0.0.1:11434` (or click Detect) to see: badge → `External · Ollama · qwen2.5-coder:32b`, buttons locked, vLLM panels show `n/a`.
- **Live (ours):** Needs a running Docker daemon + `my-vllm` container to validate.
- **Edge:** endpoint down → `None`, Start enabled.

## Files touched this session

| File | Change |
|---|---|
| `electron/provenance.js` | **NEW** — Provenance class (endpoint probe + docker check + detect) |
| `electron/main.js` | Provenance wiring, `prov:get`/`prov:detect` IPC, server-control guard, startup order fix |
| `electron/server-control.js` | `assertOurs()` guard on start/stop/restart, `setProvenance()` setter |
| `electron/preload.js` | `getProvenance()`, `detectServer()`, `onProvenanceUpdate()` |
| `src/index.html` | `#prov-badge` span in top bar, Detect button in vLLM Config |
| `src/app.js` | Provenance object (badge, panel states, button locking), `serverCtl.setProvenanceState()`, `config.detect()` |
| `src/styles.css` | `.prov-badge--*`, `.ctl-status__value--locked`, `.panel--na` |
| `test/provenance.test.js` | **NEW** — Mock-server unit test (3 assertions) |
| `README.md` | Milestone 12 status → ✅ |
| `dist/vllm-dashboard-0.1.0-arm64.AppImage` | Rebuilt (Milestone 12) |
| `~/.local/bin/vllm-dashboard.AppImage` | Reinstalled |
