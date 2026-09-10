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
