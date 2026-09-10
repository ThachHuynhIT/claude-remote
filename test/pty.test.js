const test = require('node:test');
const assert = require('node:assert/strict');
const { createPtyManager } = require('../src/pty');

const ECHO_SCRIPT = "process.stdin.resume();process.stdin.on('data',d=>process.stdout.write(d));";

function waitForData(manager, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for data')), timeoutMs);
    const onData = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        manager.off('data', onData);
        resolve(data);
      }
    };
    manager.on('data', onData);
  });
}

test('pty manager streams back data written to it', async () => {
  const manager = createPtyManager({ command: process.execPath, args: ['-e', ECHO_SCRIPT] });
  const seen = waitForData(manager, (data) => data.includes('hello-pty'));
  manager.write('hello-pty');
  await seen;
  assert.ok(manager.getScrollback().includes('hello-pty'));
  manager.proc.kill();
});

test('pty manager respawns after the process exits', async () => {
  const manager = createPtyManager({ command: process.execPath, args: ['-e', ECHO_SCRIPT] });
  const exited = new Promise((resolve) => manager.once('exit', resolve));
  manager.proc.kill();
  await exited;
  manager.ensureAlive();
  const seen = waitForData(manager, (data) => data.includes('after-respawn'));
  manager.write('after-respawn');
  await seen;
  manager.proc.kill();
});
