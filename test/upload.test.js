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
