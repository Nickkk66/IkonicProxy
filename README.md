# Ikonic

A self-hosted [Scramjet](https://github.com/MercuryWorkshop/scramjet) deployment, split across two hosts:

| Piece | Runs on | Why |
|---|---|---|
| Frontend (`public/`) | GitHub Pages | Static files only — free, HTTPS included |
| Wisp backend (`src/server.js`) | Your PC | Opens the actual sockets; cannot run on Pages |

GitHub Pages executes no server code, so the wisp backend **must** run on your machine and be
reachable over `wss://`. A tunnel provides that for free without port forwarding -- Cloudflare,
Tailscale or Microsoft, picked during setup. Most people skip Pages entirely and just hand out
the tunnel link: the backend serves the frontend too, so the link is the whole thing.

## How it works

Nothing you browse ever leaves the browser as a plain request for the real site. Every
hop below exists so that the only thing your network sees is one WebSocket to one address.

```
your browser
  │  the page you asked for, e.g. youtube.com
  ▼
service worker (public/sw.js)  ─ rewrites the page so every link, script and fetch
  │                               points back into the proxy instead of the real site
  │                               (Scramjet 2 by default; Scramjet 1 and Ultraviolet
  │                               are also there, picked from the settings panel)
  ▼
transport (libcurl / epoxy)    ─ a TLS client compiled to WebAssembly. The browser
  │                               never opens a connection to the site itself; this
  │                               does the TLS, inside the page, and speaks wisp
  ▼
one WebSocket ────────────────── wss://<address>/wisp/<secret>/
  │
  ▼  (Cloudflare Tunnel, when the frontend is on GitHub Pages)
cloudflared on your PC ───────── a free trycloudflare.com address that forwards to
  │                               localhost:8080, so nothing is port-forwarded
  ▼
wisp backend (src/server.js)  ─ Node, on your PC. Opens the real TCP socket to the
  │                               site and shuttles bytes between it and the WebSocket
  ▼
the real site
```

**Wisp** is the protocol on that WebSocket. It is a small multiplexing scheme: many TCP
streams (one per connection the page would have made) carried over one socket, each
packet tagged with a stream id. The backend does no TLS and never sees page content --
TLS is done end-to-end by the transport in the browser -- it only opens sockets to the
hostnames it is told and copies bytes. That is why it can be so small, and why the
secret in the path matters: whoever has the address can open sockets from your PC.

**Sharing a link is safe** because the link alone does nothing. The backend's secret used to be
written into the page it served, so whoever had the address had the proxy -- and rotating the
address only helped until someone passed the new one on. Now the page carries no secret: it
asks for an **access code**, sends it to the backend, and only then receives the token that
opens the socket. You hand out the link *and* the code. The code can be changed any time
without the address moving, wrong guesses cost a second each and a burst of them pauses the
endpoint, and changing the backend secret logs every browser out at once.

Two ways to run it:

- **Locally.** Frontend and backend both from `http://localhost:8080` on your own PC.
  No tunnel, no deploy, nothing to configure -- `npm run setup` then **Start locally**.
  Only that machine can reach it.
- **Shared.** Frontend on GitHub Pages, backend on your PC behind a Cloudflare Tunnel.
  Anyone with the Pages link uses your PC as their exit. Start a tunnel from the menu,
  use its address as the site default, commit, push.

## Setup

```bash
npm run setup      # or double-click setup.cmd on Windows
```

The first run is a short walk-through, once:

1. **Checks** -- Node 18+, dependencies, the browser assets in `public/m/`, the frontend
   files, the two secrets, and whichever tunnel tool you pick. Anything missing that can be
   fixed automatically (`npm install`, `npm run assets`) is offered on the spot.
2. **Secrets** -- the *backend secret* (`.wisp-token`, generated, never leaves the PC) and
   the *access code* (`.access-code`, generated as something sayable like `amber-fox-42`;
   keep it or type your own). The code is what you give people.
3. **How people reach it** -- just this PC, a **Cloudflare** quick tunnel, **Tailscale
   Funnel**, or **Microsoft Dev Tunnels**. The tool you choose is installed if it is not
   there (`winget` on Windows) and signed in if it needs to be. Change it any time with
   *Run first-time setup again*.

After that it is the menu:

```
╭─ Status ──────────────────────────────────────────╮
│ Proxy   running  port 8080, pid 22816             │
│ Tunnel  https://outlet-fleece.trycloudflare.com   │
╰───────────────────────────────────────────────────╯
  1) Open it locally  http://localhost:8080
  2) Stop the proxy
  3) Stop the tunnel  Cloudflare quick tunnel
  4) Use that address as the Pages default  edits public/app.js
  5) Show the link and access code  copies the code
  6) Change the access code
  7) Change the backend secret  logs everyone out
  8) Run first-time setup again  tunnel provider, secrets, checks
  9) Close
```

Option 1 is the quick way up: it starts the proxy if it is not running and opens
`http://localhost:8080` in your browser -- no tunnel, nothing to configure. Entries flip to
their opposite depending on what is running. *Use that address as the Pages default* only
appears once a tunnel address is known, and only matters if you deploy the frontend to Pages;
served from the tunnel itself the page finds the backend on its own origin.

Starting anything prints the same block option 5 does -- the link, the access code (put on the
clipboard), and the plumbing underneath -- so the thing to send someone is always in front
of you.

Non-interactive forms, for shortcuts and other scripts:

```bash
node scripts/setup.js local         # proxy up + browser open
node scripts/setup.js start|stop    # the proxy
node scripts/setup.js tunnel|tunnel-stop
node scripts/setup.js status|check|backend|code
node scripts/setup.js setup         # the first-time walk-through again
```

### Tunnels

| Provider | Account | Address | Notes |
|---|---|---|---|
| Cloudflare quick tunnel | none | new random name every start | zero setup; the name changes whenever the tunnel restarts |
| Tailscale Funnel | free Tailscale | stable `<pc>.<tailnet>.ts.net` | best for people who come back; Funnel is enabled once per tailnet from the admin console, Tailscale prints the link |
| Microsoft Dev Tunnels | free Microsoft | random `*.devtunnels.ms` per start | started with anonymous access on, so visitors need no account |

All three end in an `https://` address forwarding to `localhost:8080`, which is what the
service worker needs (no HTTPS, no service worker, no proxy). Raw TCP forwarders that hand
out `http://` or a bare port will not work.
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
- **Scramjet 2 is the engine Smart picks.** It is installed alongside v1 under an npm alias
  rather than replacing it, so both are on disk and both are in the engine picker. v2 is still
  published as an alpha, which is why v1 is kept: if a site breaks under v2, the picker has a
  working fallback. v2 is what makes YouTube play -- see the note further down.
- **`sourcemaps` is off for Scramjet 2.** Left on (its default) a YouTube watch page kills the
  tab within about eight seconds -- Edge shows "This page is having a problem", error code
  `STATUS_BREAKPOINT`. It is not memory: the renderer never grows past a few hundred MB before
  it goes. Source maps are a debugging aid and building one for every script the engine
  rewrites is expensive on a site that ships multi-megabyte bundles, so there is nothing to
  miss by turning them off.
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
- `public/sw.js` calls `skipWaiting()` and `clients.claim()`, both held open with
  `waitUntil()`. Without them an edited worker sits in “waiting” until every tab using the old
  one is closed, and changes to it look like they simply did not happen. The `waitUntil` is not
  decoration: `skipWaiting()` returns a promise, and calling it bare lets install finish first,
  at which point the worker is already parked in “waiting” and the call has nothing left to
  skip -- the exact failure the line is there to prevent.
- **GitHub Pages needs no secret any more.** The workflow used to inject the backend token
  into `app.js` from a repository secret; the page now earns the token with the access code,
  so the only thing a Pages deploy needs is `DEFAULT_WISP` pointing at the backend's current
  address (menu option *Use that address as the Pages default*, then commit and push).
- **Adverts and trackers are refused outright**, listed in `public/blocked.js`. This is not a
  taste decision, it is what makes several sites work at all. A proxied page's real URLs are
  invisible to whatever ad blocker the browser has, so everything the blocker would normally
  kill is actually attempted; and on a filtered connection these hosts do not refuse the
  connection, they swallow it, so each one costs the full connect timeout. Worse, a site that
  is waiting on an advert waits for the page too: higherlowergame's game-over screen never drew
  after a wrong answer, and YouTube never asked for the video. Failing them instantly, the way
  a blocker does, puts a site on the error path it already has. The list is loaded in three
  places -- the page, the service worker, and the transport wrapper Scramjet 2 needs, since v2
  fetches a page's subresources itself and the worker never sees most of them.
- **View transitions are switched off inside proxied pages** (`guardCompositor()` in
  `public/app.js`). This is what stops the tab dying on YouTube -- "This page is having a
  problem", `STATUS_BREAKPOINT`. Every crash dump ends on the Compositor thread inside Edge's
  `cc::draw_property_utils::CalculateDrawProperties`, and the checks page content can reach
  there are the view-transition ones. YouTube runs a view transition when it goes from the
  feed to a video; on the real site its embedded frames are cross-origin and get their own
  compositor, but through the proxy every frame is one origin and they all share one, which
  is where those checks trip. Taking `view-transition-name` off everything leaves the
  transition nothing to capture. It is an official-build CHECK -- not memory, not an
  exception -- so this is the only place it can be handled.
- **The page pings the service worker every twenty seconds while a site is open.** An idle
  worker is evicted after about half a minute, and the replacement knows none of Scramjet 2's
  routing; its re-pairing fails ("All clients returned an invalid MessagePort") and every
  request then falls through to the static host as a bare `404` -- a page that loads its
  document and then nothing else. A worker that is never idle is never evicted.
- **A failed subresource fails like the network does.** Only a whole page gets the failure
  screen; anything else gets a real network error. Handing back a 500 carrying HTML in place of
  a script or an image means the browser sees a response, so `fetch()` resolves, `onerror`
  never fires, and the site's own fallback never runs.
- Search defaults to DuckDuckGo. Google fingerprints proxied traffic and answers most searches
  through here with a reCAPTCHA “unusual traffic” page: every request arrives from one home IP
  with a rewritten browser fingerprint, which is exactly what its bot heuristics look for.
  DuckDuckGo does not care. Google still works if you type it in; expect challenges.
- Three rewriters ship, all inside the one service worker and told apart by URL prefix:
  **Scramjet 1** (`m/p1/`), **Ultraviolet** (`m/p2/`) and **Scramjet 2** (`m/p3/`). The engine
  picker has four settings and defaults to **Smart**: Ultraviolet on the chat sites (its uploads
  work where Scramjet v1's hang) and Scramjet 2 everywhere else. The chat-site list is
  `AI_HOSTS` in `public/app.js`. A navigation that needs a different engine rebuilds the frame,
  so switching between a normal site and a chat site Just Works. `public/cfg.js` replaces
  Ultraviolet's stock config because that one hardcodes root-absolute paths, which break on a
  `/<repo>/` project site.
- Scramjet 2 is wired differently from the other two, and the differences are load-bearing:
  - Its controller is a **separate script** (`m/c3/`) that has to be handed the live service
    worker, and the page must actually be **claimed** before a frame is built. A frame opened
    while the page is merely registered has its requests go straight past the worker to the
    static host, which answers a bare `404`.
  - It does **not** use bare-mux. It takes a transport object directly, and it wants libcurl 2,
    which is aliased in beside the older libcurl the other two use (`m/t3/` against `m/t1/`).
  - Its proxied URLs are `m/p3/<controller id>/<frame id>/<address>`, with the address left
    unencoded -- so reading the real address back means stripping two path segments, not a
    layer of encoding. `unprefixScramjet2()` in `public/app.js` does that.
  - It announces nothing on navigation, so the address bar is polled rather than pushed to.
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
