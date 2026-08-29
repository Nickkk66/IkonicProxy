# Ikonic

A self-hosted [Scramjet](https://github.com/MercuryWorkshop/scramjet) deployment, split across two hosts:

| Piece | Runs on | Why |
|---|---|---|
| Frontend (`public/`) | GitHub Pages | Static files only — free, HTTPS included |
| Wisp backend (`src/server.js`) | Your PC | Opens the actual sockets; cannot run on Pages |

GitHub Pages executes no server code, so the wisp backend **must** run on your machine and be
reachable over `wss://`. Cloudflare Tunnel provides that for free without port forwarding.

## Setup

```bash
npm run setup      # or double-click setup.cmd on Windows
```

Checks that everything needed is present — Node 18+, dependencies, the browser assets in
`public/`, the frontend files, and `cloudflared` — and offers to run `npm install` or
`npm run assets` for whatever is missing. Then it opens a menu:

```
Proxy:  running on port 8080 (pid 22816)
Tunnel: https://outlet-fleece-onion-compromise.trycloudflare.com

  1) Stop the proxy
  2) Stop the tunnel
  3) Use that address as the site default (edits public/app.js)
  4) Show the link and secret (copies the secret)
  5) Change the backend secret
  6) Close
```

Each entry flips to its opposite depending on what is running, so option 1 reads **Start the
proxy** when it is stopped. Option 3 only appears once a tunnel address is known; it rewrites
`DEFAULT_WISP` in `public/app.js` for you, which still has to be committed and pushed before
the Pages site uses it.

Starting the proxy or the tunnel prints the same block option 4 does, and puts the secret on
the clipboard ready to paste:

```
================================================================
 Backend
================================================================
  Link (always current, rotates)
    https://think-achievement-brochure-readings.trycloudflare.com

  Link (stable, needs the address below to be pushed)
    https://nickkk66.github.io/scramjet-selfhost/

  Backend address
    wss://think-achievement-brochure-readings.trycloudflare.com/wisp/<secret>/

  Secret  (copied to clipboard)
    <secret>
```

The first link is the tunnel itself, which serves the frontend as well as the socket — it is
same-origin, so it always works and never needs `DEFAULT_WISP` or the repository secret to be
current. The catch is that it changes every time the tunnel restarts. The second is the Pages
site, which is stable but only reaches the backend once the address below it has been pushed.

Option 5 rotates the secret: it mints a new one, restarts the proxy so it takes effect, and
prints the `gh secret set` line to run afterwards. Everyone on the old link is cut off
immediately, including the deployed site until the repository secret is updated.

Both the proxy and the tunnel are started detached — output in `proxy.log` and `tunnel.log`,
pids in `.proxy.pid` and `.tunnel.pid` — so closing the menu leaves them running.
Non-interactive forms for scripts and shortcuts:

```bash
node scripts/setup.js check          # checks only; exit 1 if something is missing
node scripts/setup.js start
node scripts/setup.js status         # proxy and tunnel
node scripts/setup.js stop
node scripts/setup.js tunnel         # prints the trycloudflare address
node scripts/setup.js tunnel-stop
node scripts/setup.js backend        # link, address and secret; copies the secret
```

## Local development

```bash
npm install
npm run assets     # copy the proxy assets into public/m/ (renamed)
npm start          # http://localhost:8080, runs in the foreground
```

## Exposing the backend

`npm run setup` can do this for you (**Start a tunnel**), or by hand:

```bash
cloudflared tunnel --url http://localhost:8080
```

Either way you get a free `https://<random>.trycloudflare.com` URL. Paste it straight into
**Backend settings** on the site -- `https://` is converted to `wss://`, and `/wisp/` plus the
backend token (below) are appended automatically.

Quick tunnels get a new random hostname on every restart. For a stable address, log in with
`cloudflared tunnel login` and create a named tunnel bound to a domain.

## The backend token

The wisp socket is the part that actually opens connections to target sites, so it is gated by
a shared secret: the backend accepts `/wisp/<token>/` and refuses everything else with a 401.
Without it the tunnel address is an open relay — anyone who turns up the hostname can route
traffic through this machine, under this IP.

`npm start` generates the token on first run and saves it to `.wisp-token` (gitignored; set
`WISP_TOKEN` in the environment to override it). The frontend needs it too, and gets it without
it ever entering git:

- **Locally**, `src/server.js` substitutes it into `app.js` as it serves the file.
- **On Pages**, the deploy workflow substitutes it from the `WISP_TOKEN` repository secret
  (*Settings → Secrets and variables → Actions*). Set that secret to the contents of
  `.wisp-token`, or the deployed site loads and then reports `backend unreachable`.

`WISP_TOKEN` in `public/app.js` therefore stays empty in the repo. Writing it in by hand works,
but commits the credential to a public repo, which is the thing this is meant to avoid.

To rotate it, use **Change the backend secret** in `npm run setup` — it mints a new one,
restarts the backend, and prints the `gh secret set` line to run afterwards. By hand it is
the same three steps: delete `.wisp-token`, restart the backend, update the secret.

**What this does and does not buy.** It closes the case where someone finds the tunnel hostname
on its own — scanning, a leaked `Referer`, certificate transparency — which is the realistic
way an open relay gets discovered and abused. It does not hide the token from anyone who loads
the site: the page is static and public, so the token is readable in devtools like everything
else here. Real per-user authentication needs a server-side gate, not a static frontend.

## When pages are slow

```bash
npm run doctor
```

Summarises what the backend has failed to reach (from `proxy.log`), then times DNS and TCP
against those hosts right now. A page waits for its subresources, so a few hosts that never
answer are enough to make a fast site feel like a 30-second one — a dead address costs the
full OS connect timeout, about 21 seconds on Windows.

Two knobs, both environment variables on the backend:

| Variable | Default | What it does |
|---|---|---|
| `WISP_CONNECT_TIMEOUT` | `5000` | Milliseconds to wait for a destination before giving up. Caps the ~21s the OS would otherwise take. |
| `WISP_DNS` | unset | Comma-separated resolvers, e.g. `1.1.1.1,1.0.0.1`. Worth trying if a router or ISP resolver answers blocked ad domains with a dead address instead of NXDOMAIN. Leave unset if the network blocks outbound DNS. |

`src/tcp.js` replaces wisp's socket with one that resolves every address for a host and takes
whichever answers first, rather than committing to one address with no timeout and no second
try. If wisp-js internals ever move, it logs a warning and falls back to the stock socket.

If nothing is failing and pages are still slow, the transport is the next suspect: libcurl
opens a fresh connection per request. Switch it to epoxy in the settings panel and compare.

## Sharing

`DEFAULT_WISP` in `public/app.js` is the backend everyone gets out of the box, so people you
share the link with do not have to configure anything. When the quick tunnel rotates its
hostname, update that constant and push -- Pages redeploys automatically.

The settings are doubly hidden. Nothing about the backend appears on the page at all until the
pass phrase (`MAGIC_WORD` in `public/app.js`, currently **rich**) is typed into the search box;
that reveals a panel which still asks for the password before showing or changing the address.
The password is stored as a SHA-256 hash rather than in the clear, since this repo is public.

**Neither of these is security.** The page is static, so `app.js` is readable by anyone and
both checks can be bypassed from devtools in seconds. They keep the panel out of the way of
people you shared the link with; they do not keep out anyone who wants in.

Everything diagnostic lives inside that panel and nowhere else. The backend indicator (which
opens the wisp socket and drops it again to see whether the machine is awake) is in there, and
so is the text of the last failure. The front page only ever says `Error` — service worker
failures, transport failures and the rest are filed in the panel rather than printed on screen.

When a page fails to load, Scramjet's own error screen (full stack trace, proxied URL, build
number, backend hostname) is replaced by a plain “That didn't load” page. Typing the pass
phrase on that page brings the original diagnostics back — the swap happens in `public/sw.js`,
which carries the real page along inside the replacement.

## Notes

- `syncxhr` is disabled. It is the only Scramjet feature requiring `SharedArrayBuffer`, which
  needs COOP/COEP response headers, which GitHub Pages cannot set. Sites that use
  `SharedArrayBuffer` themselves may not fully work; everything else does.
- All frontend paths are computed from the page's own directory, so the project site path
  (`/<repo>/`) works without a custom domain.
- This pins Scramjet v1.1.0, matching the upstream reference app. v1 logs a notice recommending
  v2; upgrading is a follow-up.
- The start screen has a **Home / AI** segmented switch (top-centre, sliding indicator). **AI** opens **IkonAI** — Google Gemini embedded under an IkonAI header (labelled “Runs on Google Gemini”), always via Ultraviolet, preloaded in the background on load so it opens instantly.
- **Panic** is now a hotkey, set via the settings cog (top-right of Home): press the bound key anywhere to redirect the whole tab to plain `google.com` and attempt to close it. The toolbar panic button was removed.
- The toolbar address bar shows a **Go** button (external-link icon) once you type, for no-keyboard use. Both engines' failure pages (Scramjet and Ultraviolet) are masked by the same custom page; typing the pass phrase on it reveals the real diagnostics.
- In fullscreen the toolbar auto-hides; a 16px strip at the top of the screen brings it back on hover (pure CSS, `body.fs #peek:hover + #toolbar`).
- The logo (hero mark and favicon) is an inline SVG in `public/index.html` — an app-icon-style rounded square with a keyhole, no external image file.
- Bookmarks are saved per-browser (localStorage `ikonic.bookmarks`). The star in the browser
  toolbar toggles the current page; saved pages show as tiles under **Bookmarks** on the
  start screen. Tiles are letter-avatars derived from the hostname — no favicon is fetched
  from the real site, which would defeat the point of the proxy.
- The first page opens behind the start screen: the button you clicked spins in place and the
  screen only flips to the browser once the page is in, so it does not blank out mid-click.
- The launcher icons in `public/icons/` are each site's own favicon, downloaded once and
  committed. Nothing is fetched from a third-party icon service at runtime.
- `public/sw.js` calls `skipWaiting()` and `clients.claim()`. Without them an edited worker
  sits in “waiting” until every tab using the old one is closed, and changes to it look like
  they simply did not happen.
- Search defaults to DuckDuckGo. Google fingerprints proxied traffic and answers most searches
  through here with a reCAPTCHA “unusual traffic” page: every request arrives from one home IP
  with a rewritten browser fingerprint, which is exactly what its bot heuristics look for.
  DuckDuckGo does not care. Google still works if you type it in; expect challenges.
- Two rewriters ship, both inside the one service worker and told apart by URL prefix:
  **Scramjet** (`m/p1/`) and **Ultraviolet** (`m/p2/`). The engine picker has three settings and
  defaults to **Smart**: Ultraviolet on the chat sites (its uploads work where Scramjet v1's
  hang) and Scramjet everywhere else. The chat-site list is `AI_HOSTS` in `public/app.js`. A
  navigation that needs the other engine rebuilds the frame, so switching between a normal site
  and a chat site Just Works. `public/cfg.js` replaces Ultraviolet's stock config because that
  one hardcodes root-absolute paths, which break on a `/<repo>/` project site.
- **Asset names are de-signatured.** Everything the browser fetches lives under `public/m/`
  with neutral names (`m/e1/e1.js`, `m/e2/e2.js`, `m/p1/`, `m/p2/`, ...) rather than
  `scram/scramjet.all.js`, `/uv/service/` and friends, which content-inspecting school filters
  (Linewize, Securly, GoGuardian, ...) match on. `scripts/copy-assets.js` owns the mapping.
  Caveat: the minified bundle *bodies* still contain their original identifiers
  (`$scramjet`, `__uv$config`, `Ultraviolet`); renaming the files does not rewrite those, so a
  filter doing deep JS content-inspection can still fingerprint it. Fully evading that needs a
  rebuilt ("forked") bundle, which this does not do.
- Two transports ship: **libcurl** (WASM curl, the default) and **epoxy** (Rust TLS). The
  picker is at the top of the pass-phrase panel and needs no password. libcurl is the one that
  throws `error code 35: SSL connect error` on some hosts and stalls on some uploads, so epoxy
  is the first thing to try when a site misbehaves. The choice is per-browser and applies from
  the next page you open.
- File uploads to ChatGPT, Gemini and DuckDuckGo hang on an endless spinner under Scramjet, on
  either transport. Chatting works, so this is not the site blocking you — a challenge shows an
  error, not a spinner. Smart mode routes those sites through Ultraviolet automatically, which
  is why uploads work; forcing Scramjet on them brings the hang back.
  One candidate cause, visible in `public/m/e1/e1.js`: with `syncxhr` off, Scramjet
  v1's `XMLHttpRequest.prototype.send` hook logs `ignoring request - sync xhr disabled in flags`
  and returns without sending anything — no request, no error, no events, so a caller waits
  forever. `syncxhr` needs `SharedArrayBuffer`, which needs COOP/COEP headers, which GitHub
  Pages cannot set.

## Licence

Scramjet and its transports belong to [Mercury Workshop](https://github.com/MercuryWorkshop).
