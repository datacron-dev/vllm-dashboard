'use strict';

// ---------------------------------------------------------------------------
// Model presets — pre-tuned vLLM launch commands for known models.
//
// Each preset is a full docker run command (multi-line, same format as the
// user-editable launch command in the vLLM Config panel). Selecting a preset
// in the dashboard's dropdown swaps the saved `vllmCommand` to this preset.
//
// To add a new preset:
//   1. Add an entry to the PRESETS array below.
//   2. The `id` is used as the <select> option value (must be unique).
//   3. The `label` is displayed in the dropdown.
//   4. The `command` is the full docker run command (multi-line string).
// ---------------------------------------------------------------------------

const PRESETS = [
  // -----------------------------------------------------------------------
  // Qwen3.6-35B-A3B-NVFP4 (NVFP4, MTP-3, qwen3_coder, marlin)
  // Source: recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B — NVFP4, DGX Spark / GB10
  // Default preset.
  // -----------------------------------------------------------------------
  {
    id: 'qwen36-35b-a3b-nvfp4',
    label: 'Qwen3.6-35B-A3B-NVFP4 (NVFP4, MTP-3, qwen3_coder)',
    description: 'NVIDIA ModelOpt NVFP4 MoE 35B/3B, TP1, FlashInfer/Marlin backends, 3-token MTP draft, qwen3_coder tool parser',
    command: [
      // Export VLLM_USE_RUST_FRONTEND=1 for latency/throughput gains under high concurrency.
      'VLLM_USE_RUST_FRONTEND=1 docker run -d --gpus all --ipc=host',
      '  -p 127.0.0.1:8000:8000',
      // Model files.  nvidia/Qwen3.6-35B-A3B-NVFP4 (~21 GB) is NVIDIA\'s ModelOpt re-quant.
      // HuggingFace cache mounted to host so subsequent container restarts are instant.
      '  -v $HOME/.cache/huggingface:/root/.cache/huggingface',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv',
      '  --name my-vllm',
      '  vllm-dflash2:lmheadfix',
      '  nvidia/Qwen3.6-35B-A3B-NVFP4',
      '    --trust-remote-code',
      '    --kv-cache-dtype fp8',
      '    --attention-backend flashinfer',
      '    --moe-backend marlin',
      '    --gpu-memory-utilization 0.65',
      '    --max-model-len 262144',
      '    --max-num-seqs 8',
      '    --max-num-batched-tokens 8192',
      '    --enable-chunked-prefill',
      '    --async-scheduling',
      '    --enable-prefix-caching',
      '    --load-format fastsafetensors',
      '    --enable-auto-tool-choice',
      '    --tool-call-parser qwen3_coder',
      '    --reasoning-parser qwen3',
      '    --mm-encoder-tp-mode data',
      "    --speculative-config '{\"method\":\"mtp\",\"num_speculative_tokens\":3,\"moe_backend\":\"triton\"}'",
    ].join('\n'),
  },
  {
    id: 'nemotron-35-lightning-30b-a3b-nvfp4',
    label: 'Nemotron-3.5-Lightning-30B-A3B-NVFP4 (NVFP4, DSpark-7, mamba)',
    description: 'NVIDIA ModelOpt NVFP4 hybrid Mamba-2/MoE/Attention 30B/3B, TP1, Marlin, FlashInfer, 1M context, DSpark-7 draft, nemotron_v3 parser',
    command: [
      // Export VLLM_USE_RUST_FRONTEND=1 for latency/throughput gains under high concurrency.
      'VLLM_USE_RUST_FRONTEND=1 docker run -d --gpus all --ipc=host',
      '  -p 127.0.0.1:8000:8000',
      // Model files — local path matching the downloaded checkpoint.
      // Users should place their models in $HOME/models/ or adjust these paths.
      '  -v $HOME/models/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4:/models/lightning:ro',
      // DSpark draft model — optional. Remove this mount and the
      // --speculative-config line to run without speculative decoding.
      '  -v $HOME/models/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4-DSpark:/models/lightning-draft:ro',
      '  -v $HOME/.cache/huggingface:/root/.cache/huggingface',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv',
      '  --name my-vllm',
      '  vllm-dflash2:lmheadfix',
      '  /models/lightning',
      // Explicit backends for NVIDIA ModelOpt NVFP4 + Mamba-2 architecture.
      // Matches NVIDIA's official vllm serve flags for DGX Spark (GB10).
      '    --moe-backend marlin',
      '    --mamba-backend flashinfer',
      '    --mamba-cache-mode align',
      '    --mamba-ssm-cache-dtype float16',
      '    --enable-mamba-cache-stochastic-rounding',
      '    --mamba-cache-philox-rounds 5',
      '    --kv-cache-dtype fp8',
      // GB10-specific: --gpu-memory-utilization 0.7 (NVIDIA recommended), --max-num-seqs 4.
      '    --gpu-memory-utilization 0.7',
      '    --tensor-parallel-size 1',
      '    --max-model-len 262144',
      '    --max-num-seqs 6',
      '    --max-num-batched-tokens 8192',
      '    --enable-prefix-caching',
      '    --enable-chunked-prefill',
      '    --async-scheduling',
      '    --load-format fastsafetensors',
      '    --enable-auto-tool-choice',
      '    --tool-call-parser qwen3_xml',
      '    --reasoning-parser nemotron_v3',
      // DSpark speculative decoding — local DSpark draft model with 7 speculative tokens.
      "    --speculative-config '{\"method\":\"dspark\",\"model\":\"/models/lightning-draft\",\"num_speculative_tokens\":7}'",
    ].join('\n'),
  },
  {
    id: 'qwen38-27b-dflash2',
    label: 'Qwen38-27B-dflash2 (PPLX 27B)',
    description: 'PPLX 27B, FP8 mixed-precision, dflash speculative decoding, 64 layers',
    command: [
      'docker run -d --gpus all --ipc=host',
      '  -p 127.0.0.1:8000:8000',
      '  -v $HOME/.local/share/perplexity-rpc-server/local-models/models--perplexity-ai--pplx-computer-qwen-3-8-27b-dflash2-20260824:/models/repo:ro',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv',
      '  --name my-vllm',
      '  vllm-dflash2:lmheadfix',
      '  /models/repo/snapshots/f1cb0e1cb8dba5876a51b44f276c2143adf7f27c',
      '    --served-model-name qwen38-27b-dflash2-20260824',
      '    --host 0.0.0.0 --port 8000',
      '    --gpu-memory-utilization 0.80',
      '    --max-model-len 262144',
      '    --max-num-seqs 6',
      '    --max-num-batched-tokens 8192',
      '    --enable-prefix-caching',
      '    --enable-chunked-prefill',
      '    --async-scheduling',
      '    --kv-cache-dtype fp8',
      "    --speculative-config '{\"method\":\"dflash\",\"model\":\"/models/repo/snapshots/f1cb0e1cb8dba5876a51b44f276c2143adf7f27c/draft\",\"num_speculative_tokens\":7}'",
      '    --reasoning-parser qwen3',
      '    --tool-call-parser qwen3_coder',
      '    --enable-auto-tool-choice',
    ].join('\n'),
  },
  {
    id: 'qwen3.6-35b-a3b-fp8',
    label: 'Qwen3.6-35B-A3B-FP8 (Qwen3.6 MoE)',
    description: 'Qwen3.6, MoE 35B/3B active, FP8, MTP speculative decoding, 40 layers',
    command: [
      'docker run -d --gpus all --ipc=host',
      '  -p 127.0.0.1:8000:8000',
      '  -v $HOME/models/Qwen3.6-35B-A3B-FP8:/models/qwen36:ro',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv',
      '  --name my-vllm',
      '  vllm-dflash2:lmheadfix',
      '  /models/qwen36',
      '    --served-model-name qwen3.6-35b-a3b-fp8',
      '    --host 0.0.0.0 --port 8000',
      '    --gpu-memory-utilization 0.85',
      '    --max-model-len 262144',
      '    --max-num-seqs 6',
      '    --max-num-batched-tokens 8192',
      '    --enable-prefix-caching',
      '    --enable-chunked-prefill',
      '    --async-scheduling',
      '    --kv-cache-dtype fp8',
      "    --speculative-config '{\"method\":\"mtp\",\"num_speculative_tokens\":1}'",
      '    --reasoning-parser qwen3',
      '    --tool-call-parser qwen3_xml',
      '    --enable-auto-tool-choice',
    ].join('\n'),
  },
  // -----------------------------------------------------------------------
  // Qwen3.8-27B-NVFP4 (NVFP4, MTP-3, qwen3_xml)
  // Source: recipes.vllm.ai/Qwen/Qwen3.8-27B — NVFP4, TP1, single GPU
  // Fixed: added --attention-backend flashinfer, --moe-backend marlin,
  //   --trust-remote-code (matching the working Qwen3.6 preset pattern).
  //   Increased --gpu-memory-utilization to 0.45 and reduced MTP from 5→3
  //   to prevent OOM during attention initialisation on GB10.
  // -----------------------------------------------------------------------
  {
    id: 'qwen38-27b-nvfp4',
    label: 'Qwen3.8-27B-NVFP4 (NVFP4, MTP-3, qwen3_xml)',
    description: 'NVIDIA ModelOpt NVFP4, TP1, FlashInfer, 262K context, 3-token MTP draft, fast-safetensors',
    command: [
      // Export VLLM_USE_RUST_FRONTEND=1 for latency/throughput gains under high concurrency.
      'VLLM_USE_RUST_FRONTEND=1 docker run -d --gpus all --ipc=host',
      '  -p 127.0.0.1:8000:8000',
      // Model files.  nvidia/Qwen3.8-27B-NVFP4 (~32 GB) is NVIDIA\'s ModelOpt re-quant.
      // For users who have the model locally, swap the path below.
      // For a clean install vLLM downloads automatically on first serve.
      '  -v $HOME/.cache/huggingface:/root/.cache/huggingface',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv',
      '  --name my-vllm',
      '  vllm-dflash2:lmheadfix',
      '  nvidia/Qwen3.8-27B-NVFP4',
      // Trust remote code & explicit backends — required for NVIDIA custom model files.
      '    --trust-remote-code',
      '    --attention-backend flashinfer',
      '    --moe-backend marlin',
      '    --kv-cache-dtype fp8',
      // Higher GPU memory util (0.45 vs 0.30) + fewer speculative tokens (3 vs 5)
      // to give enough headroom for attention initialisation on GB10 (122 GiB).
      '    --gpu-memory-utilization 0.45',
      '    --max-model-len 262144',
      '    --max-num-seqs 8',
      '    --max-num-batched-tokens 8192',
      '    --enable-chunked-prefill',
      '    --async-scheduling',
      '    --enable-prefix-caching',
      '    --load-format fastsafetensors',
      '    --enable-auto-tool-choice',
      '    --tool-call-parser qwen3_xml',
      '    --reasoning-parser qwen3',
      '    --mm-encoder-tp-mode data',
      "    --speculative-config '{\"method\":\"mtp\",\"num_speculative_tokens\":3}'",
    ].join('\n'),
  },
  // -----------------------------------------------------------------------
  // Gemma-4-26B-A4B-NVFP4 (NVFP4, MTP-4, triton moe_backend, gemma4)
  // Source: recipes.vllm.ai — NVFP4 MoE, TP1, GB10
  // 25.2B total / 3.8B active params, 30 layers, 256K context, multimodal (text + image)
  // Aligned with NVIDIA's official Gemma-4 docker recipe.
  // -----------------------------------------------------------------------
  {
    id: 'gemma4-26b-a4b-nvfp4',
    label: 'Gemma-4-26B-A4B-NVFP4 (NVFP4, MTP-4, triton moe_backend, gemma4)',
    description: 'NVIDIA ModelOpt NVFP4 MoE 25.2B/3.8B, TP1, MTP-4 draft (gemma4-it-assistant), triton moe_backend, gemma4 parsers, 256K context, multimodal',
    command: [
      // Environment variables matching NVIDIA's recipe.
      // VLLM_USE_V2_MODEL_RUNNER=1 enables the newer v2 model runner for improved performance.
      // VLLM_USE_RUST_FRONTEND=1 for latency/throughput gains under high concurrency.
      'VLLM_USE_V2_MODEL_RUNNER=1 VLLM_USE_RUST_FRONTEND=1 docker run -d --gpus all --privileged --ipc=host',
      '  -p 127.0.0.1:8000:8000',
      // Model files — local path matching the downloaded checkpoint.
      // Users should place their models in $HOME/models/ or adjust these paths.
      // Swap to nvidia/Gemma-4-26B-A4B-NVFP4 if using HuggingFace auto-download.
      '  -v $HOME/models/Gemma-4-26B-A4B-NVFP4:/models/gemma4:ro',
      // MTP draft model (Gemma-4 IT Assistant) — optional. Remove this line and the
      // --speculative-config to run without speculative decoding.
      '  -v $HOME/models/gemma4-26B-A4B-it-assistant:/models/gemma4-draft:ro',
      '  -v $HOME/.cache/huggingface:/root/.cache/huggingface',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/vllm:/root/.cache/vllm',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/flashinfer:/root/.cache/flashinfer',
      '  -v $HOME/.local/share/perplexity-rpc-server/vllm-docker/vllm-openai-nightly-aa99034-dflash2/cache/nv:/root/.nv',
      '  --name my-vllm',
      '  vllm-dflash2:lmheadfix',
      '  /models/gemma4',
      // Trust remote code — required for NVIDIA ModelOpt custom model files.
      '    --trust-remote-code',
      // Explicit backends for GB10 (Blackwell) NVFP4.
      // flashinfer for attention, marlin for MoE (or triton via --speculative-config).
      '    --attention-backend flashinfer',
      '    --moe-backend marlin',
      // Chat template — Gemma-4 specific tool chat format for proper tool-calling.
      '    --chat-template /models/gemma4/chat_template.jinja',
      // FP8 KV cache — halves KV cache memory footprint.
      '    --kv-cache-dtype fp8',
      // GB10-specific: --gpu-memory-utilization 0.75, --tensor-parallel-size 1.
      '    --gpu-memory-utilization 0.75',
      '    --tensor-parallel-size 1',
      '    --max-model-len 262144',
      '    --max-num-seqs 8',
      '    --max-num-batched-tokens 8192',
      // Performance flags.
      '    --enable-chunked-prefill',
      '    --async-scheduling',
      '    --enable-prefix-caching',
      '    --load-format fastsafetensors',
      // Tool-calling and reasoning — Gemma-4 native parsers.
      '    --enable-auto-tool-choice',
      '    --tool-call-parser gemma4',
      '    --reasoning-parser gemma4',
      // Multimodal vision encoder — data-parallel TP mode for the vision tower.
      '    --mm-encoder-tp-mode data',
      // MTP speculative decoding — 4 speculative tokens using the local Gemma-4 IT Assistant draft model.
      // moe_backend triton is required for the MTP draft with this model's MoE architecture.
      "    --speculative-config '{\"method\":\"mtp\",\"model\":\"/models/gemma4-draft\",\"num_speculative_tokens\":4,\"moe_backend\":\"triton\"}'",
    ].join('\n'),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a preset by id. Returns null if not found.
 */
function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/**
 * Determine which preset (if any) matches the current launch command.
 * Compares the command (whitespace-normalised) against each preset's command.
 * Returns the preset id, or null if no match.
 */
function matchPresetId(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const normalised = command.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  for (const preset of PRESETS) {
    const presetNormalised = preset.command.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (normalised === presetNormalised) return preset.id;
  }
  return null;
}

module.exports = { PRESETS, findPreset, matchPresetId };
