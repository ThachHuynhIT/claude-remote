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
