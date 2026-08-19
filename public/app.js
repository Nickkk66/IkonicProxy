"use strict";

// GitHub Pages project sites live at https://<user>.github.io/<repo>/, so
// nothing can be hardcoded to "/". Every path below is built from BASE, which
// is the directory this page is served from.
const BASE = new URL(".", location.href).pathname;

const WISP_KEY = "scramjet.wispUrl";

const form = document.getElementById("form");
const address = document.getElementById("address");
const wispInput = document.getElementById("wisp");
const status = document.getElementById("status");
const saveBtn = document.getElementById("save");

/** Same-origin wisp; correct for local testing, wrong once on Pages. */
function sameOriginWisp() {
  return (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
}

function getWispUrl() {
  return localStorage.getItem(WISP_KEY) || sameOriginWisp();
}

function setStatus(msg, kind = "") {
  status.textContent = msg;
  status.className = kind;
}

wispInput.value = getWispUrl();

saveBtn.addEventListener("click", () => {
  const val = wispInput.value.trim();
  if (!/^wss?:\/\//.test(val)) {
    setStatus("Wisp URL must start with ws:// or wss://", "err");
    return;
  }
  // A page served over HTTPS cannot open an insecure ws:// socket; the browser
  // blocks it as mixed content. Catch it here rather than as a console error.
  if (location.protocol === "https:" && val.startsWith("ws://")) {
    setStatus("This page is HTTPS, so the wisp URL must be wss:// (not ws://).", "err");
    return;
  }
  localStorage.setItem(WISP_KEY, val);
  setStatus("Saved. " + val, "ok");
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
    // syncxhr is the one feature that needs SharedArrayBuffer, which needs
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
    // Already a full URL
    return new URL(v).toString();
  } catch {}
  // Looks like a bare domain -> assume https
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
    setStatus("Connecting to wisp at " + wispUrl + " ...");
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

// Warn early if the page is on Pages but still pointed at itself for wisp.
if (location.hostname.endsWith("github.io") && !localStorage.getItem(WISP_KEY)) {
  setStatus(
    "Set your wisp backend URL below (your Cloudflare Tunnel wss:// address) before browsing.",
    "err"
  );
}
