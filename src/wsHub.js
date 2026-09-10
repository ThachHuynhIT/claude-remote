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
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname !== path) {
        socket.destroy();
        return;
      }
      const cookies = parseCookies(req.headers.cookie);
      if (!verifyToken(cookies[COOKIE_NAME])) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      if (!socket.destroyed) socket.destroy();
    }
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
