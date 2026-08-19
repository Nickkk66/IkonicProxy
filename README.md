# scramjet-selfhost

A self-hosted [Scramjet](https://github.com/MercuryWorkshop/scramjet) deployment, split across two hosts:

| Piece | Runs on | Why |
|---|---|---|
| Frontend (`public/`) | GitHub Pages | Static files only — free, HTTPS included |
| Wisp backend (`src/server.js`) | Your PC | Opens the actual sockets; cannot run on Pages |

GitHub Pages executes no server code, so the wisp backend **must** run on your machine and be
reachable over `wss://`. Cloudflare Tunnel provides that for free without port forwarding.

## Local development

```bash
npm install
npm run assets     # copy scramjet/libcurl/baremux into public/
npm start          # http://localhost:8080
```

## Exposing the backend

```bash
cloudflared tunnel --url http://localhost:8080
```

This prints a `https://<random>.trycloudflare.com` URL. Paste it straight into
**Backend settings** on the site -- `https://` is converted to `wss://` and `/wisp/` is
appended automatically.

Quick tunnels get a new random hostname on every restart. For a stable address, log in with
`cloudflared tunnel login` and create a named tunnel bound to a domain.

## Sharing

`DEFAULT_WISP` in `public/app.js` is the backend everyone gets out of the box, so people you
share the link with do not have to configure anything. When the quick tunnel rotates its
hostname, update that constant and push -- Pages redeploys automatically.

The settings panel is locked: the backend address is not shown or written into the page until
the password is entered. The password is stored as a SHA-256 hash rather than in the clear,
since this repo is public.

**This password is not security.** The page is static, so `app.js` is readable by anyone and
the check can be bypassed from devtools in seconds. It prevents accidental edits by people you
shared the link with; it does not keep out anyone who wants in.

## Notes

- `syncxhr` is disabled. It is the only Scramjet feature requiring `SharedArrayBuffer`, which
  needs COOP/COEP response headers, which GitHub Pages cannot set. Sites that use
  `SharedArrayBuffer` themselves may not fully work; everything else does.
- All frontend paths are computed from the page's own directory, so the project site path
  (`/<repo>/`) works without a custom domain.
- This pins Scramjet v1.1.0, matching the upstream reference app. v1 logs a notice recommending
  v2; upgrading is a follow-up.

## Licence

Scramjet and its transports belong to [Mercury Workshop](https://github.com/MercuryWorkshop).
