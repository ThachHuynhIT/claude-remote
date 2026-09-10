const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/createApp');
const { signToken } = require('../src/auth');

function createStubPtyManager() {
  const emitter = new EventEmitter();
  emitter.write = () => {};
  emitter.resize = () => {};
  emitter.getScrollback = () => '';
  return emitter;
}

function tempUploadsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-public-'));
}

test('login.html contains a password field', async () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'secret';
  const uploadsDir = tempUploadsDir();
  const server = createApp({ ptyManager: createStubPtyManager(), uploadsDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/login.html`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('type="password"'));

  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('index.html contains the terminal container and loads xterm.js', async () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'secret';
  const uploadsDir = tempUploadsDir();
  const server = createApp({ ptyManager: createStubPtyManager(), uploadsDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { Cookie: `claude_remote_session=${signToken()}` } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('id="terminal"'));
  assert.ok(html.includes('xterm'));

  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});
