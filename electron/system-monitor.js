'use strict';

const { EventEmitter } = require('events');
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// SystemMonitor — poll nvidia-smi + /proc/meminfo for GPU/system telemetry.
//
// Emits:
//   'update' -> {
//     at: epoch ms,
//     ok: boolean,
//     error: string|null,
//     gpu: {
//       name: string,           // e.g. "NVIDIA GB10"
//       driverVersion: string,  // e.g. "580.159.03"
//       temperatureC: number,   // e.g. 64
//       powerW: number,         // e.g. 37.8
//       clockMhz: number,       // e.g. 2437
//       utilizationPct: number, // e.g. 94
//       memoryUsedMiB: number|null,  // null on GB10 (unified memory)
//       memoryTotalMiB: number|null, // null on GB10
//       memoryFreeMiB: number|null,
//     },
//     system: {
//       os: string,             // e.g. "Linux"
//       arch: string,           // e.g. "aarch64"
//       kernel: string,         // e.g. "6.17.0-1021-nvidia"
//       hostname: string,       // e.g. "skynet"
//       cpuModel: string,       // e.g. "ARM Cortex-A78 (GB10)"
//       cpuCores: number,       // e.g. 20
//       memTotalGiB: number,    // e.g. 121.7
//       memAvailableGiB: number,// e.g. 22.9
//     },
//   }
//
// On GB10 (unified memory), nvidia-smi reports memory.total/used/free as N/A.
// We fall back to /proc/meminfo for total/available, and use vLLM's
// cache_config_info metric (if available) for the vLLM-specific allocation.
// ---------------------------------------------------------------------------

const NVSMI_FIELDS = [
  'name',
  'driver_version',
  'temperature.gpu',
  'power.draw',
  'clocks.current.graphics',
  'utilization.gpu',
  'memory.total',
  'memory.used',
  'memory.free',
].join(',');

// Poll interval for the system monitor (separate from the vLLM metrics poller).
const DEFAULT_INTERVAL_MS = 3000;

class SystemMonitor extends EventEmitter {
  constructor({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.last = null;
  }

  start() {
    this._poll();
    this.timer = setInterval(() => this._poll(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _poll() {
    const now = Date.now();
    const [gpuResult, systemResult] = await Promise.all([
      this._queryNvidiaSmi(),
      this._querySystemInfo(),
    ]);

    const snapshot = {
      at: now,
      ok: true,
      error: null,
      gpu: gpuResult,
      system: systemResult,
    };

    // If nvidia-smi failed entirely, mark the snapshot as degraded.
    if (gpuResult.error && !gpuResult.name) {
      snapshot.ok = false;
      snapshot.error = gpuResult.error;
    }

    this.last = snapshot;
    this.emit('update', snapshot);
  }

  // -----------------------------------------------------------------------
  // nvidia-smi
  // -----------------------------------------------------------------------
  async _queryNvidiaSmi() {
    const result = {
      name: null,
      driverVersion: null,
      temperatureC: null,
      powerW: null,
      clockMhz: null,
      utilizationPct: null,
      memoryUsedMiB: null,
      memoryTotalMiB: null,
      memoryFreeMiB: null,
      error: null,
    };

    const proc = exec(
      `nvidia-smi --query-gpu=${NVSMI_FIELDS} --format=csv,noheader,nounits`,
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          result.error = (stderr || error.message || '').trim().split('\n')[0];
          return;
        }
        const lines = stdout.trim().split('\n');
        if (lines.length < 1 || !lines[0]) {
          result.error = 'nvidia-smi returned no data';
          return;
        }
        // Parse the first GPU (line 0). Fields are comma-separated.
        const parts = lines[0].split(',').map((s) => s.trim());
        // Expected order matches NVSMI_FIELDS:
        // 0=name, 1=driver_version, 2=temperature.gpu, 3=power.draw,
        // 4=clocks.current.graphics, 5=utilization.gpu,
        // 6=memory.total, 7=memory.used, 8=memory.free
        result.name = parts[0] || null;
        result.driverVersion = parts[1] || null;
        result.temperatureC = parseNum(parts[2]);
        result.powerW = parseNum(parts[3]);
        result.clockMhz = parseNum(parts[4]);
        result.utilizationPct = parseNum(parts[5]);
        result.memoryTotalMiB = parseNum(parts[6]);
        result.memoryUsedMiB = parseNum(parts[7]);
        result.memoryFreeMiB = parseNum(parts[8]);
      },
    );

    // Wait for the exec callback (synchronous-style via Promise).
    await new Promise((resolve) => {
      const origCb = proc.on;
      // exec's callback fires on exit; just await the process.
      proc.on('close', resolve);
      // Safety: also resolve on error.
      proc.on('error', resolve);
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // System info
  // -----------------------------------------------------------------------
  _querySystemInfo() {
    const result = {
      os: 'unknown',
      arch: 'unknown',
      kernel: 'unknown',
      hostname: 'unknown',
      cpuModel: 'unknown',
      cpuCores: 0,
      memTotalGiB: 0,
      memAvailableGiB: 0,
    };

    try {
      result.os = os.type() || 'unknown';
      result.arch = os.arch() || 'unknown';
      result.kernel = os.release() || 'unknown';
      result.hostname = os.hostname() || 'unknown';
      result.cpuCores = os.cpus().length || 0;
    } catch (_) { /* os module is always available in Node */ }

    // CPU model: on ARM (GB10), /proc/cpuinfo doesn't have "Model name".
    // Use the CPU part number to identify the chip.
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const modelMatch = cpuinfo.match(/Model name\s*:\s*(.+)/i);
      if (modelMatch) {
        result.cpuModel = modelMatch[1].trim();
      } else {
        // ARM: use CPU part number
        const partMatch = cpuinfo.match(/CPU part\s*:\s*(0x[0-9a-f]+)/i);
        if (partMatch) {
          result.cpuModel = armPartName(partMatch[1].trim());
        } else {
          result.cpuModel = 'ARM (unknown)';
        }
      }
    } catch (_) {
      result.cpuModel = 'unknown';
    }

    // Memory from /proc/meminfo (unified memory on GB10).
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (totalMatch) result.memTotalGiB = Math.round(parseInt(totalMatch[1], 10) / 1024 / 1024 * 10) / 10;
      if (availMatch) result.memAvailableGiB = Math.round(parseInt(availMatch[1], 10) / 1024 / 1024 * 10) / 10;
    } catch (_) {
      result.memTotalGiB = 0;
      result.memAvailableGiB = 0;
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNum(s) {
  if (s == null) return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// Map ARM CPU part numbers to human-readable names.
function armPartName(partHex) {
  const known = {
    '0xd87': 'Cortex-X4 (GB10)',
    '0xd88': 'Cortex-X4 (GB10)',
    '0xd89': 'Cortex-X4 (GB10)',
    '0xd49': 'Cortex-X3 (Orin)',
    '0xd4a': 'Cortex-X3 (Orin)',
    '0xd4b': 'Cortex-X3 (Orin)',
    '0xd4e': 'Cortex-A78 (Orin)',
    '0xd4f': 'Cortex-A78 (Orin)',
  };
  return known[partHex] || `ARM ${partHex}`;
}

module.exports = { SystemMonitor };
