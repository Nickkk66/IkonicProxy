"use strict";

// GitHub Pages project sites live at https://<user>.github.io/<repo>/, so
// nothing can be hardcoded to "/". Every path below is built from BASE, which
// is the directory this page is served from.
const BASE = new URL(".", location.href).pathname;

// Default wisp backend, so people you share this with don't have to configure
// anything. Quick tunnels rotate their hostname on every cloudflared restart --
// `npm run setup` can rewrite this line for you.
const DEFAULT_WISP = "wss://outlet-fleece-onion-compromise.trycloudflare.com/wisp/";

// SHA-256 of the settings password. Hashed rather than stored literally so the
// password itself isn't sitting in a public repo. NOTE: this is a client-side
// check on a static page -- it stops accidental edits, it is not security.
const PW_HASH = "7baa68f2418ba82d2545a780c00d7a8778249bbcdaf7369114534874ea6d3bd6";

// Typing this into the search box reveals the backend settings, which are
// otherwise not on the page at all. Same caveat as the password: it keeps the
// panel out of sight, it does not keep anyone out.
const MAGIC_WORD = "rich";

// Google challenges anything that looks like a proxy, so it makes a poor
// default search -- see the README.
const SEARCH_URL = "https://duckduckgo.com/?q=";

const WISP_KEY = "scramjet.wispUrl";
const TRANSPORT_KEY = "scramjet.transport";
const ENGINE_KEY = "scramjet.engine";

const form = document.getElementById("form");
const address = document.getElementById("address");
const wispInput = document.getElementById("wisp");
const pwInput = document.getElementById("pw");
const status = document.getElementById("status");
const settingsEl = document.getElementById("settings");
const lockedEl = document.getElementById("locked");
const unlockedEl = document.getElementById("unlocked");
const unlockBtn = document.getElementById("unlock");
const saveBtn = document.getElementById("save");
const resetBtn = document.getElementById("reset");
const beaconDot = document.getElementById("beacondot");
const beaconText = document.getElementById("beacontext");
const settingsClose = document.getElementById("settingsclose");
const diagnostics = document.getElementById("diagnostics");
const lastErrorEl = document.getElementById("lasterror");
const transportInputs = document.querySelectorAll('input[name="transport"]');
const engineInputs = document.querySelectorAll('input[name="engine"]');

const landing = document.getElementById("landing");
const browser = document.getElementById("browser");
const toolbar = document.getElementById("toolbar");
const viewport = document.getElementById("viewport");
const navForm = document.getElementById("navform");
const navUrl = document.getElementById("navurl");
const backBtn = document.getElementById("back");
const forwardBtn = document.getElementById("forward");
const reloadBtn = document.getElementById("reload");
const fullscreenBtn = document.getElementById("fullscreen");
const closeBtn = document.getElementById("close");
const berror = document.getElementById("berror");
const spinner = document.getElementById("spinner");
const goBtn = document.getElementById("go");
const bookmarkBtn = document.getElementById("bookmark");
const bookmarksSection = document.getElementById("bookmarks");
const bookmarkList = document.getElementById("bookmarklist");

/**
 * When this page is served by the backend itself (npm start / npm run setup),
 * talk to that rather than the tunnel -- local testing then needs no setup at
 * all, and it cannot be broken by the tunnel hostname having rotated.
 */
function defaultWisp() {
  const host = location.hostname;
  // Served by the local server directly, or by a Cloudflare tunnel pointing at
  // it -- in both cases the whole app (frontend + wisp) is one origin, so the
  // backend is same-origin and does not depend on any hardcoded address.
  if (["localhost", "127.0.0.1"].includes(host) || host.endsWith(".trycloudflare.com")) {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";
  }
  return DEFAULT_WISP;
}

function getWispUrl() {
  return localStorage.getItem(WISP_KEY) || defaultWisp();
}

/**
 * Which of the two bare transports carries the traffic. libcurl is a WASM curl;
 * epoxy is a Rust TLS client. They fail in different places -- libcurl is the
 * one that throws "SSL connect error" and stalls on some uploads -- so this is
 * the first thing to flip when a site misbehaves.
 */
function getTransport() {
  return localStorage.getItem(TRANSPORT_KEY) === "epoxy" ? "epoxy" : "libcurl";
}

// Sites where Ultraviolet is used automatically in Smart mode -- the chat
// services whose file uploads Scramjet v1 cannot carry. Matched on the
// registrable-ish host, so subdomains (chat.openai.com, sora.chatgpt.com) count.
const AI_HOSTS = [
  "chatgpt.com", "openai.com", "claude.ai", "anthropic.com",
  "gemini.google.com", "aistudio.google.com", "bard.google.com",
  "duck.ai", "perplexity.ai", "copilot.microsoft.com",
  "poe.com", "character.ai", "meta.ai", "grok.com", "x.ai",
  "deepseek.com", "mistral.ai", "huggingface.co",
];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAiSite(url) {
  const h = hostOf(url);
  return AI_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

/**
 * The engine preference: "auto" (Smart, the default), or a forced "scramjet" /
 * "uv". Both rewriters live in the one service worker and share the transport,
 * so the choice only decides which kind of frame a page opens in.
 */
function getEnginePref() {
  const v = localStorage.getItem(ENGINE_KEY);
  return v === "scramjet" || v === "uv" ? v : "auto";
}

/** Which engine a given URL should actually open in. */
function resolveEngine(url) {
  const pref = getEnginePref();
  if (pref !== "auto") return pref;
  // Smart: Ultraviolet for the chat sites (uploads), Scramjet for the rest.
  return isAiSite(url) ? "uv" : "scramjet";
}

function setStatus(msg, kind = "") {
  status.textContent = msg;
  status.className = kind;
}

// The last error is kept here so it survives a reload and can be read back in
// the pass-phrase panel -- handy for IkonAI, which has no address bar of its
// own to reach the panel from.
const DIAG_KEY = "ikonic.lastError";

let diagWriteTimer = null;
function logDiag(text) {
  const stamped = String(text || "").slice(0, 4000);
  lastErrorEl.textContent = stamped;
  diagnostics.hidden = false;
  if (diagWriteTimer) return;
  diagWriteTimer = setTimeout(() => {
    diagWriteTimer = null;
    try {
      localStorage.setItem(DIAG_KEY, lastErrorEl.textContent);
    } catch {}
  }, 1000);
}

/**
 * What went wrong is nobody's business but yours: the page says "Error" and
 * the actual message -- service worker failures, transport failures, whatever
 * it was -- is filed in the pass-phrase panel.
 */
function reportFailure(err) {
  logDiag(err && err.stack ? err.stack : String(err && err.message ? err.message : err));
  console.error(err);
  return "Error";
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Accepts whatever cloudflared prints (https://host) as well as ws:// and wss://
 * and bare hostnames, and returns a usable wisp websocket URL.
 */
function normalizeWisp(raw) {
  let v = (raw || "").trim();
  if (!v) return null;

  if (/^https:\/\//i.test(v)) v = "wss://" + v.slice(8);
  else if (/^http:\/\//i.test(v)) v = "ws://" + v.slice(7);
  else if (!/^wss?:\/\//i.test(v)) v = "wss://" + v;

  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }

  // wisp is served at /wisp/ -- add it if only the origin was pasted.
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/wisp/";
  if (!u.pathname.endsWith("/")) u.pathname += "/";

  return u.toString();
}

// --- backend beacon --------------------------------------------------------

function setBeacon(state, text) {
  beaconDot.className = "dot " + state;
  beaconText.textContent = text;
}

/**
 * Opens the wisp socket and drops it again, purely to find out whether the
 * machine on the other end is awake. It says nothing about where that machine
 * is: the address itself stays behind the password.
 */
function probeBackend() {
  setBeacon("checking", "checking backend");

  let socket;
  try {
    socket = new WebSocket(getWispUrl());
  } catch {
    setBeacon("down", "backend unreachable");
    return;
  }

  let settled = false;
  const finish = (state, text) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    setBeacon(state, text);
    try {
      socket.close();
    } catch {}
  };

  const timer = setTimeout(() => finish("down", "backend not responding"), 8000);
  socket.addEventListener("open", () => finish("ready", "backend ready"));
  socket.addEventListener("error", () => finish("down", "backend unreachable"));
  socket.addEventListener("close", () => finish("down", "backend unreachable"));
}

// --- settings --------------------------------------------------------------

function revealSettings() {
  settingsEl.hidden = false;
  probeBackend();
  settingsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  (lockedEl.hidden ? wispInput : pwInput).focus();
}

const ENGINE_NAMES = { auto: "Smart", scramjet: "Scramjet", uv: "Ultraviolet" };

for (const input of engineInputs) {
  input.checked = input.value === getEnginePref();
  input.addEventListener("change", () => {
    if (!input.checked) return;
    localStorage.setItem(ENGINE_KEY, input.value);
    // Any live frame belongs to the old choice, so it goes; the next page
    // opens under the new one.
    exitBrowser();
    const how = input.value === "auto" ? "Smart: Ultraviolet on chat sites, Scramjet elsewhere." : `Using ${ENGINE_NAMES[input.value]}.`;
    setStatus(how, "ok");
  });
}

for (const input of transportInputs) {
  input.checked = input.value === getTransport();
  input.addEventListener("change", () => {
    if (!input.checked) return;
    localStorage.setItem(TRANSPORT_KEY, input.value);
    // Force the next navigation to dial again through the new transport.
    connecting = null;
    setStatus(`Using ${input.value}. Open a page to try it.`, "ok");
  });
}

settingsClose.addEventListener("click", () => {
  settingsEl.hidden = true;
  setStatus("");
  address.focus();
});

// The backend address is only written into the DOM once unlocked.
unlockBtn.addEventListener("click", async () => {
  if ((await sha256hex(pwInput.value)) !== PW_HASH) {
    setStatus("Wrong password.", "err");
    pwInput.value = "";
    return;
  }
  pwInput.value = "";
  wispInput.value = getWispUrl();
  lockedEl.hidden = true;
  unlockedEl.hidden = false;
  setStatus("");
});

saveBtn.addEventListener("click", () => {
  const url = normalizeWisp(wispInput.value);
  if (!url) {
    setStatus("Could not read that as a URL.", "err");
    return;
  }
  // An HTTPS page cannot open an insecure ws:// socket; the browser blocks it
  // as mixed content. Catch it here rather than as an opaque console error.
  if (location.protocol === "https:" && url.startsWith("ws://")) {
    setStatus("This page is HTTPS, so the backend must be wss:// (not ws://).", "err");
    return;
  }
  localStorage.setItem(WISP_KEY, url);
  wispInput.value = url;
  // Drop the cached transport so the next navigation dials the new address.
  connecting = null;
  setStatus("Saved: " + url, "ok");
  probeBackend();
});

resetBtn.addEventListener("click", () => {
  localStorage.removeItem(WISP_KEY);
  wispInput.value = defaultWisp();
  connecting = null;
  setStatus("Reset to the default backend.", "ok");
  probeBackend();
});

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
  // Must sit inside the service worker's scope (BASE) or the worker will
  // never see the proxied requests.
  prefix: BASE + "m/p1/",
  files: {
    wasm: BASE + "m/e1/e1.wasm",
    all: BASE + "m/e1/e1.js",
    sync: BASE + "m/e1/e1s.js",
  },
  flags: {
    // syncxhr is the one feature needing SharedArrayBuffer, which needs
    // COOP/COEP headers, which GitHub Pages cannot set. Leave it off.
    syncxhr: false,
    rewriterLogs: false,
    scramitize: false,
  },
});

scramjet.init();

const connection = new BareMux.BareMuxConnection(BASE + "m/mx/worker.js");

async function registerSW() {
  if (!navigator.serviceWorker) {
    throw new Error(
      location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)
        ? "Service workers need HTTPS (or localhost)."
        : "This browser does not support service workers."
    );
  }
  await navigator.serviceWorker.register(BASE + "sw.js", { scope: BASE });
  await navigator.serviceWorker.ready;
}

function toUrl(input) {
  const v = input.trim();
  if (!v) return null;
  try {
    return new URL(v).toString();
  } catch {}
  if (/^[^\s/]+\.[^\s/]+/.test(v)) return "https://" + v;
  return SEARCH_URL + encodeURIComponent(v);
}

// --- bookmarks -------------------------------------------------------------

const BOOKMARKS_KEY = "ikonic.bookmarks";

function loadBookmarks() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((b) => b && b.url) : [];
  } catch {
    return [];
  }
}

function saveBookmarks(list) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
}

function bookmarkLabel(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// A stable colour per site, so a bookmark keeps the same tile between visits.
function hueFor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function letterAvatar(host) {
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.style.background = `hsl(${hueFor(host)} 52% 42%)`;
  avatar.textContent = host.charAt(0).toUpperCase();
  return avatar;
}

function renderBookmarks() {
  const list = loadBookmarks();
  bookmarkList.textContent = "";
  bookmarksSection.hidden = list.length === 0;

  for (const bm of list) {
    const host = bookmarkLabel(bm.url);

    const tile = document.createElement("a");
    tile.href = "#";
    tile.title = bm.url;

    let mark;
    if (bm.icon) {
      mark = document.createElement("img");
      mark.className = "favicon";
      mark.src = bm.icon;
      mark.alt = "";
      // A proxied icon URL can go stale; fall back to the letter avatar.
      mark.addEventListener("error", () => mark.replaceWith(letterAvatar(host)));
    } else {
      mark = letterAvatar(host);
    }

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = host;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "✕";
    remove.title = "Remove bookmark";
    remove.setAttribute("aria-label", "Remove " + host);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      saveBookmarks(loadBookmarks().filter((b) => b.url !== bm.url));
      renderBookmarks();
    });

    tile.append(mark, label, remove);
    tile.addEventListener("click", (event) => {
      event.preventDefault();
      openUrl(bm.url, tile);
    });
    bookmarkList.appendChild(tile);
  }
}

/** The toolbar star reflects whether the current page is already saved. */
function syncBookmarkButton() {
  const on = Boolean(currentUrl) && loadBookmarks().some((b) => b.url === currentUrl);
  // The ribbon fills via CSS on the `.on` class; the glyph is not set here.
  bookmarkBtn.classList.toggle("on", on);
  bookmarkBtn.setAttribute("aria-pressed", String(on));
  bookmarkBtn.title = on ? "Remove bookmark" : "Bookmark this page";
}

// --- browser view ----------------------------------------------------------

// The one live frame, and which engine built it. Kept across navigations so
// back/forward history survives typing a new address into the toolbar; rebuilt
// only when a navigation needs the other engine.
let activeFrame = null;
let activeEngine = null;
// The URL the browser view was last asked to open, used for the one-shot retry.
let lastRequestedUrl = "";

// The real address of whatever the frame is showing. The bar shows a shortened
// form of this, and hands the full thing back when it is focused.
let currentUrl = "";

function setLoading(on) {
  toolbar.classList.toggle("loading", on);
  spinner.hidden = !on;
}

function setError(msg) {
  berror.textContent = msg || "";
  berror.hidden = !msg;
}

/**
 * https://example.com/a?b -> example.com/a?b
 *
 * Drops the scheme the way a browser address bar does, but only for https.
 * Plain http keeps its scheme visible, since that difference matters.
 */
function prettyUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "https:") return url;

  const rest = u.pathname === "/" && !u.search && !u.hash ? "" : u.pathname + u.search + u.hash;
  return u.host + rest;
}

function showAddress(url) {
  currentUrl = url || "";
  // Never clobber what the user is halfway through typing.
  if (document.activeElement !== navUrl) navUrl.value = prettyUrl(currentUrl);
  syncBookmarkButton();
}

function exitBrowser() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  clearTimeout(firstOpenTimer);
  firstOpenTimer = null;
  clearBusy();
  document.body.classList.remove("preloading");
  if (activeFrame) {
    activeFrame.frame.remove();
    activeFrame = null;
    activeEngine = null;
  }
  setLoading(false);
  setError("");
  currentUrl = "";
  navUrl.value = "";
  browser.hidden = true;
  landing.hidden = false;
  document.body.classList.remove("browsing");
  selectTab("home");
  renderBookmarks();
  address.focus();
  address.select();
}

/**
 * Ultraviolet has no frame object of its own, so this gives it the same shape
 * Scramjet's has: go/back/forward/reload plus a `url` that reads back the real
 * address. The proxied document is same-origin, so its location can be read
 * and decoded directly.
 */
function createUltravioletFrame() {
  const el = document.createElement("iframe");

  return {
    frame: el,
    go(url) {
      el.src = __uv$config.prefix + __uv$config.encodeUrl(url);
    },
    back() {
      el.contentWindow?.history.back();
    },
    forward() {
      el.contentWindow?.history.forward();
    },
    reload() {
      el.contentWindow?.location.reload();
    },
    get url() {
      const href = el.contentWindow?.location?.href || "";
      const at = href.indexOf(__uv$config.prefix);
      return at === -1 ? "" : __uv$config.decodeUrl(href.slice(at + __uv$config.prefix.length));
    },
    // Scramjet fires urlchange; Ultraviolet does not, and the frame's own load
    // event covers it.
    addEventListener() {},
  };
}

function ensureFrame(engine) {
  if (activeFrame) return activeFrame;

  const frame = engine === "uv" ? createUltravioletFrame() : scramjet.createFrame();
  frame.frame.id = "frame";
  frame.frame.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
  // Scramjet reports the real (unproxied) location as the page navigates.
  frame.addEventListener("urlchange", (event) => {
    if (event.url) showAddress(event.url);
  });
  frame.frame.addEventListener("load", () => {
    // The initial about:blank load is not a real navigation; ignore it so the
    // deferred flip waits for the actual page.
    const src = frame.frame.src || "";
    if (src && !/about:blank$/.test(src)) commitFirstOpen();

    // The very first request often lands before the wisp transport has finished
    // connecting, so the proxy hands back the error page and it only works on a
    // manual retry. Detect that page and retry once automatically.
    try {
      const doc = frame.frame.contentDocument;
      if (doc && doc.body && doc.body.hasAttribute("data-ikonic-error") && !frame._retried && lastRequestedUrl) {
        frame._retried = true;
        setLoading(true);
        setTimeout(() => frame.go(lastRequestedUrl), 500);
        return;
      }
    } catch {}

    setLoading(false);
    try {
      showAddress(frame.url);
    } catch {}
  });
  viewport.appendChild(frame.frame);
  activeFrame = frame;
  activeEngine = engine;
  return frame;
}

// The service worker and the transport only need setting up once, but every
// navigation depends on them -- including ones typed into the toolbar, which
// would otherwise reach the static host and come back as a bare 404.
let connecting = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error("could not load " + src)));
    document.head.appendChild(el);
  });
}

let ultravioletReady = null;

/** Ultraviolet's bundle is only pulled in if that engine is actually used. */
function ensureUltraviolet() {
  if (!ultravioletReady) {
    ultravioletReady = (async () => {
      await loadScript(BASE + "m/e2/e2.js");
      await loadScript(BASE + "cfg.js");
    })();
    ultravioletReady.catch(() => {
      ultravioletReady = null;
    });
  }
  return ultravioletReady;
}

function ensureConnected() {
  if (!connecting) {
    connecting = (async () => {
      await registerSW();
      const wisp = getWispUrl();
      await (getTransport() === "epoxy"
        ? connection.setTransport(BASE + "m/t2/index.mjs", [{ wisp }])
        : connection.setTransport(BASE + "m/t1/index.mjs", [{ websocket: wisp }]));
    })();
    // A failed attempt must not be remembered, or fixing the backend address
    // in settings would never be retried.
    connecting.catch(() => {
      connecting = null;
    });
  }
  return connecting;
}

// The launcher button (Go, or a tile) spinning while the first page loads,
// and the fallback timer that flips anyway if the page never fires load.
let pendingBusyEl = null;
let firstOpenTimer = null;

function beginBusy(el) {
  // Clear any launcher already spinning -- only one load runs at a time.
  clearBusy();
  pendingBusyEl = el || null;
  if (pendingBusyEl) pendingBusyEl.classList.add("busy");
}

function clearBusy() {
  if (pendingBusyEl) pendingBusyEl.classList.remove("busy");
  pendingBusyEl = null;
}

/** The first page has loaded (or timed out): drop the landing and reveal it. */
function commitFirstOpen() {
  if (!document.body.classList.contains("preloading")) return;
  clearTimeout(firstOpenTimer);
  firstOpenTimer = null;
  clearBusy();
  document.body.classList.remove("preloading");
  landing.hidden = true;
  document.body.classList.add("browsing");
  showAddress(currentUrl);
}

/**
 * Connect if needed, then point the browser view at `url`. The engine is chosen
 * per URL (Smart mode picks Ultraviolet for chat sites), so a navigation that
 * needs the other engine rebuilds the frame. Opening from the landing screen
 * loads the page behind it with `sourceEl` spinning and only flips once it is
 * in, so the screen does not blank out the moment you click.
 */
async function openUrl(url, sourceEl) {
  const want = resolveEngine(url);
  // A different engine needs a different kind of frame; drop the old one.
  if (activeFrame && activeEngine !== want) {
    activeFrame.frame.remove();
    activeFrame = null;
    activeEngine = null;
  }

  const showing = document.body.classList.contains("browsing");
  setError("");

  if (showing) {
    showAddress(url);
  } else {
    beginBusy(sourceEl || goBtn);
    browser.hidden = false;
    document.body.classList.add("preloading");
    currentUrl = url;
  }
  setLoading(true);

  try {
    await ensureConnected();
    if (want === "uv") await ensureUltraviolet();
    lastRequestedUrl = url;
    const frame = ensureFrame(want);
    frame._retried = false; // a fresh navigation gets its own one-shot retry
    frame.go(url);
    if (!showing) firstOpenTimer = setTimeout(commitFirstOpen, 15000);
  } catch (err) {
    setLoading(false);
    const short = reportFailure(err);
    // Nothing has loaded yet, so fall back to the landing page, where the
    // pass phrase can bring up what actually happened. Once a page is up,
    // keep it and say so inline instead.
    if (showing) {
      setError(short);
    } else {
      clearBusy();
      document.body.classList.remove("preloading");
      exitBrowser();
      setStatus(short, "err");
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  if (address.value.trim().toLowerCase() === MAGIC_WORD) {
    address.value = "";
    setStatus("");
    revealSettings();
    return;
  }

  const url = toUrl(address.value);
  if (url) openUrl(url, goBtn);
});

for (const button of document.querySelectorAll(".ai button, .sites button")) {
  button.addEventListener("click", () => openUrl(button.dataset.url, button));
}

navForm.addEventListener("submit", (event) => {
  event.preventDefault();

  // The pass phrase works from the toolbar too: close the page and open the
  // panel, rather than searching for the word.
  if (navUrl.value.trim().toLowerCase() === MAGIC_WORD) {
    navUrl.blur();
    exitBrowser();
    revealSettings();
    return;
  }

  const url = toUrl(navUrl.value);
  if (!url) return;
  navUrl.blur();
  openUrl(url);
});

// Clicking into the bar swaps the shortened address for the real one, the way
// a browser does; leaving it puts the short form back.
navUrl.addEventListener("focus", () => {
  if (currentUrl) navUrl.value = currentUrl;
  navUrl.select();
});
navUrl.addEventListener("blur", () => {
  navUrl.value = prettyUrl(currentUrl);
  navGo.hidden = true;
});
navUrl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") navUrl.blur();
});

// The toolbar Go button shows only when there is something to submit.
const navGo = document.getElementById("navgo");
function syncNavGo() {
  navGo.hidden = navUrl.value.trim() === "";
}
navUrl.addEventListener("input", syncNavGo);
navUrl.addEventListener("focus", syncNavGo);

backBtn.addEventListener("click", () => activeFrame?.back());
forwardBtn.addEventListener("click", () => activeFrame?.forward());
reloadBtn.addEventListener("click", () => {
  if (!activeFrame) return;
  setLoading(true);
  activeFrame.reload();
});
function currentFavicon() {
  try {
    const doc = activeFrame && activeFrame.frame.contentDocument;
    const link = doc && doc.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
    return link ? link.href : "";
  } catch {
    return "";
  }
}

bookmarkBtn.addEventListener("click", () => {
  if (!currentUrl) return;
  const list = loadBookmarks();
  const without = list.filter((b) => b.url !== currentUrl);
  // Clicking an already-saved page removes it; otherwise save it with its icon.
  if (without.length === list.length) {
    without.push({ url: currentUrl, title: bookmarkLabel(currentUrl), icon: currentFavicon() });
  }
  saveBookmarks(without);
  syncBookmarkButton();
  renderBookmarks();
});

closeBtn.addEventListener("click", exitBrowser);

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else browser.requestFullscreen?.().catch((err) => console.error(err));
});

document.addEventListener("fullscreenchange", () => {
  const on = Boolean(document.fullscreenElement);
  fullscreenBtn.title = on ? "Exit fullscreen" : "Fullscreen";
  fullscreenBtn.setAttribute("aria-label", fullscreenBtn.title);
  // In fullscreen the toolbar auto-hides and returns on hover (see style.css).
  document.body.classList.toggle("fs", on);
});

// Panic: leave at once for a plain, un-proxied Google and try to close the tab
// outright. window.close() only works for script-opened tabs, so the redirect
// is the part that always fires -- either way nothing of the proxy is left up.
function panic() {
  try {
    window.open("https://www.google.com/", "_blank");
  } catch {}
  try {
    window.close();
  } catch {}
  window.location.replace("about:blank");
}

// --- settings cog + panic hotkey -------------------------------------------

const PANIC_KEY = "ikonic.panicKey";

const cog = document.getElementById("cog");
const cogPanel = document.getElementById("cogpanel");
const hotkeySet = document.getElementById("hotkey-set");
const hotkeyClear = document.getElementById("hotkey-clear");
const panicNow = document.getElementById("panic-now");

let recordingHotkey = false;

function getPanicKey() {
  return localStorage.getItem(PANIC_KEY) || "";
}

// A readable label for a stored key ("Backquote" -> "`", "Escape" stays).
function keyLabel(code) {
  if (!code) return "Not set";
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace("Backquote", "` (backtick)");
}

function syncHotkeyButton() {
  hotkeySet.textContent = recordingHotkey ? "Press a key…" : keyLabel(getPanicKey());
  hotkeySet.classList.toggle("recording", recordingHotkey);
}

function openCog(open) {
  cogPanel.hidden = !open;
  cog.setAttribute("aria-expanded", String(open));
  if (open) syncHotkeyButton();
  else recordingHotkey = false;
}

cog.addEventListener("click", (event) => {
  event.stopPropagation();
  openCog(cogPanel.hidden);
});

// Click outside closes the panel.
document.addEventListener("click", (event) => {
  if (!cogPanel.hidden && !cogPanel.contains(event.target) && event.target !== cog) openCog(false);
});

hotkeySet.addEventListener("click", () => {
  recordingHotkey = true;
  syncHotkeyButton();
});

hotkeyClear.addEventListener("click", () => {
  localStorage.removeItem(PANIC_KEY);
  recordingHotkey = false;
  syncHotkeyButton();
});

panicNow.addEventListener("click", panic);

// One global listener does two jobs: capture the next keypress while recording,
// and fire panic when the configured key is pressed anywhere.
document.addEventListener("keydown", (event) => {
  if (recordingHotkey) {
    // Ignore bare modifiers so the key recorded is a real trigger.
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    event.preventDefault();
    if (event.code !== "Escape") localStorage.setItem(PANIC_KEY, event.code);
    recordingHotkey = false;
    syncHotkeyButton();
    return;
  }
  const key = getPanicKey();
  if (key && event.code === key) {
    event.preventDefault();
    panic();
  }
});

// --- Home / AI tabs --------------------------------------------------------

const tabs = document.querySelector(".tabs");
const tabIndicator = document.querySelector(".tab-indicator");
const tabButtons = [...document.querySelectorAll(".tab")];
const views = { home: document.getElementById("view-home"), ai: document.getElementById("view-ai") };

function moveIndicator(activeBtn) {
  tabIndicator.style.left = activeBtn.offsetLeft + "px";
  tabIndicator.style.width = activeBtn.offsetWidth + "px";
}

function selectTab(name) {
  for (const btn of tabButtons) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
    if (on) moveIndicator(btn);
  }
  views.home.classList.toggle("active", name === "home");
  views.ai.classList.toggle("active", name === "ai");
  if (name === "ai") {
    ensureAI();
    // Gemini lays out to whatever size it first measured; poke it to re-measure
    // now that the view is on screen, in case it warmed up while hidden.
    requestAnimationFrame(() => {
      try {
        aiFrame.frame.contentWindow.dispatchEvent(new Event("resize"));
      } catch {}
    });
  }
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => selectTab(btn.dataset.tab));
}
// Keep the indicator under the active tab across reflows.
addEventListener("resize", () => {
  const active = tabButtons.find((b) => b.classList.contains("active"));
  if (active) moveIndicator(active);
});

// --- IkonAI: Gemini, preloaded and dressed as our own ----------------------

const IKONAI_URL = "https://gemini.google.com/app";
const aiStage = document.getElementById("ai-stage");
const aiLoading = document.getElementById("ai-loading");
const aiStar = document.querySelector(".tab-ai .star");

// The AI tab star throbs grey while IkonAI is warming up, then returns to its
// steady rainbow once the chat is in.
function setAiStar(loading) {
  aiStar.classList.toggle("loading", loading);
}

// Dark skin, built from Gemini's real DOM: recolour the grey sidebar and Ask
// bar, and hide the marketing / account chrome by its stable data-test-ids --
// New chat is deliberately left in place. Material design tokens are overridden
// too as a fallback for any grey the specific rules miss. A persistent <style>
// in the head survives the SPA's re-renders.
const IKONAI_SKIN = `
  html, body { background: #0f1115 !important; }

  /* The grey side navigation */
  mat-sidenav, .mat-drawer, .mat-drawer-inner-container,
  side-navigation-content, .sidenav-with-history-container {
    background: #0f1115 !important;
  }

  /* The "Ask Gemini" input bar -- recoloured and rounded a little more */
  .text-input-field, .text-input-field-main-area, .text-input-field_textarea-inner,
  .textarea-wrapper, rich-textarea, .ql-editor, .text-input-field_textarea {
    background: #12161f !important;
  }
  .text-input-field, .text-input-field-main-area { border-radius: 30px !important; }

  /* Strip marketing + account items (New chat is not in this list) */
  [data-test-id="mobile-open-about-gemini"],
  [data-test-id="mobile-open-gemini-app"],
  [data-test-id="mobile-open-subscriptions"],
  [data-test-id="mobile-open-for-business"],
  [data-test-id="mavatar-sign-in-button"],
  [data-test-id="mavatar-footer-settings-button"],
  sidenav-error-message {
    display: none !important;
  }

  /* Material tokens as a broad fallback for any remaining grey */
  :root, body {
    --mat-sys-surface: #0f1115;
    --mat-sys-surface-container: #161a22;
    --mat-sys-surface-container-low: #12161f;
    --mat-sys-surface-container-high: #1c212c;
    --mat-sys-surface-container-highest: #232a37;
    --mat-sys-surface-variant: #161a22;
    --mat-sys-outline: #262b36;
    --gem-sys-color--surface: #0f1115;
    --gem-sys-color--surface-container: #161a22;
  }
`;

let aiFrame = null;

// The marketing links exist twice: in the sidebar (hidden by id via the skin
// CSS) and in the desktop top nav, which has no stable id. Match those by exact
// text -- "New chat" is not in the list, so it is never touched.
const IKONAI_NAV_TEXT = ["about gemini", "get gemini app", "subscriptions", "for business", "sign in"];

// Light copy tweaks so the greeting reads as IkonAI. (The in-page "Gemini is AI"
// disclaimer is left in place, so what it runs on is still stated.)
const IKONAI_TEXT_REPLACE = [["Meet Gemini,", "Meet Ikon,"]];

// Sign-in nag popups to dismiss, matched on their text. Only overlay/dialog
// containers are checked, so the whole app is never hidden by accident.
const IKONAI_HIDE_POPUP = ["sign in to connect to google apps"];
const IKONAI_OVERLAY_SEL = ".cdk-overlay-pane, [role='dialog'], mat-dialog-container, mat-bottom-sheet-container";

function skinAiFrame() {
  try {
    const win = aiFrame.frame.contentWindow;
    const doc = aiFrame.frame.contentDocument;
    if (!doc) return;

    if (!doc.getElementById("ikonai-skin")) {
      const style = doc.createElement("style");
      style.id = "ikonai-skin";
      style.textContent = IKONAI_SKIN;
      doc.head.appendChild(style);
    }

    const rewriteTextNode = (node) => {
      let v = node.nodeValue;
      if (!v) return;
      for (const [from, to] of IKONAI_TEXT_REPLACE) {
        if (v.includes(from)) v = v.split(from).join(to);
      }
      if (v !== node.nodeValue) node.nodeValue = v;
    };
    const processTree = (root) => {
      if (root.nodeType === 3) return rewriteTextNode(root);
      if (root.nodeType !== 1) return;
      // Hide the marketing links in this subtree (New chat is never matched).
      const links = root.matches("a,button") ? [root] : [];
      links.push(...root.querySelectorAll("a,button"));
      for (const el of links) {
        if (IKONAI_NAV_TEXT.includes((el.textContent || "").trim().toLowerCase())) {
          el.style.setProperty("display", "none", "important");
        }
      }
      // Dismiss sign-in nag popups -- only overlay containers, short text, so a
      // real match can't take the whole page down with it.
      const overlays = root.matches(IKONAI_OVERLAY_SEL) ? [root] : [];
      overlays.push(...root.querySelectorAll(IKONAI_OVERLAY_SEL));
      for (const ov of overlays) {
        const t = (ov.textContent || "").toLowerCase();
        if (t.length < 600 && IKONAI_HIDE_POPUP.some((p) => t.includes(p))) {
          ov.style.setProperty("display", "none", "important");
        }
      }
      // Rewrite greeting text in this subtree only.
      const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) rewriteTextNode(n);
    };

    // One full pass now, then only newly-added nodes -- never the whole tree.
    processTree(doc.body || doc.documentElement);
    if (win.MutationObserver && !aiFrame._obs) {
      aiFrame._obs = new win.MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === "characterData") rewriteTextNode(m.target);
          for (const node of m.addedNodes) processTree(node);
        }
      });
      aiFrame._obs.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    }

    // Surface whatever IkonAI logs as an error into the pass-phrase panel, so a
    // failure with no address bar to reach settings from is still recoverable.
    if (!aiFrame._hooked) {
      aiFrame._hooked = true;
      win.addEventListener("error", (e) => logDiag("[IkonAI] " + (e.message || (e.error && e.error.message) || "error")));
      win.addEventListener("unhandledrejection", (e) =>
        logDiag("[IkonAI] rejection: " + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason))
      );
      const orig = win.console && win.console.error;
      if (orig) {
        win.console.error = function () {
          try {
            logDiag("[IkonAI] " + Array.from(arguments).map(String).join(" "));
          } catch {}
          return orig.apply(this, arguments);
        };
      }
    }
  } catch {
    // Cross-origin edge cases -- the surrounding IkonAI chrome still applies.
  }
}

// Build the Gemini frame once, in the background, so opening the AI tab is
// instant. Always Ultraviolet (its uploads work); independent of the browser
// view's engine.
function ensureAI() {
  if (aiFrame) return aiFrame;

  setAiStar(true);
  aiFrame = createUltravioletFrame();
  aiFrame.frame.id = "ai-frame";
  aiFrame.frame.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write; microphone");
  // Not display:none-hidden: the loading overlay sits on top instead, so the
  // frame always has real dimensions for Gemini to lay out against.
  aiFrame.frame.addEventListener("load", () => {
    const src = aiFrame.frame.src || "";
    if (src && !/about:blank$/.test(src)) {
      skinAiFrame();
      // Skin first, then fade the frame up over the loading panel, so the
      // recolour is in place before it becomes visible.
      requestAnimationFrame(() => {
        aiFrame.frame.classList.add("ready");
        aiLoading.hidden = true;
        setAiStar(false);
      });
    }
  });
  aiStage.appendChild(aiFrame.frame);

  (async () => {
    try {
      await ensureConnected();
      await ensureUltraviolet();
      aiFrame.go(IKONAI_URL);
    } catch (err) {
      aiLoading.querySelector("p").textContent = "IkonAI could not connect.";
      console.error(err);
    }
  })();

  return aiFrame;
}

// Restore the last logged error so the pass-phrase panel shows it after a
// reload -- IkonAI failures get logged here even though it has no address bar.
const savedDiag = localStorage.getItem(DIAG_KEY);
if (savedDiag) {
  lastErrorEl.textContent = savedDiag;
  diagnostics.hidden = false;
}

probeBackend();
renderBookmarks();
selectTab("home");
address.focus();

// Warm up IkonAI, but only once the page itself has finished loading and the
// browser is idle -- kicking it off during load makes the whole tab sit there
// spinning, which reads as the app being slow rather than quietly getting ready.
addEventListener("load", () => {
  const warm = () => {
    ensureConnected().catch(() => {});
  };
  if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 1500);
});
