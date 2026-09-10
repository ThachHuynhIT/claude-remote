# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small Node.js/Express app that lets a trusted remote user share one live `claude` (Claude Code CLI) terminal session over a browser — password-gated, with file upload from the browser to the host. See [README.md](README.md) for the operator-facing setup/sharing/security instructions.

## Commands

```bash
npm install       # installs deps; node-pty is a native module — on Windows this needs
                   # "Desktop development with C++" (Visual Studio Build Tools) if it fails to build
npm start          # runs src/server.js, requires a valid .env (see below)
npm test           # runs the full suite (node --test, auto-discovers test/*.test.js)
node --test test/auth.test.js   # run a single test file
```

Before `npm start` will do anything real, copy `.env.example` to `.env` and set:
- `ACCESS_PASSWORD` — required, the server refuses to start without it.
- `CLAUDE_COMMAND` — **on Windows this must be `claude.exe`, not `claude`.** `node-pty`'s Windows/conpty backend passes the executable name straight to `CreateProcess` with no extension resolution, so a bare `claude` fails with "File not found" and the pty exits immediately on every connection attempt (visible as a "session ended, restarting..." loop in the terminal UI with no other error).
- `SESSION_SECRET` — optional; if blank, a random one is generated each start (every restart invalidates all logged-in sessions).

There is no build step and no linter configured.

## Architecture

The whole app is wired through one seam: `createApp({ ptyManager, uploadsDir })` in `src/createApp.js` builds and returns an unstarted `http.Server` given a pty-manager-shaped dependency. `src/server.js` is the only place that constructs the *real* `PtyManager` and calls `.listen()`; every test instead passes a stub (a plain `EventEmitter` with `write`/`resize`/`getScrollback`), which is what makes the whole HTTP+WebSocket surface testable without ever spawning a real `claude` process.

**One shared pty, not one per client.** `src/pty.js`'s `PtyManager` is instantiated exactly once (in `server.js`) and holds a single `claude` child process. `src/wsHub.js` attaches to the `http.Server`'s `'upgrade'` event and puts every connecting WebSocket client into one `Set`; pty output is broadcast to that whole set, and input from *any* client is written to the *same* pty — this is the "shared terminal" behavior the app exists for. If the pty process exits (or fails to (re)spawn), `PtyManager` emits `'exit'` and `ensureAlive()`/`write()` will respawn it lazily on the next input.

**Auth is cookie-based and duplicated across two entry points on purpose (see note below).** `src/auth.js` owns password checking (`checkPassword`, timing-safe), session tokens (`signToken`/`verifyToken`, HMAC-signed, no expiry), and login rate limiting (`LoginRateLimiter`, 5 failures/60s, keyed by socket remote address). Both `createApp.js`'s `requireAuth` Express middleware and `wsHub.js`'s upgrade handler independently call `parseCookies` + `verifyToken` against the same `COOKIE_NAME` (`claude_remote_session`) — there is no single shared `isAuthenticated(req)` helper yet; if you change the auth check, update both call sites.

**Static pages are served by explicit routes, not `express.static`.** `public/login.html` and `public/index.html` are returned via `res.sendFile` from named routes in `createApp.js` (`/login.html` open, `/` behind `requireAuth`). There is intentionally no `express.static(publicDir)` mount — that would let anyone fetch `index.html` directly and bypass the auth gate.

**Upload is a separate router mounted behind auth.** `src/upload.js` exports `createUploadRouter({ uploadsDir, maxBytes })`, mounted in `createApp.js` behind the same `requireAuth` middleware. Filenames are sanitized to a plain basename before being used to build a disk path.

## Known constraints (from the design spec)

- Single shared session by design — not one pty per user.
- No database; scrollback is an in-memory ring buffer on `PtyManager`, capped at `MAX_SCROLLBACK` (200KB).
- Meant to be exposed to the internet via VS Code's Port Forwarding (tunnel terminates locally over loopback) — there is no reverse proxy in front of it, which is why the WebSocket upgrade handler must reject/destroy sockets itself rather than relying on anything upstream.
