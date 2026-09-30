'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// LogTailer
// Tails either a Docker container (`docker logs -f <name>`) or a log file.
// Emits:
//   'line'   -> { text, level: 'info'|'warn'|'error'|'debug', at }
//   'status' -> { active: boolean, source: string, detail: string }
//
// Throttling: batches lines so we don't flood the renderer at >50 lines/sec.
// ---------------------------------------------------------------------------
class LogTailer extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.proc = null;
    this.fileStream = null;
    this.fileFd = null;
    this.fileOffset = 0;
    this.fileSize = 0;
    this.active = false;
    this._batch = [];
    this._batchTimer = null;
    this._lastEmitAt = 0;
    this._MAX_BATCH_MS = 100; // at most 10 flushes/sec
    this._MAX_LINES_PER_FLUSH = 50;
    this._pendingStatus = null; // deferred status; flushed at first batch flush
  }

  start() {
    this.stop();
    this.active = true;
    if (this.settings.logSource === 'file') this._startFileTailing();
    else this._startDockerTailing();
  }

  stop() {
    this.active = false;
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
      this.proc = null;
    }
    if (this.fileStream) {
      try { this.fileStream.close(); } catch (_) {}
      this.fileStream = null;
    }
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    if (this._pendingStatus) {
      this.emit('status', this._pendingStatus);
      this._pendingStatus = null;
    }
    this._batch = [];
  }

  // ---- Docker mode -------------------------------------------------------
  _startDockerTailing() {
    const name = this.settings.dockerContainer || 'my-vllm';
    // Defer the "starting" status until we see real data or an error —
    // this avoids races with renderer not having subscribed yet.
    this._pendingStatus = { active: true, source: 'docker', detail: `docker logs -f ${name}` };
    const proc = spawn('docker', ['logs', '-f', '--tail', '200', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    let pending = '';
    let sawContainerNotFound = false;

    proc.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        this._pushLine(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        // Docker returns a "no such container" footer on stderr even when
        // the container doesn't exist yet — don't silence it entirely.
        sawContainerNotFound = true;
        this._pendingStatus = { active: this.active, source: 'docker', detail: text };
        this._flushStatus();
      }
    });
    proc.on('error', (err) => {
      this._pendingStatus = { active: false, source: 'docker', detail: `spawn failed: ${err.message}` };
      this._flushStatus();
      this.active = false;
    });
    proc.on('close', (code) => {
      // Only restart if we never saw a container-not-found message —
      // otherwise the container genuinely exited and will be restarted.
      if (sawContainerNotFound) {
        // Container doesn't exist yet — keep waiting.  Poll every 3 s.
        this._pendingStatus = { active: this.active, source: 'docker', detail: `container not found (waiting); retrying in 3s` };
        this._flushStatus();
        setTimeout(() => { if (this.active) this.start(); }, 3000);
      } else if (this.active) {
        // Container existed but exited — restart tailing.
        this._pendingStatus = { active: this.active, source: 'docker', detail: `exited (${code}); retrying in 3s` };
        this._flushStatus();
        setTimeout(() => { if (this.active) this.start(); }, 3000);
      }
      this.proc = null;
    });
  }

  // ---- File mode ---------------------------------------------------------
  _startFileTailing() {
    const file = this.settings.logFile || '/var/log/vllm.log';
    this._pendingStatus = { active: true, source: 'file', detail: file };
    const doOpen = () => {
      fs.stat(file, (err, stat) => {
        if (err) {
          this._pendingStatus = { active: false, source: 'file', detail: `cannot open ${file}: ${err.message}` };
          setTimeout(() => { if (this.active) doOpen(); }, 3000);
          return;
        }
        this.fileSize = stat.size;
        this.fileOffset = Math.max(0, stat.size - 8 * 1024); // last ~8 KB
        fs.open(file, 'r', (oerr, fd) => {
          if (oerr) {
            this._pendingStatus = { active: false, source: 'file', detail: `open failed: ${oerr.message}` };
            setTimeout(() => { if (this.active) doOpen(); }, 3000);
            return;
          }
          this.fileFd = fd;
          this._readFileChunk();
        });
      });
    };
    doOpen();
  }

  _readFileChunk() {
    if (!this.active || this.fileFd == null) return;
    const buf = Buffer.alloc(64 * 1024);
    fs.read(this.fileFd, buf, 0, buf.length, this.fileOffset, (err, bytes, data) => {
      if (!this.active) return;
      if (err) {
        this.emit('status', { active: false, source: 'file', detail: `read failed: ${err.message}` });
        return;
      }
      if (bytes > 0) {
        this.fileOffset += bytes;
        let text = data.toString('utf8', 0, bytes);
        let idx;
        while ((idx = text.indexOf('\n')) >= 0) {
          this._pushLine(text.slice(0, idx));
          text = text.slice(idx + 1);
        }
        // Keep trailing partial line for the next read.
        this._pendingTail = (this._pendingTail || '') + text;
      }
      // Poll again after a short delay (simple tail loop).
      setTimeout(() => this._readFileChunk(), 500);
    });
  }

  // ---- Line classification + throttling ---------------------------------
  _pushLine(raw) {
    const text = raw.replace(/\s+$/, '');
    if (!text) return;
    // Flush any deferred status line as soon as we have actual data.
    if (this._pendingStatus) {
      this.emit('status', this._pendingStatus);
      this._pendingStatus = null;
    }
    this._batch.push({ text, level: classifyLevel(text), at: Date.now() });
    if (this._batch.length >= this._MAX_LINES_PER_FLUSH) this._flushBatch();
    else if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => this._flushBatch(), this._MAX_BATCH_MS);
    }
  }

  _flushBatch() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    // Flush any deferred status along with the first real data flush.
    if (this._pendingStatus) {
      this.emit('status', this._pendingStatus);
      this._pendingStatus = null;
    }
    const lines = this._batch.splice(0, this._batch.length);
    for (const line of lines) this.emit('line', line);
  }

  _flushStatus() {
    if (this._pendingStatus) {
      this.emit('status', this._pendingStatus);
      this._pendingStatus = null;
    }
  }
}

function classifyLevel(text) {
  const upper = text.toUpperCase();
  if (upper.includes('ERROR') || upper.includes('FATAL') || upper.includes('TRACEBACK')) return 'error';
  if (upper.includes('WARN')) return 'warn';
  if (upper.includes('DEBUG')) return 'debug';
  return 'info';
}

module.exports = { LogTailer };
