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
