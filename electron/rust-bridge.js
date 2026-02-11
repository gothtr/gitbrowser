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
  }

  start() {
    // Find the Rust binary
    const rpcBin = path.join(__dirname, '..', 'target', 'debug', 'gitbrowser-rpc.exe');

    this.process = spawn(rpcBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.join(__dirname, '..'),
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
          console.log(`[RustBridge] connected, version ${msg.version}`);
          if (this._readyResolve) this._readyResolve();
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
    });
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
    if (this.process) {
      this.process.stdin.end();
      this.process.kill();
      this.process = null;
    }
  }
}

module.exports = new RustBridge();
