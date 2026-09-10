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

function shutdown() {
  if (ptyManager.proc) {
    ptyManager.proc.kill();
  }
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
