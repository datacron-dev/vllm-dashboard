'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// ServerControl — start/stop the vLLM Docker container from the dashboard.
//
//   start(): docker start <name>  if the container already exists
//            otherwise: docker run -d --name <name> <flags>
//   stop():  docker stop <name>
//   restart(): docker restart <name>  (or start from scratch if restart fails)
//
// Emits:
//   'output' -> { stream: 'stdout'|'stderr'|'status', text, at }
//   'state'  -> { state: 'running'|'stopped'|'unknown'|'locked', at }
//
// The launch command is read from the user-editable config file so the
// Config panel can adjust flags before starting.
// ---------------------------------------------------------------------------
class ServerControl extends EventEmitter {
  constructor(opts) {
    super();
    this.settings = opts.settings;
    this.configPath = opts.configPath;
    this.provenance = opts.provenance || null;
    this.busy = false;
  }

  setProvenance(provenance) {
    this.provenance = provenance;
  }

  // -----------------------------------------------------------------------
  // Provenance guard – prevent double-starting when an external server owns
  // the port.  Returns true only when we may proceed.
  // -----------------------------------------------------------------------
  assertOurs(action = 'action') {
    const snapshot = this.provenance ? this.provenance.last : null;
    if (!snapshot || snapshot.state !== 'external') return true;
    const port = snapshot.endpoint
      ? String(snapshot.endpoint).split(':').pop()
      : 'the endpoint';
    const kindLabel =
      snapshot.kind || 'external';
    const modelLabel =
      snapshot.model ? ` · ${snapshot.model}` : '';
    this._emit('status',
      `Locked: external ${kindLabel} server owns :${port}${modelLabel}.` +
      ` Stop it before ${action}.`);
    this._emitState('locked');
    return false;
  }

  // Read the saved launch command (falls back to settings.vllmCommand).
  // Always returns a single-line command (newlines stripped or joined to spaces).
  _launchCommand() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (raw && typeof raw.vllmCommand === 'string' && raw.vllmCommand.trim()) {
        return raw.vllmCommand.replace(/\r?\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    } catch (_) { /* fall through to settings default */ }
    return this.settings.vllmCommand || '';
  }

  // Container name is derived from the saved command (--name <name>);
  // defaults to settings.dockerContainer.
  _containerName() {
    const cmd = this._launchCommand();
    const m = cmd.match(/--name[= ]([^\s"']+)/);
    return (m && m[1]) || this.settings.dockerContainer || 'my-vllm';
  }

  // -----------------------------------------------------------------------
  // High-level actions
  // -----------------------------------------------------------------------
  start() {
    if (this.busy) return;
    if (!this.assertOurs('start')) return;
    this.busy = true;
    const name = this._containerName();
    this._emit('status', `Starting ${name}\u2026`);

    this._docker(['inspect', '-f', '{{.State.Status}}', name], (err, out) => {
      if (!err && /created|running|paused|restarting/.test(out.trim())) {
        this._startExisting(name);
      } else {
        this._startFresh(name);
      }
    });
  }

  stop() {
    if (this.busy) return;
    if (!this.assertOurs('stop')) return;
    this.busy = true;
    const name = this._containerName();
    this._emit('status', `Stopping "${name}"\u2026`);
    this._docker(['stop', '-t', '30', name], (err, out, errOut) => {
      this.busy = false;
      if (err) {
        this._emit('status', `Failed to stop: ${(errOut || err.message).trim()}`);
        this._emitState('unknown');
      } else {
        this._emit('status', `Stopped "${name}".`);
        this._emitState('stopped');
      }
    });
  }

  restart() {
    if (this.busy) return;
    if (!this.assertOurs('restart')) return;
    this.busy = true;
    const name = this._containerName();
    this._emit('status', `Restarting "${name}"\u2026`);
    this._docker(['restart', name], (err, out, errOut) => {
      this.busy = false;
      if (err) {
        this._emit('status',
          `Restart failed -- falling back to start: ${(errOut || err.message).trim()}`);
        this.start();
      } else {
        this._emit('status', `Restarted "${name}".`);
        this._emitState('running');
      }
    });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  _startExisting(name) {
    this._emit('status', `Container found -- starting "${name}"\u2026`);
    this._docker(['start', name], (err, out, errOut) => {
      this.busy = false;
      if (err) {
        this._emit('status', `Failed to start: ${(errOut || err.message).trim()}`);
        this._emitState('unknown');
      } else {
        this._emit('status', `Started "${name}".`);
        this._pollState();
      }
    });
  }

  _startFresh(name) {
    const cmd = this._launchCommand();
    if (!cmd.trim()) {
      this.busy = false;
      this._emit('status', 'No launch command configured. Set it in the vLLM Config panel.');
      this._emitState('unknown');
      return;
    }
    this._emit('status', `No container found -- launching "${name}" with saved flags\u2026`);

    // Clean up any stale container first, then launch.
    this._docker(['rm', '-f', name], (rmErr) => {
      if (rmErr) {
        this._emit('status', `Warning: rm -f failed -- ${rmErr.message.trim()}`);
      }
      this._spawnDocker(cmd, name, (err, out, errOut) => {
        this.busy = false;
        if (err) {
          const msg = errOut
            ? errOut.trim()
            : (out || '').trim()
              ? out.trim()
              : err.message.split('\n')[0];
          this._emit('status', `docker run failed: ${msg}`);
          this._emitState('unknown');
        } else {
          this._emit('status', `Launched "${name}". vLLM is loading -- check Server Logs for progress.`);
          this._pollState();
        }
      });
    });
  }

  /**
   * Spawn `docker run` without a shell.
   *
   * The saved launch command is a well-formed docker-run expression that
   * was originally constructed by `presets.js` using `inferArgs()` (which
   * builds an argument array).  We do NOT pass untrusted text through a shell.
   *
   * Strategy:
   *   - Tokenise on whitespace respecting single-quoted segments.
   *   - Every token that does NOT start with `--` is assumed to be a positional arg.
   *   - The resulting array is passed directly to `spawn('docker', args)`.
   */
  _spawnDocker(command, name, cb) {
    const parsed = this._parseDockerArgs(command);

    // Extract leading env-var tokens (KEY=value) and pass as spawn env.
    const extraEnv = {};
    let cmdStart = 0;
    while (cmdStart < parsed.length && /^[\w.]+=[\S]+$/.test(parsed[cmdStart])) {
      const eq = parsed[cmdStart].indexOf('=');
      if (eq > 0) {
        extraEnv[parsed[cmdStart].substring(0, eq)] = parsed[cmdStart].substring(eq + 1);
      }
      cmdStart++;
    }

    // Strip a leading 'docker'/'podman'/'nerdctl' word token — the saved
    // command starts with the binary name but spawn() already specifies it.
    if (['docker', 'podman', 'nerdctl'].includes(parsed[cmdStart].toLowerCase())) {
      cmdStart++;
    }

    // Expand $HOME in mount paths — spawn() has no shell, so $HOME would
    // otherwise be passed literally to docker.
    const home = process.env.HOME || '/root';
    const dockerArgs = parsed.slice(cmdStart).map((t) =>
      t.startsWith('$HOME') ? home + t.substring(5) : t
    );

    const proc = spawn('docker', dockerArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });

    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('close', (code) => {
      cb(code !== 0 ? new Error(stderr.trim() || `exit ${code}`) : null, '', stderr);
    });
    proc.on('error', (err) => {
      cb(err, '', err.message);
    });
  }

  /**
   * Turn a docker-run command string (e.g.  `docker run -d --gpus all
   * -p 8000:8000 --name my-vllm …`) into an array suitable for
   * `spawn('docker', args)`.
   *
   * Tokens inside single quotes are preserved verbatim (they may contain
   * JSON or escaped characters).
   */
  _parseDockerArgs(cmd) {
    const tokens = [];
    let i = 0;
    while (i < cmd.length) {
      // Skip whitespace
      let ws = 0;
      while (i + ws < cmd.length && /[ \t\n\r]/.test(cmd[i + ws])) ws++;
      if (ws) { i += ws; continue; }

      // Single-quoted token (strip the surrounding quotes)
      if (cmd.charCodeAt(i) === 0x27 || cmd.charCodeAt(i) === 0x22) {
        const quote = cmd[i];
        let j = i + 1;
        while (j < cmd.length && cmd[j] !== quote) {
          if (cmd[j] === '\\') j += 2;
          else j++;
        }
        if (j < cmd.length) j++; // advance past closing quote
        tokens.push(cmd.substring(i + 1, j - 1)); // strip both quotes
        i = j;
        continue;
      }

      // Unquoted token (ends at next whitespace)
      const ei = cmd.indexOf(' ', i);
      const et = cmd.indexOf('\t', i) === -1 ? ei : (ei === -1 ? cmd.indexOf('\t', i) : Math.min(ei, cmd.indexOf('\t', i)));
      const en = cmd.indexOf('\n', i) === -1 ? et : (et === -1 ? cmd.indexOf('\n', i) : Math.min(et, cmd.indexOf('\n', i)));
      const er = cmd.indexOf('\r', i) === -1 ? en : (en === -1 ? cmd.indexOf('\r', i) : Math.min(en, cmd.indexOf('\r', i)));
      const nextWs = [ei, et, en, er].filter(x => x !== -1 && x >= i);
      const end = nextWs.length ? Math.min(...nextWs) : -1;

      if (end === -1) { tokens.push(cmd.substring(i)); break; }
      tokens.push(cmd.substring(i, end));
      i = end;
    }
    return tokens;
  }

  _pollState(attempt = 0) {
    const MAX_ATTEMPTS = 20;          // up to ~20 s of observation
    const DELAY_MS = 1000;
    const name = this._containerName();

    this._docker(['inspect', '-f', '{{.State.Status}}', name], (err, out) => {
      const s = (out || '').trim();
      if (!err && s === 'running') {
        this._emitState('running');
        if (attempt < MAX_ATTEMPTS) {
          setTimeout(() => this._pollState(attempt + 1), DELAY_MS);
        }
      } else if (!err && s === 'created') {
        this._emitState('stopped');
      } else if (!err && s === 'exited') {
        // Surface the reason -- the user can't see the container's stderr
        // from the dashboard UI otherwise.
        this._docker(['logs', '--tail', '40', name], (lErr, lOut, lErrOut) => {
          const tail = ((lErrOut || '') + (lOut || '')).trim().split('\n').slice(-12).join('\n');
          if (tail) this._emit('status', `Container exited. Last lines:\n${tail}`);
          this._emitState('stopped');
        });
      } else if (!err) {
        this._emitState(s);
      } else {
        this._emitState('unknown');
      }
    });
  }

  _emit(kind, text) {
    this.emit(kind, { stream: kind === 'status' ? 'status' : 'stdout', text, at: Date.now() });
  }

  _emitState(state) {
    this.emit('state', { state, at: Date.now() });
  }

  // -----------------------------------------------------------------------
  // Docker CLI wrapper — safe because no user data reaches `exec`.
  // -----------------------------------------------------------------------

  /**
   * Run a Docker CLI command; resolves with (err, stdout, stderr).
   * Uses spawn (no shell) since all args come from the module code.
   */
  _docker(args, cb) {
    const proc = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('close', (code) => {
      const err = code !== 0 ? new Error(stderr.trim() || `exit ${code}`) : null;
      cb(err, stdout, stderr);
    });
    proc.on('error', (err) => {
      cb(err, '', err.message);
    });
  }
}

module.exports = { ServerControl };
