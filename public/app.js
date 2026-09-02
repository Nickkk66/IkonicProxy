"use strict";

// GitHub Pages project sites live at https://<user>.github.io/<repo>/, so
// nothing can be hardcoded to "/". Every path below is built from BASE, which
// is the directory this page is served from.
const BASE = new URL(".", location.href).pathname;

// Default wisp backend, so people you share this with don't have to configure
// anything. Quick tunnels rotate their hostname on every cloudflared restart --
// `npm run setup` can rewrite this line for you.
const DEFAULT_WISP = "wss://think-achievement-brochure-readings.trycloudflare.com/wisp/";

// Shared secret for the wisp socket, carried as the last path segment:
// /wisp/<token>/. The backend refuses the upgrade without it, which is what
// stops the tunnel address from being an open relay through the home PC.
//
// It is not in this file, and it is not in any file the browser is given. The
// page asks the backend for it, and the backend hands it over only in return
// for the access code -- so a link on its own is worth nothing, and the code
// is what gets passed around. Once unlocked the token is kept in this
// browser; it is dropped again the moment the backend stops accepting it,
// which is what a changed secret or a changed code looks like from here.
const TOKEN_KEY = "ikonic.token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function forgetToken() {
  localStorage.removeItem(TOKEN_KEY);
}

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
  // Unless this page came from GitHub Pages, whatever served it is the backend
  // itself -- the local server, or any tunnel pointing at it (Cloudflare,
  // ngrok, Tailscale Funnel, dev tunnels...). Frontend and wisp are then one
  // origin, and no hardcoded address is involved. Only Pages serves the files
  // without also running the backend, so only Pages needs DEFAULT_WISP.
  if (!/.github.io$/i.test(host)) {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + wispPath();
  }
  // DEFAULT_WISP is stored without the secret: this is a committed file, and
  // the secret only ever arrives in exchange for the access code.
  return withToken(DEFAULT_WISP);
}

/** The backend's socket path, with the shared secret once it is known. */
function wispPath() {
  const token = getToken();
  return token ? `/wisp/${token}/` : "/wisp/";
}

/** Swaps a bare .../wisp/ tail for the token-carrying one. */
function withToken(url) {
  return getToken() ? url.replace(/\/wisp\/?$/, wispPath()) : url;
}

/**
 * Where the backend answers HTTP -- the unlock endpoint lives there. Same
 * origin as this page unless the page came from GitHub Pages, in which case it
 * is whatever the wisp address points at, with the scheme swapped back.
 */
function backendHttp() {
  try {
    const u = new URL(getWispUrl());
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch {
    return location.origin;
  }
}

// --- the access code ----------------------------------------------------

const gate = document.getElementById("gate");
const codeInput = document.getElementById("code");
const codeBtn = document.getElementById("enter");
const gateMsg = document.getElementById("gatemsg");

let unlockWaiters = null;

/**
 * Resolves once a token is in hand: immediately if this browser already has
 * one, otherwise after the code has been entered and accepted. Everything
 * that opens a page waits on this, so the gate is not something a visitor can
 * click past -- there is simply nothing to connect to without it.
 */
function ensureUnlocked() {
  if (getToken()) return Promise.resolve();
  if (unlockWaiters) return unlockWaiters.promise;

  let resolve;
  const promise = new Promise((r) => (resolve = r));
  unlockWaiters = { promise, resolve };
  gate.hidden = false;
  codeInput.focus();
  return promise;
}

async function submitCode() {
  const code = codeInput.value.trim();
  if (!code) return;
  codeBtn.disabled = true;
  gateMsg.textContent = "Checking…";
  gateMsg.className = "hint";
  try {
    const res = await fetch(backendHttp() + "/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) {
      gateMsg.textContent = body.error || "That code was not accepted.";
      gateMsg.className = "hint err";
      codeInput.select();
      return;
    }
    localStorage.setItem(TOKEN_KEY, body.token);
    codeInput.value = "";
    gateMsg.textContent = "";
    gate.hidden = true;
    // The socket address changed shape (it now carries the token), so
    // anything dialled without it has to be dialled again.
    forgetTransports();
    if (unlockWaiters) {
      unlockWaiters.resolve();
      unlockWaiters = null;
    }
    probeBackend();
  } catch (err) {
    gateMsg.textContent = "Could not reach the backend.";
    gateMsg.className = "hint err";
    reportFailure(err);
  } finally {
    codeBtn.disabled = false;
  }
}

codeBtn.addEventListener("click", submitCode);
codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitCode();
});

/**
 * The backend said no to the token this browser has. That is what a rotated
 * secret looks like from here: forget it, and ask for the code again the next
 * time a page is opened.
 */
function tokenRejected() {
  if (!getToken()) return;
  forgetToken();
  forgetTransports();
  exitBrowser();
  setStatus("The access code has changed. Enter the new one to carry on.", "err");
  ensureUnlocked();
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
 * The engine preference: "auto" (Smart, the default), or a forced
 * "scramjet2" / "scramjet" / "uv". All three rewriters live in the one service
 * worker, so the choice only decides which kind of frame a page opens in.
 */
const ENGINES = ["scramjet2", "scramjet", "uv"];

function getEnginePref() {
  const v = localStorage.getItem(ENGINE_KEY);
  return ENGINES.includes(v) ? v : "auto";
}

/** Which engine a given URL should actually open in. */
function resolveEngine(url) {
  const pref = getEnginePref();
  if (pref !== "auto") return pref;
  // Smart: Ultraviolet for the chat sites (uploads), Scramjet 2 for the rest.
  // Version 1 stays a manual choice rather than a fallback: it is the engine
  // that crashes the tab on a YouTube watch page, so nothing is routed onto
  // it without being asked for.
  return isAiSite(url) ? "uv" : "scramjet2";
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

  // wisp is served at /wisp/<token>/ -- add it if only the origin was pasted.
  if (u.pathname === "" || u.pathname === "/") u.pathname = wispPath();
  if (!u.pathname.endsWith("/")) u.pathname += "/";

  // cloudflared prints a bare origin and the README says ".../wisp/", so a
  // pasted address usually arrives without the secret. Fill it in; anything
  // that already carries a token is left alone.
  return withToken(u.toString());
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
  // A refused upgrade closes without ever opening. With a token in hand that
  // is the backend saying the token is no longer the right one -- only said
  // when there was one to refuse, so an outage is not mistaken for a rotation.
  socket.addEventListener("close", () => finish("down", getToken() ? "backend refused the token" : "backend unreachable"));
}

// --- settings --------------------------------------------------------------

function revealSettings() {
  settingsEl.hidden = false;
  probeBackend();
  settingsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  (lockedEl.hidden ? wispInput : pwInput).focus();
}

const ENGINE_NAMES = { auto: "Smart", scramjet2: "Scramjet 2", scramjet: "Scramjet 1", uv: "Ultraviolet" };

for (const input of engineInputs) {
  input.checked = input.value === getEnginePref();
  input.addEventListener("change", () => {
    if (!input.checked) return;
    localStorage.setItem(ENGINE_KEY, input.value);
    // Any live frame belongs to the old choice, so it goes; the next page
    // opens under the new one.
    exitBrowser();
    const how = input.value === "auto" ? "Smart: Ultraviolet on chat sites, Scramjet 2 elsewhere." : `Using ${ENGINE_NAMES[input.value]}.`;
    setStatus(how, "ok");
  });
}

for (const input of transportInputs) {
  input.checked = input.value === getTransport();
  input.addEventListener("change", () => {
    if (!input.checked) return;
    localStorage.setItem(TRANSPORT_KEY, input.value);
    // Force the next navigation to dial again through the new transport.
    forgetTransports();
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
  // Drop the cached transports so the next navigation dials the new address.
  forgetTransports();
  setStatus("Saved: " + url, "ok");
  probeBackend();
});

resetBtn.addEventListener("click", () => {
  localStorage.removeItem(WISP_KEY);
  wispInput.value = defaultWisp();
  forgetTransports();
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

// --- Scramjet 2 ------------------------------------------------------------
//
// Version 2 is a different shape from version 1 and from Ultraviolet, so it
// gets its own setup rather than joining theirs. Two differences matter here:
// its controller is a separate script that has to be handed the live service
// worker, and it does not go through bare-mux -- it takes a transport object
// directly, which is why the wisp address is dialled again below rather than
// reusing the one the other two share.
const SCRAMJET2_PREFIX = BASE + "m/p3/";

/**
 * Resolves once this page is under the service worker. Gives up after a while
 * rather than hanging: a page that is never claimed is broken either way, and
 * failing loudly beats spinning forever.
 */
function waitForController(timeout = 10000) {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      navigator.serviceWorker.removeEventListener("controllerchange", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeout);
    navigator.serviceWorker.addEventListener("controllerchange", done);
  });
}

/**
 * The real address out of a version 2 proxied URL.
 *
 * Version 1 and Ultraviolet both put a single encoded blob after their prefix.
 * Version 2 puts the controller's id, then the frame's id, then the address --
 * and it writes that address two different ways. Sometimes it is encoded whole,
 * query string and all, into one path segment; sometimes it is written out
 * plainly, in which case its query ends up in the outer URL's query, mixed in
 * with the parameters the engine adds for its own use. Those all begin with a
 * "$" and are not part of the address.
 */
function unprefixScramjet2(href) {
  let outer;
  try {
    outer = new URL(href);
  } catch {
    return "";
  }

  const at = outer.pathname.indexOf(SCRAMJET2_PREFIX);
  if (at === -1) return "";
  const rest = outer.pathname.slice(at + SCRAMJET2_PREFIX.length).split("/").slice(2).join("/");
  if (!rest) return "";

  // Decoding tells the two shapes apart: if what comes back is an absolute
  // URL then that segment held the whole address and there is nothing to add.
  try {
    const decoded = decodeURIComponent(rest);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) return decoded;
  } catch {}

  const params = new URLSearchParams(outer.search);
  for (const key of [...params.keys()]) {
    if (key.startsWith("$")) params.delete(key);
  }
  const query = params.toString();
  return rest + (query ? "?" + query : "") + outer.hash;
}

let scramjet2Controller = null;
let scramjet2Ready = null;
// Guards the rebuild below against looping when the worker is broken for
// some reason rebuilding cannot fix. Reset by the first page that loads.
let scramjet2Rebuilds = 0;

// A worker that has been replaced knows nothing the old one was told, and the
// controller is bound to the old one, so it has to be built again.
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    scramjet2Ready = null;
    scramjet2Controller = null;
  });
}

/**
 * The advert blocklist, wrapped around a transport.
 *
 * The service worker already refuses these hosts, and for version 1 and
 * Ultraviolet that is the whole story, because every request a proxied page
 * makes goes through it. Version 2 fetches a page's subresources itself, so
 * the worker never sees most of them -- which is how an advert host that is
 * blocked everywhere else still cost five seconds and still hung the page.
 * Refusing them here catches both paths, since everything version 2 sends
 * leaves through this object.
 */
function blocking(Transport) {
  return class BlockingTransport extends Transport {
    request(remote, method, body, headers, signal) {
      if (isBlockedHost(remote && remote.hostname)) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return super.request(remote, method, body, headers, signal);
    }

    connect(url, ...rest) {
      if (isBlockedHost(url && url.hostname)) throw new TypeError("Failed to fetch");
      return super.connect(url, ...rest);
    }
  };
}

function ensureScramjet2() {
  if (!scramjet2Ready) {
    scramjet2Ready = (async () => {
      // Order matters: the controller's script expects the engine's globals to
      // already be there when it runs.
      await loadScript(BASE + "m/e3/e3.js");
      await loadScript(BASE + "m/c3/c3a.js");

      const registration = await registerSW();
      // Wait to actually be claimed. On the very first load the worker is
      // active but not yet controlling this page, and a frame opened in that
      // window has its requests go straight past the worker to the static host,
      // which answers a bare 404 -- so the page must be controlled before any
      // frame is built, not merely registered.
      await waitForController();
      const worker = navigator.serviceWorker.controller || registration.active;
      if (!worker) throw new Error("no active service worker for Scramjet 2");

      const wisp = getWispUrl();
      // Version 2 wants libcurl 2, which is a different package from the one
      // bare-mux is given; epoxy is the same build for both.
      const path = getTransport() === "epoxy" ? "m/t2/index.mjs" : "m/t3/index.mjs";
      const { default: Transport } = await import(BASE + path);

      scramjet2Controller = new $scramjetController.Controller({
        serviceworker: worker,
        transport: new (blocking(Transport))({ wisp }),
        config: {
          prefix: SCRAMJET2_PREFIX,
          scramjetPath: BASE + "m/e3/e3.js",
          injectPath: BASE + "m/c3/c3i.js",
          wasmPath: BASE + "m/e3/e3.wasm",
          // Not a file on disk -- it is the name a proxied page fetches the
          // engine's wasm under, so it is renamed for the same reason the real
          // files are.
          virtualWasmPath: "e3.wasm.js",
        },
        scramjetConfig: {
          ...$scramjet.defaultConfig,
          flags: {
            ...$scramjet.defaultConfig.flags,
            // Off. Source maps are a debugging aid, and paying for them means
            // building one for every script the engine rewrites -- on a site
            // that ships a multi-megabyte bundle that is a large amount of
            // memory and work spent on something nobody here will ever read.
            sourcemaps: false,
          },
        },
      });
      await scramjet2Controller.wait();
      return scramjet2Controller;
    })();
    scramjet2Ready.catch((err) => {
      scramjet2Ready = null;
      scramjet2Controller = null;
      if (/401|unauthori[sz]ed/i.test(String(err && (err.message || err)))) tokenRejected();
    });
  }
  return scramjet2Ready;
}

/**
 * Scramjet 2's frame in the shape the rest of this file expects: the same
 * go/back/forward/reload as the other two, plus a `url` read back out of the
 * proxied document's own location. Unlike version 1 it binds to an iframe that
 * is already on the page, so the element arrives already mounted.
 */
function createScramjet2Frame(el) {
  const frame = scramjet2Controller.createFrame(el);

  return {
    frame: el,
    go(url) {
      frame.go(url);
    },
    back() {
      frame.back();
    },
    forward() {
      frame.forward();
    },
    reload() {
      frame.reload();
    },
    get url() {
      return unprefixScramjet2(el.contentWindow?.location?.href || "");
    },
    // Version 1 fires urlchange; version 2 does not without a plugin, and the
    // frame's own load event covers it the same way it does for Ultraviolet.
    addEventListener() {},
  };
}

async function registerSW() {
  if (!navigator.serviceWorker) {
    throw new Error(
      location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)
        ? "Service workers need HTTPS (or localhost)."
        : "This browser does not support service workers."
    );
  }
  const registration = await navigator.serviceWorker.register(BASE + "sw.js", { scope: BASE });
  await navigator.serviceWorker.ready;
  return registration;
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

/**
 * Build Scramjet 2 again and reopen the page.
 *
 * The browser evicts an idle service worker whenever it likes, and the copy
 * that comes back has none of the routing the controller gave the last one.
 * A proxied request then falls straight through the worker to the static host,
 * which answers a bare 404 -- so a page that worked a minute ago is suddenly
 * three characters of plain text. Nothing can repair that from inside the
 * frame: the controller is bound to a worker that is gone, so both it and the
 * frame have to be made again.
 */
function rebuildScramjet2() {
  if (scramjet2Rebuilds >= 3) return false;
  scramjet2Rebuilds++;

  const url = lastRequestedUrl;
  forgetTransports();
  if (activeFrame) {
    activeFrame.frame.remove();
    activeFrame = null;
    activeEngine = null;
  }
  openUrl(url);
  return true;
}

/**
 * Switch off view transitions inside a proxied page.
 *
 * This is what stops the tab dying on YouTube. Every one of the crash dumps
 * ends the same way: the Compositor thread aborts inside Edge's own
 * CalculateDrawProperties -- the pass that checks the layer and property trees
 * blink hands it -- and the checks that page content can reach there are
 * the view-transition ones: duplicate transition element ids across effect
 * nodes, transition targets with no surface to land on. YouTube runs a view
 * transition when it moves from the feed to a video. On the real site its
 * embedded frames are cross-origin and each get a compositor of their own;
 * through here every frame is this one origin, so all of them share one
 * compositor, and that is exactly where those checks trip. It is an
 * official-build CHECK, so there is no exception to catch and nothing to
 * retry -- the renderer is simply gone.
 *
 * Taking the name off every element (and the root, which otherwise carries
 * one implicitly) leaves the transition nothing to capture, so
 * startViewTransition() runs to completion with no snapshot layers and the
 * compositor never sees the situation it cannot handle. The cost is the
 * morph animation between pages, which nobody misses next to a dead tab.
 * Applied to every proxied page rather than only YouTube: the trigger is the
 * shared origin, which every site here has.
 *
 * The <style> lives in the proxied document, so it survives the site's own
 * in-page navigations; a full load fires this again from the load hook.
 */
function guardCompositor(frame) {
  let doc;
  try {
    doc = frame.frame.contentDocument;
  } catch {
    return;
  }
  if (!doc || doc.getElementById("ikonic-guard")) return;
  const style = doc.createElement("style");
  style.id = "ikonic-guard";
  style.textContent = "*, html, :root { view-transition-name: none !important; }";
  (doc.head || doc.documentElement).appendChild(style);
}
/** The attributes every proxied frame carries, whichever engine built it. */
function dressFrame(el) {
  el.id = "frame";
  el.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
}

function ensureFrame(engine) {
  if (activeFrame) return activeFrame;

  let frame;
  if (engine === "scramjet2") {
    // Scramjet 2 binds to an iframe that is already in the document, so this
    // one is built, dressed and mounted before the frame is made from it.
    const el = document.createElement("iframe");
    dressFrame(el);
    viewport.appendChild(el);
    frame = createScramjet2Frame(el);
  } else {
    frame = engine === "uv" ? createUltravioletFrame() : scramjet.createFrame();
    dressFrame(frame.frame);
  }
  // Scramjet reports the real (unproxied) location as the page navigates.
  frame.addEventListener("urlchange", (event) => {
    if (event.url) showAddress(event.url);
  });
  frame.frame.addEventListener("load", () => {
    // The initial about:blank load is not a real navigation; ignore it so the
    // deferred flip waits for the actual page.
    const src = frame.frame.src || "";
    if (src && !/about:blank$/.test(src)) commitFirstOpen();

    // The first requests often land before the wisp transport has connected, so
    // the proxy hands back the error page. Retry a few times behind the spinner
    // (which covers the error page) so it works without the user doing anything.
    let isErrorPage = false;
    // The static host's own 404 -- three characters and no title -- means the
    // worker never routed this at all. Only Scramjet 2 can land here, and only
    // by losing its worker, so that is what gets rebuilt.
    let isUnrouted = false;
    try {
      const doc = frame.frame.contentDocument;
      const b = doc && doc.body;
      isErrorPage = !!(b && b.hasAttribute("data-ikonic-error"));
      isUnrouted = !!(doc && !doc.title && b && b.textContent.trim() === "404");
    } catch {}

    if (isUnrouted && activeEngine === "scramjet2" && lastRequestedUrl) {
      setLoading(true);
      if (rebuildScramjet2()) return;
    }
    // Whatever this page is, it is not the static 404, so the engine is
    // talking to its worker again and the next failure deserves its own budget.
    scramjet2Rebuilds = 0;
    if (isErrorPage && lastRequestedUrl) {
      frame._retries = frame._retries || 0;
      if (frame._retries < 5) {
        frame._retries++;
        setLoading(true); // spinner sits over the error page during the retry
        setTimeout(() => frame.go(lastRequestedUrl), 600);
        return;
      }
      // Retries exhausted -- let the error page show.
    }

    setLoading(false);
    try {
      showAddress(frame.url);
    } catch {}
    guardCompositor(frame);
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

/**
 * Throw away every dialled transport so the next navigation reconnects. Both
 * stacks have to go: changing the backend address or the transport invalidates
 * bare-mux and Scramjet 2's own connection alike.
 */
function forgetTransports() {
  connecting = null;
  scramjet2Ready = null;
  scramjet2Controller = null;
}

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

// A tiny request through the transport to force the wisp WebSocket open ahead
// of the first real navigation. Fire-and-forget; failure is harmless.
function warmConnection() {
  try {
    connection.fetch("https://www.google.com/generate_204", { method: "GET" }).catch(() => {});
  } catch {}
}

function ensureConnected() {
  if (!connecting) {
    connecting = (async () => {
      await registerSW();
      const wisp = getWispUrl();
      await (getTransport() === "epoxy"
        ? connection.setTransport(BASE + "m/t2/index.mjs", [{ wisp }])
        : connection.setTransport(BASE + "m/t1/index.mjs", [{ websocket: wisp }]));
      warmConnection();
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
    // Nothing connects without the token, and the token comes from the code.
    await ensureUnlocked();
    // Each engine brings up its own plumbing: Scramjet 2 has a transport of
    // its own, so bare-mux is only dialled for the two that share it.
    if (want === "scramjet2") {
      await ensureScramjet2();
    } else {
      await ensureConnected();
      if (want === "uv") await ensureUltraviolet();
    }
    lastRequestedUrl = url;
    const frame = ensureFrame(want);
    frame._retries = 0; // a fresh navigation gets its own retry budget
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

// The error page's "Try again" posts here so the retry runs through the browser
// view -- spinner up, no blank screen.
addEventListener("message", (event) => {
  if (event.data && event.data.ikonic === "retry" && activeFrame && lastRequestedUrl) {
    setLoading(true);
    activeFrame._retries = 0;
    activeFrame.go(lastRequestedUrl);
  }
});

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
      await ensureUnlocked();
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

// Keep the service worker alive while a page is open.
//
// The browser evicts an idle worker after roughly half a minute, and the copy
// that comes back has none of the routing Scramjet 2's controller gave the
// last one; its attempt to re-pair fails ("All clients returned an invalid
// MessagePort"), and from then on every request the page makes falls through
// the worker to the static host and comes back as a bare 404. That is how a
// YouTube page can load its document and then never load anything else.
// A worker that handles a request every twenty seconds is never idle, so it
// is never evicted, so none of that happens. The rebuild in ensureFrame is
// still there for the cases this cannot cover, such as a worker update.
setInterval(() => {
  if (!activeFrame || !document.body.classList.contains("browsing")) return;
  fetch(BASE + "keepalive", { cache: "no-store" }).catch(() => {});
}, 20000);

// Version 1 announces every navigation; version 2 and Ultraviolet do not, and
// a move made inside the page fires no load event either -- so the address is
// polled instead of waited for. It costs one property read, and only while a
// page is actually up.
setInterval(() => {
  if (!activeFrame || !document.body.classList.contains("browsing")) return;
  let url = "";
  try {
    url = activeFrame.url;
  } catch {}
  if (url && url !== currentUrl) showAddress(url);
}, 700);

// Restore the last logged error so the pass-phrase panel shows it after a
// reload -- IkonAI failures get logged here even though it has no address bar.
const savedDiag = localStorage.getItem(DIAG_KEY);
if (savedDiag) {
  lastErrorEl.textContent = savedDiag;
  diagnostics.hidden = false;
}

renderBookmarks();
selectTab("home");
if (getToken()) {
  probeBackend();
  address.focus();
} else {
  setBeacon("down", "needs the access code");
  ensureUnlocked();
}

// Warm up IkonAI, but only once the page itself has finished loading and the
// browser is idle -- kicking it off during load makes the whole tab sit there
// spinning, which reads as the app being slow rather than quietly getting ready.
addEventListener("load", () => {
  const warm = () => {
    // Nothing to warm without the token; the first page will ask for the code.
    if (!getToken()) return;
    // Warm whichever stack the next page will actually use, so the waiting is
    // done before there is anything to wait for rather than during it.
    const pref = getEnginePref();
    if (pref === "auto" || pref === "scramjet2") {
      ensureScramjet2().catch(() => {});
      return;
    }
    ensureConnected()
      .then(() => warmConnection())
      .catch(() => {});
  };
  if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 1500);
});
