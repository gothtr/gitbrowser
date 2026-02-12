/**
 * Bridge to Rust RPC server (gitbrowser-rpc).
 * Communicates via newline-delimited JSON over stdin/stdout.
 */
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class RustBridge {
  constructor() {
    this.process = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.ready = false;
    this.readyPromise = null;
    this._reconnecting = false;
    this._healthInterval = null;
  }

  start() {
    const fs = require('fs');
    const { app } = require('electron');

    // Find the Rust binary — check multiple locations
    let rpcBin = null;
    const candidates = [
      // Packaged app: binary is in the app directory
      path.join(__dirname, 'gitbrowser-rpc.exe'),
      // Packaged app: binary next to the asar
      path.join(path.dirname(app.getAppPath()), 'gitbrowser-rpc.exe'),
      // Development: debug build
      path.join(__dirname, '..', 'target', 'debug', 'gitbrowser-rpc.exe'),
      // Development: release build
      path.join(__dirname, '..', 'target', 'release', 'gitbrowser-rpc.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { rpcBin = c; break; }
    }
    if (!rpcBin) {
      console.error('[RustBridge] gitbrowser-rpc binary not found, tried:', candidates);
      return;
    }

    // Working directory: use app data dir for packaged, project root for dev
    const cwd = app.isPackaged
      ? path.dirname(rpcBin)
      : path.join(__dirname, '..');

    this.process = spawn(rpcBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    this.readyPromise = new Promise((resolve) => {
      this._readyResolve = resolve;
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'ready') {
          this.ready = true;
          this._reconnecting = false;
          console.log(`[RustBridge] connected, version ${msg.version}`);
          if (this._readyResolve) this._readyResolve();
          this._startHealthCheck();
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch (e) {
        console.error('[RustBridge] parse error:', e.message, line);
      }
    });

    this.process.stderr.on('data', (data) => {
      console.error('[Rust]', data.toString().trim());
    });

    this.process.on('exit', (code) => {
      console.log(`[RustBridge] exited with code ${code}`);
      this.ready = false;
      this._stopHealthCheck();
      // Reject all pending calls
      for (const [id, { reject }] of this.pending) {
        reject(new Error('RPC process exited'));
      }
      this.pending.clear();
      // Auto-reconnect after 2s
      if (!this._reconnecting) {
        this._reconnecting = true;
        console.log('[RustBridge] reconnecting in 2s...');
        setTimeout(() => this.start(), 2000);
      }
    });
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthInterval = setInterval(() => {
      if (this.ready) {
        this.call('ping', {}).catch(() => {
          console.warn('[RustBridge] health check failed');
        });
      }
    }, 30000);
  }

  _stopHealthCheck() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }

  async call(method, params = {}) {
    if (!this.ready) await this.readyPromise;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, method, params }) + '\n';
      this.process.stdin.write(msg);
      // Timeout after 5s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 5000);
    });
  }

  stop() {
    this._reconnecting = true; // prevent auto-reconnect on intentional stop
    this._stopHealthCheck();
    if (this.process) {
      this.process.stdin.end();
      this.process.kill();
      this.process = null;
    }
  }
}

module.exports = new RustBridge();
