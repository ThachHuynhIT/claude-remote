const pty = require('node-pty');
const { EventEmitter } = require('events');

const MAX_SCROLLBACK = 200 * 1024;

class PtyManager extends EventEmitter {
  constructor({ command, args = [], cwd = process.cwd(), env = process.env }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.scrollback = '';
    this.proc = null;
    this.spawn();
  }

  spawn() {
    this.proc = pty.spawn(this.command, this.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: this.cwd,
      env: this.env,
    });
    this.proc.onData((data) => {
      this.scrollback = (this.scrollback + data).slice(-MAX_SCROLLBACK);
      this.emit('data', data);
    });
    this.proc.onExit(({ exitCode, signal }) => {
      this.proc = null;
      this.emit('exit', { exitCode, signal });
    });
  }

  ensureAlive() {
    if (!this.proc) {
      this.spawn();
    }
  }

  write(data) {
    this.ensureAlive();
    this.proc.write(data);
  }

  resize(cols, rows) {
    if (this.proc) {
      this.proc.resize(cols, rows);
    }
  }

  getScrollback() {
    return this.scrollback;
  }
}

function createPtyManager(options) {
  return new PtyManager(options);
}

module.exports = { createPtyManager, PtyManager, MAX_SCROLLBACK };
