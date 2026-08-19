"use strict";

// GitHub Pages project sites live at https://<user>.github.io/<repo>/, so
// nothing can be hardcoded to "/". Every path below is built from BASE, which
// is the directory this page is served from.
const BASE = new URL(".", location.href).pathname;

// Default wisp backend, so people you share this with don't have to configure
// anything. Quick tunnels rotate their hostname on every cloudflared restart --
// when that happens, update this line and push.
const DEFAULT_WISP = "wss://florence-market-freedom-forbes.trycloudflare.com/wisp/";

// SHA-256 of the settings password. Hashed rather than stored literally so the
// password itself isn't sitting in a public repo. NOTE: this is a client-side
// check on a static page -- it stops accidental edits, it is not security.
const PW_HASH = "7baa68f2418ba82d2545a780c00d7a8778249bbcdaf7369114534874ea6d3bd6";

const WISP_KEY = "scramjet.wispUrl";

const form = document.getElementById("form");
const address = document.getElementById("address");
const wispInput = document.getElementById("wisp");
const pwInput = document.getElementById("pw");
const status = document.getElementById("status");
const saveBtn = document.getElementById("save");
const resetBtn = document.getElementById("reset");

function getWispUrl() {
  return localStorage.getItem(WISP_KEY) || DEFAULT_WISP;
}

function setStatus(msg, kind = "") {
  status.textContent = msg;
  status.className = kind;
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

wispInput.value = getWispUrl();

saveBtn.addEventListener("click", async () => {
  if ((await sha256hex(pwInput.value)) !== PW_HASH) {
    setStatus("Wrong password.", "err");
    pwInput.value = "";
    return;
  }

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
  pwInput.value = "";
  setStatus("Saved: " + url, "ok");
});

resetBtn.addEventListener("click", async () => {
  if ((await sha256hex(pwInput.value)) !== PW_HASH) {
    setStatus("Wrong password.", "err");
    pwInput.value = "";
    return;
  }
  localStorage.removeItem(WISP_KEY);
  wispInput.value = DEFAULT_WISP;
  pwInput.value = "";
  setStatus("Reset to the default backend.", "ok");
});

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
  // Must sit inside the service worker's scope (BASE) or the worker will
  // never see the proxied requests.
  prefix: BASE + "scramjet/",
  files: {
    wasm: BASE + "scram/scramjet.wasm.wasm",
    all: BASE + "scram/scramjet.all.js",
    sync: BASE + "scram/scramjet.sync.js",
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

const connection = new BareMux.BareMuxConnection(BASE + "baremux/worker.js");

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
  return "https://www.google.com/search?q=" + encodeURIComponent(v);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = toUrl(address.value);
  if (!url) return;

  try {
    setStatus("Registering service worker...");
    await registerSW();

    const wispUrl = getWispUrl();
    setStatus("Connecting to backend...");
    await connection.setTransport(BASE + "libcurl/index.mjs", [{ websocket: wispUrl }]);

    setStatus("Loading " + url);
    const existing = document.getElementById("frame");
    if (existing) existing.remove();

    const frame = scramjet.createFrame();
    frame.frame.id = "frame";
    document.body.appendChild(frame.frame);
    frame.go(url);
    setStatus("");
  } catch (err) {
    setStatus("Failed: " + err.message, "err");
    console.error(err);
  }
});
