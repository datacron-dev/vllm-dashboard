# HANDOFF — vLLM Dashboard

## What we did this session

1. **Diagnosed the 20K context compaction** on Perplexity portable computer (PPLX 27B on DGX Spark)
   - Root cause: the app's internal context budget, NOT vLLM or hardware
   - vLLM is configured for `--max-model-len 262144` (model's native limit)
   - Model: Qwen3_5, 64 layers, FP8 mixed-precision, FP8 KV cache, dflash speculative decoding
   - The app sends ~20K tokens per request regardless of model capability

2. **Tuned vLLM flags** for the DGX Spark (128 GB unified memory):
   - `--gpu-memory-utilization 0.85` (was 0.65)
   - `--max-num-seqs 6` (was 4) — supports 1 main + up to 5 spawn_agents
   - `--kv-cache-dtype fp8` — halves KV cache memory (128 KB/token vs 256 KB)
   - `--enable-prefix-caching` — caches system prompt across sequences
   - `--enable-chunked-prefill` — smoother latency on long prompts
   - `--generation-config` — uses model's intended sampling params
   - Full docker command in [PLAN.md](./PLAN.md)

3. **Scoped a new project**: Electron app "vLLM Dashboard"
   - Shows: server health, KV cache %, throughput (tok/s), prefix cache hit rate, live logs
   - Inspired by vLLM-Playground UI (see reference screenshots)
   - Plain Electron + vanilla JS, no React
   - Full plan in [PLAN.md](./PLAN.md)

## What's next

- Scaffold the Electron app (Milestone 1 in PLAN.md)
- Metrics polling against `http://127.0.0.1:8000/metrics`
- Log tailing via `docker logs -f my-vllm`
- Package as .AppImage via electron-builder

## Key paths

| Item | Path |
|---|---|
| Project root | `/home/ai-dev/dev-team/projects/vllm-dashboard/` |
| Model | `/home/ai-dev/.local/share/perplexity-rpc-server/local-models/models--perplexity-ai--pplx-computer-qwen-3-8-27b-dflash2-20260824/` |
| vLLM container name | `my-vllm` (or `pplx-computer-vllm-XXXXX` for the app-managed one) |
| Perplexity settings | `/home/ai-dev/.config/Perplexity/user-settings.json` |
| vLLM API | `http://127.0.0.1:8000/v1` |
| vLLM metrics | `http://127.0.0.1:8000/metrics` |

## Open questions

- Should the dashboard also show GPU memory utilization (nvidia-smi)?
- Historical graphs (time-series) or just current values?
- Multi-server support or single-endpoint only?
