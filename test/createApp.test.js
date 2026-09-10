const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/createApp');

function createStubPtyManager() {
  const emitter = new EventEmitter();
  emitter.write = () => {};
  emitter.resize = () => {};
  emitter.getScrollback = () => '';
  return emitter;
}

function tempUploadsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-app-'));
}

function rawRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('POST /login sets a cookie on success and rejects the wrong password', async () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'secret';
  const uploadsDir = tempUploadsDir();
  const server = createApp({ ptyManager: createStubPtyManager(), uploadsDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const bad = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
  assert.equal(bad.status, 401);

  const good = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  assert.equal(good.status, 200);
  assert.ok(good.headers.get('set-cookie').startsWith('claude_remote_session='));

  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('GET / redirects to login without a session and serves the page with one', async () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'secret';
  const uploadsDir = tempUploadsDir();
  const server = createApp({ ptyManager: createStubPtyManager(), uploadsDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const noAuth = await rawRequest(`${base}/`);
  assert.equal(noAuth.status, 302);
  assert.equal(noAuth.headers.location, '/login.html');

  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const authed = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  assert.equal(authed.status, 200);
  const html = await authed.text();
  assert.ok(html.includes('id="terminal"'));

  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('POST /upload redirects to login without a session cookie', async () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'secret';
  const uploadsDir = tempUploadsDir();
  const server = createApp({ ptyManager: createStubPtyManager(), uploadsDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await rawRequest(`http://127.0.0.1:${port}/upload`, { method: 'POST' });
  assert.equal(res.status, 302);

  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});
