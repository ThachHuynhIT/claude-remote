# claude-remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small Node.js web app that lets a trusted remote user share
one live `claude` (Claude Code) terminal session over a browser, with
password auth and file upload from the client machine.

**Architecture:** Express serves two static pages (login, terminal) and a
JSON `/login` endpoint; a `node-pty`-backed singleton spawns and owns the
one shared `claude` process; a WebSocket hub broadcasts its output to every
connected browser and relays keystrokes from any of them back into the pty;
`multer` handles file uploads into a local `uploads/` folder. All protected
routes and the WebSocket upgrade share one cookie-based auth check.

**Tech Stack:** Node.js (>=18), Express, `ws`, `node-pty`, `multer`,
`dotenv`, `xterm.js` (via CDN, no build step). Tests use the built-in
`node:test` runner plus the global `fetch`/`FormData`/`Blob` — no test
framework dependency.

**Spec:** [docs/superpowers/specs/2026-09-10-claude-remote-design.md](../specs/2026-09-10-claude-remote-design.md)

## Global Constraints

- Node.js >= 18 required (uses built-in `fetch`, `FormData`, `Blob`, `node:test`).
- `ACCESS_PASSWORD` env var is mandatory — the server must fail to start without it.
- Exactly one shared `claude` pty process for all connected clients — never per-user sessions.
- No database, no persistent chat history beyond an in-memory scrollback buffer.
- Uploads capped at 20MB by default; uploaded filenames must be sanitized against path traversal.
- Login rate limit: block an IP after 5 failed attempts within 60 seconds.
- Cookie name is `claude_remote_session` everywhere (server and tests).

---

## File Structure

```
claude-remote/
  package.json
  .env.example
  .gitignore
  README.md
  src/
    auth.js         # password check, HMAC token sign/verify, login rate limiter, config guard
    pty.js          # PtyManager: owns the single shared claude pty, respawns on exit
    upload.js        # filename sanitizer + multer-backed /upload router
    wsHub.js        # WebSocket server: cookie auth on upgrade, broadcast, scrollback replay
    createApp.js    # wires auth + routes + upload router + wsHub into one http.Server (not listening)
    server.js       # entry point: loads .env, builds the real PtyManager, calls createApp, listens
  public/
    login.html      # password form
    index.html      # xterm.js terminal + upload widget
  test/
    auth.test.js
    pty.test.js
    upload.test.js
    wsHub.test.js
    createApp.test.js
    public.test.js
  uploads/          # created at runtime, gitignored
```

---

### Task 1: Project scaffolding + auth module

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/auth.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Produces: `assertConfigured(): void` (throws if `process.env.ACCESS_PASSWORD` unset), `checkPassword(candidate: string): boolean`, `signToken(): string`, `verifyToken(token: string|undefined): boolean`, `LoginRateLimiter` class with `isBlocked(ip)`, `recordFailure(ip)`, `recordSuccess(ip)` — all exported from `src/auth.js`.

- [ ] **Step 1: Create project scaffolding files**

`package.json`:

```json
{
  "name": "claude-remote",
  "version": "1.0.0",
  "private": true,
  "description": "Share a live Claude Code terminal session over the browser with a trusted person.",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1",
    "node-pty": "^1.0.0",
    "ws": "^8.17.0"
  }
}
```

`.gitignore`:

```
node_modules/
.env
uploads/
```

`.env.example`:

```
ACCESS_PASSWORD=change-me
SESSION_SECRET=
PORT=3000
CLAUDE_COMMAND=claude
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: installs without errors. If `node-pty` fails to build on Windows,
install "Desktop development with C++" via Visual Studio Build Tools, then
re-run `npm install`.

- [ ] **Step 3: Write the failing test file**

`test/auth.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPassword, signToken, verifyToken, assertConfigured, LoginRateLimiter } = require('../src/auth');

test('assertConfigured throws when ACCESS_PASSWORD is missing', () => {
  const original = process.env.ACCESS_PASSWORD;
  delete process.env.ACCESS_PASSWORD;
  assert.throws(() => assertConfigured());
  if (original !== undefined) process.env.ACCESS_PASSWORD = original;
});

test('checkPassword accepts the correct password and rejects wrong ones', () => {
  process.env.ACCESS_PASSWORD = 'correct-horse-battery-staple';
  assert.equal(checkPassword('correct-horse-battery-staple'), true);
  assert.equal(checkPassword('wrong'), false);
  assert.equal(checkPassword(''), false);
});

test('signToken produces a token that verifyToken accepts', () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'test-secret';
  const token = signToken();
  assert.equal(verifyToken(token), true);
});

test('verifyToken rejects tampered or missing tokens', () => {
  process.env.SESSION_SECRET = 'test-secret';
  const token = signToken();
  assert.equal(verifyToken(token + 'x'), false);
  assert.equal(verifyToken(undefined), false);
  assert.equal(verifyToken(''), false);
  assert.equal(verifyToken('garbage'), false);
});

test('LoginRateLimiter blocks after too many failures and resets after the window', async () => {
  const limiter = new LoginRateLimiter(3, 50);
  const ip = '1.2.3.4';
  limiter.recordFailure(ip);
  limiter.recordFailure(ip);
  assert.equal(limiter.isBlocked(ip), false);
  limiter.recordFailure(ip);
  assert.equal(limiter.isBlocked(ip), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(limiter.isBlocked(ip), false);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/auth'`

- [ ] **Step 5: Implement `src/auth.js`**

```js
const crypto = require('crypto');

function assertConfigured() {
  if (!process.env.ACCESS_PASSWORD) {
    throw new Error('ACCESS_PASSWORD environment variable is required');
  }
}

function checkPassword(candidate) {
  const expected = process.env.ACCESS_PASSWORD || '';
  const a = Buffer.from(candidate || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getSecret() {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  }
  return process.env.SESSION_SECRET;
}

function signToken() {
  const payload = 'authenticated';
  const hmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, hmac] = token.split('.');
  if (!payload || !hmac || payload !== 'authenticated') return false;
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  const a = Buffer.from(hmac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

class LoginRateLimiter {
  constructor(maxAttempts = 5, windowMs = 60000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  isBlocked(ip) {
    const entry = this.attempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.attempts.delete(ip);
      return false;
    }
    return entry.count >= this.maxAttempts;
  }

  recordFailure(ip) {
    const entry = this.attempts.get(ip);
    if (!entry || Date.now() > entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: Date.now() + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  recordSuccess(ip) {
    this.attempts.delete(ip);
  }
}

module.exports = { assertConfigured, checkPassword, signToken, verifyToken, LoginRateLimiter };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (5 tests in `test/auth.test.js`)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example src/auth.js test/auth.test.js
git commit -m "feat: add scaffolding and password/token auth module"
```

---

### Task 2: PTY manager

**Files:**
- Create: `src/pty.js`
- Test: `test/pty.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createPtyManager({ command, args, cwd?, env? }): PtyManager`, where `PtyManager` extends `EventEmitter`, emits `'data'` (string chunk) and `'exit'` ({exitCode, signal}), and exposes `.write(data: string)`, `.resize(cols, rows)`, `.ensureAlive()`, `.getScrollback(): string`, and the underlying child process as `.proc`. Later tasks (wsHub, createApp) depend on exactly these names.

- [ ] **Step 1: Write the failing test file**

`test/pty.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/pty'`

- [ ] **Step 3: Implement `src/pty.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (2 tests in `test/pty.test.js`, plus the previous `auth.test.js` tests still passing)

- [ ] **Step 5: Commit**

```bash
git add src/pty.js test/pty.test.js
git commit -m "feat: add shared pty manager with respawn on exit"
```

---

### Task 3: Upload module

**Files:**
- Create: `src/upload.js`
- Test: `test/upload.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `sanitizeFilename(name: string): string` and `createUploadRouter({ uploadsDir, maxBytes? }): express.Router` mounting `POST /upload` (multipart field name `file`), responding `{ path: string }` on success or `{ error: string }` with a 400 status on failure. `createApp.js` (Task 5) mounts this router.

- [ ] **Step 1: Write the failing test file**

`test/upload.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { sanitizeFilename, createUploadRouter } = require('../src/upload');

test('sanitizeFilename strips path segments and unsafe characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('my file (1).txt'), 'my_file__1_.txt');
  assert.equal(sanitizeFilename(''), 'file');
});

test('upload route saves the file and returns its absolute path', async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-uploads-'));
  const app = express();
  app.use(createUploadRouter({ uploadsDir }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const form = new FormData();
  form.append('file', new Blob(['hello world']), 'notes.txt');
  const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(body.path.endsWith('notes.txt'));
  assert.equal(fs.readFileSync(body.path, 'utf8'), 'hello world');

  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('upload route rejects files over the configured size limit', async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-uploads-'));
  const app = express();
  app.use(createUploadRouter({ uploadsDir, maxBytes: 10 }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const form = new FormData();
  form.append('file', new Blob(['this is longer than ten bytes']), 'big.txt');
  const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form });

  assert.equal(res.status, 400);

  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/upload'`

- [ ] **Step 3: Implement `src/upload.js`**

```js
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

function sanitizeFilename(originalName) {
  const base = path.basename(originalName || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'file';
}

function createUploadRouter({ uploadsDir, maxBytes = 20 * 1024 * 1024 }) {
  fs.mkdirSync(uploadsDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${sanitizeFilename(file.originalname)}`),
  });

  const upload = multer({ storage, limits: { fileSize: maxBytes } });
  const router = express.Router();

  router.post('/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'no file provided' });
      }
      res.json({ path: path.resolve(req.file.path) });
    });
  });

  return router;
}

module.exports = { sanitizeFilename, createUploadRouter };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (3 tests in `test/upload.test.js`, all earlier tests still passing)

- [ ] **Step 5: Commit**

```bash
git add src/upload.js test/upload.test.js
git commit -m "feat: add sanitized file upload endpoint"
```

---

### Task 4: WebSocket hub

**Files:**
- Create: `src/wsHub.js`
- Test: `test/wsHub.test.js`

**Interfaces:**
- Consumes: `verifyToken` from `src/auth.js` (Task 1); a pty-manager-shaped object exposing `.on('data', fn)`, `.write(data)`, `.resize(cols, rows)`, `.getScrollback()` — matches `PtyManager` from Task 2, but tests use a plain `EventEmitter` stub with the same methods.
- Produces: `attachWsHub(server: http.Server, ptyManager, path = '/ws'): WebSocketServer`, `parseCookies(header: string): object`, `COOKIE_NAME = 'claude_remote_session'` — all consumed by `createApp.js` in Task 5.

- [ ] **Step 1: Write the failing test file**

`test/wsHub.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { attachWsHub, COOKIE_NAME } = require('../src/wsHub');
const { signToken } = require('../src/auth');

function createStubPtyManager(scrollback = '') {
  const emitter = new EventEmitter();
  emitter.write = () => {};
  emitter.resize = () => {};
  emitter.getScrollback = () => scrollback;
  return emitter;
}

async function startServer(ptyManager) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  attachWsHub(server, ptyManager);
  await new Promise((resolve) => server.listen(0, resolve));
  return server;
}

test('rejects a websocket upgrade without a valid session cookie', async () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'secret';
  const server = await startServer(createStubPtyManager());
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.on('unexpected-response', (req, res) => {
      assert.equal(res.statusCode, 401);
      resolve();
    });
    ws.on('open', () => reject(new Error('should not connect without a cookie')));
  });
  server.close();
});

test('sends scrollback on connect and broadcasts pty output to every client', async () => {
  process.env.ACCESS_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'secret';
  const ptyManager = createStubPtyManager('welcome back');
  const server = await startServer(ptyManager);
  const { port } = server.address();
  const token = signToken();

  const openClient = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `${COOKIE_NAME}=${token}` } });
    ws.once('message', (raw) => resolve({ ws, first: JSON.parse(raw.toString()) }));
  });

  const clientA = await openClient();
  assert.deepEqual(clientA.first, { type: 'output', data: 'welcome back' });
  const clientB = await openClient();

  const nextMessage = (ws) => new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
  const gotOnA = nextMessage(clientA.ws);
  const gotOnB = nextMessage(clientB.ws);
  ptyManager.emit('data', 'new output');
  assert.deepEqual(await gotOnA, { type: 'output', data: 'new output' });
  assert.deepEqual(await gotOnB, { type: 'output', data: 'new output' });

  clientA.ws.close();
  clientB.ws.close();
  server.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/wsHub'`

- [ ] **Step 3: Implement `src/wsHub.js`**

```js
const { WebSocketServer } = require('ws');
const { verifyToken } = require('./auth');

const COOKIE_NAME = 'claude_remote_session';

function parseCookies(header = '') {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function attachWsHub(server, ptyManager, path = '/ws') {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== path) return;
    const cookies = parseCookies(req.headers.cookie);
    if (!verifyToken(cookies[COOKIE_NAME])) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'output', data: ptyManager.getScrollback() }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        ptyManager.write(msg.data);
      } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        ptyManager.resize(msg.cols, msg.rows);
      }
    });

    ws.on('close', () => clients.delete(ws));
  });

  ptyManager.on('data', (data) => {
    const payload = JSON.stringify({ type: 'output', data });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });

  ptyManager.on('exit', () => {
    const payload = JSON.stringify({ type: 'system', data: 'session ended, restarting...' });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });

  return wss;
}

module.exports = { attachWsHub, parseCookies, COOKIE_NAME };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (2 tests in `test/wsHub.test.js`, all earlier tests still passing)

- [ ] **Step 5: Commit**

```bash
git add src/wsHub.js test/wsHub.test.js
git commit -m "feat: add websocket hub broadcasting a shared pty to all clients"
```

---

### Task 5: App wiring and entry point

**Files:**
- Create: `src/createApp.js`
- Create: `src/server.js`
- Test: `test/createApp.test.js`

**Interfaces:**
- Consumes: `auth.js` (Task 1) exports, `attachWsHub`/`parseCookies`/`COOKIE_NAME` from `wsHub.js` (Task 4), `createUploadRouter` from `upload.js` (Task 3), `createPtyManager` from `pty.js` (Task 2).
- Produces: `createApp({ ptyManager, uploadsDir }): http.Server` (not listening yet) from `src/createApp.js`. `src/server.js` is the real process entry point (`npm start` runs it); it has no exports consumed elsewhere.

- [ ] **Step 1: Write the failing test file**

`test/createApp.test.js`:

```js
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
```

Note: this test file references `public/index.html` containing `id="terminal"`,
which is created in Task 6 — until then the second test fails with a file-not-found
error from `res.sendFile`. That is expected at this point in the plan.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/createApp'`

- [ ] **Step 3: Implement `src/createApp.js`**

```js
const path = require('path');
const http = require('http');
const express = require('express');
const auth = require('./auth');
const { attachWsHub, parseCookies, COOKIE_NAME } = require('./wsHub');
const { createUploadRouter } = require('./upload');

function createApp({ ptyManager, uploadsDir }) {
  const app = express();
  app.use(express.json());

  const rateLimiter = new auth.LoginRateLimiter();

  function requireAuth(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    if (auth.verifyToken(cookies[COOKIE_NAME])) {
      return next();
    }
    res.redirect('/login.html');
  }

  app.post('/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    if (rateLimiter.isBlocked(ip)) {
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    const { password } = req.body || {};
    if (auth.checkPassword(password)) {
      rateLimiter.recordSuccess(ip);
      res.cookie(COOKIE_NAME, auth.signToken(), { httpOnly: true, sameSite: 'lax' });
      return res.json({ ok: true });
    }
    rateLimiter.recordFailure(ip);
    res.status(401).json({ error: 'wrong password' });
  });

  app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });

  app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use(requireAuth, createUploadRouter({ uploadsDir }));

  const server = http.createServer(app);
  attachWsHub(server, ptyManager);
  return server;
}

module.exports = { createApp };
```

- [ ] **Step 4: Implement `src/server.js`**

```js
require('dotenv').config();
const path = require('path');
const auth = require('./auth');
const { createPtyManager } = require('./pty');
const { createApp } = require('./createApp');

auth.assertConfigured();

const ptyManager = createPtyManager({ command: process.env.CLAUDE_COMMAND || 'claude', args: [] });
const uploadsDir = path.join(__dirname, '..', 'uploads');
const server = createApp({ ptyManager, uploadsDir });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`claude-remote listening on http://localhost:${PORT}`);
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: the first and third tests in `test/createApp.test.js` PASS; the
second one still FAILS (no `public/index.html` yet) — this is expected,
Task 6 fixes it. All other test files still pass.

- [ ] **Step 6: Commit**

```bash
git add src/createApp.js src/server.js test/createApp.test.js
git commit -m "feat: wire auth, upload, and websocket hub into one app + entry point"
```

---

### Task 6: Frontend pages

**Files:**
- Create: `public/login.html`
- Create: `public/index.html`
- Test: `test/public.test.js`

**Interfaces:**
- Consumes: `createApp` from Task 5 (via its test), `signToken`/`COOKIE_NAME` semantics from Tasks 1 and 4.
- Produces: the two HTML pages that `src/createApp.js` already serves via `res.sendFile`.

- [ ] **Step 1: Write the failing test file**

`test/public.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `res.sendFile` errors because `public/login.html` and
`public/index.html` do not exist yet (this also fixes the pending failure
left over from Task 5's second test).

- [ ] **Step 3: Create `public/login.html`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>claude-remote — Đăng nhập</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1e1e1e; color: #eee; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  form { background: #2d2d2d; padding: 2rem; border-radius: 8px; display: flex; flex-direction: column; gap: 1rem; min-width: 280px; }
  input { padding: 0.5rem; border-radius: 4px; border: 1px solid #555; background: #1e1e1e; color: #eee; }
  button { padding: 0.5rem; border-radius: 4px; border: none; background: #4c8bf5; color: white; cursor: pointer; }
  #error { color: #f28b82; min-height: 1.2rem; }
</style>
</head>
<body>
  <form id="login-form">
    <h2>claude-remote</h2>
    <input type="password" id="password" placeholder="Mật khẩu" autofocus required>
    <div id="error"></div>
    <button type="submit">Vào</button>
  </form>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error');
      errorEl.textContent = '';
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        const body = await res.json().catch(() => ({}));
        errorEl.textContent = body.error || 'Đăng nhập thất bại';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 4: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>claude-remote — Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<style>
  html, body { height: 100%; margin: 0; background: #1e1e1e; }
  #terminal { height: 70vh; padding: 0.5rem; box-sizing: border-box; }
  #upload-bar { display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem; background: #2d2d2d; color: #eee; font-family: system-ui, sans-serif; }
  #upload-result { font-size: 0.85rem; word-break: break-all; }
</style>
</head>
<body>
  <div id="terminal"></div>
  <div id="upload-bar">
    <input type="file" id="file-input">
    <button id="upload-btn">Tải lên</button>
    <span id="upload-result"></span>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script>
    const term = new Terminal({ convertEol: true, fontSize: 14 });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output' || msg.type === 'system') {
        term.write(msg.data);
      }
    });

    term.onData((data) => {
      ws.send(JSON.stringify({ type: 'input', data }));
    });

    window.addEventListener('resize', () => {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });

    document.getElementById('upload-btn').addEventListener('click', async () => {
      const fileInput = document.getElementById('file-input');
      const resultEl = document.getElementById('upload-result');
      if (!fileInput.files.length) return;
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      resultEl.textContent = 'Đang tải lên...';
      const res = await fetch('/upload', { method: 'POST', body: formData });
      const body = await res.json();
      resultEl.textContent = res.ok ? body.path : `Lỗi: ${body.error}`;
    });
  </script>
</body>
</html>
```

- [ ] **Step 5: Run the full test suite to verify everything passes**

Run: `npm test`
Expected: PASS — every test in `test/` (auth, pty, upload, wsHub, createApp,
public) is green.

- [ ] **Step 6: Commit**

```bash
git add public/login.html public/index.html test/public.test.js
git commit -m "feat: add login and terminal frontend pages"
```

---

### Task 7: Documentation and manual end-to-end verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: nothing new — this task documents the finished app from Tasks 1-6.
- Produces: nothing consumed by other tasks; this is the last task.

- [ ] **Step 1: Write `README.md`**

```markdown
# claude-remote

Chia sẻ một phiên `claude` (Claude Code) đang chạy trên máy bạn cho một
người khác dùng qua trình duyệt, kèm mật khẩu và tính năng upload file.

## Cài đặt

1. Cài Node.js >= 18.
2. `npm install`
3. Copy `.env.example` thành `.env`, đặt `ACCESS_PASSWORD` là một mật khẩu
   mạnh. Có thể để trống `SESSION_SECRET` (server tự sinh ngẫu nhiên mỗi
   lần khởi động — nghĩa là mọi người phải đăng nhập lại sau khi restart).
4. Đảm bảo lệnh `claude` chạy được từ terminal thường (đã cài Claude Code).

## Chạy

```bash
npm start
```

Mặc định chạy ở `http://localhost:3000`.

## Chia sẻ qua Internet bằng VS Code Port Forwarding

1. Trong VS Code, mở tab **Ports** (panel dưới, cạnh Terminal).
2. Bấm **Forward a Port**, nhập `3000` (hoặc giá trị `PORT` bạn đặt trong `.env`).
3. Click chuột phải vào port vừa forward → **Port Visibility** → **Public**.
4. Copy URL được sinh ra, gửi kèm mật khẩu cho người bạn tin tưởng qua một
   kênh khác (không gửi chung một tin nhắn với link).
5. Khi xong việc, đặt lại **Port Visibility** về **Private** hoặc dừng
   server (`Ctrl+C`).

## Cảnh báo bảo mật

Bất kỳ ai có link + mật khẩu đều có thể gõ lệnh vào phiên Claude Code này,
và Claude Code có thể thực thi lệnh shell trên máy bạn. Chỉ chia sẻ với
người bạn thực sự tin tưởng, và tắt server/đặt lại port về Private ngay
khi không dùng nữa.

## Kiểm tra thủ công trước khi dùng thật

1. Khởi động server *không* set `ACCESS_PASSWORD` → xác nhận server từ
   chối chạy và thoát với thông báo lỗi rõ ràng.
2. Set `ACCESS_PASSWORD`, chạy `npm start`, mở 2 tab trình duyệt, đăng
   nhập cả 2 → gõ ở tab 1 → xác nhận tab 2 thấy cùng output ngay lập tức.
3. Nhập sai password 6 lần liên tiếp trong 1 phút → xác nhận lần thứ 6 bị
   chặn (lỗi 429).
4. Upload 1 file text nhỏ → copy đường dẫn trả về, gõ vào terminal yêu cầu
   Claude đọc file đó → xác nhận đọc được nội dung.
5. Kill tiến trình `claude` con thủ công (Task Manager) trong khi server
   đang chạy → xác nhận cả 2 tab nhận được thông báo "session ended,
   restarting..." và phiên mới hoạt động khi gõ tiếp.
6. Reload trang (F5) → xác nhận không có thêm tiến trình `claude` mới bị
   tạo ra (vẫn dùng chung 1 pty — kiểm tra bằng Task Manager).
```

- [ ] **Step 2: Run the full test suite one more time**

Run: `npm test`
Expected: PASS — all test files green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add setup, sharing, and manual verification instructions"
```

- [ ] **Step 4: Perform the manual end-to-end checklist from the README**

This step needs a human with the real `claude` CLI installed and a
browser — it cannot be automated by a subagent. Follow the 6 checks in
`README.md`'s "Kiểm tra thủ công trước khi dùng thật" section and confirm
each one before sharing the link with anyone.
