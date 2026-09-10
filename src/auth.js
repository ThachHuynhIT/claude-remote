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
