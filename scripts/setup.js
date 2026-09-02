// Setup / control panel. Run via: npm run setup  (or double-click setup.cmd)
//
// First run walks through everything that has to be true before the proxy is
// worth starting: Node, dependencies, the browser assets, the two secrets, and
// how people are going to reach it -- just this PC, or through a tunnel from
// Cloudflare, Tailscale or Microsoft. After that it is a menu: start things,
// stop them, show the link and the access code, change either secret.
//
// The proxy and any tunnel are started detached with their output going to a
// log, so closing this menu -- or the window it opened in -- does not kill
// anything.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ensureToken,
  TOKEN_FILE,
  ensureAccessCode,
  readAccessCode,
  setAccessCode,
  generateAccessCode,
} from "../src/token.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const PID_FILE = root + ".proxy.pid";
const LOG_FILE = root + "proxy.log";
const TUNNEL_PID_FILE = root + ".tunnel.pid";
const TUNNEL_URL_FILE = root + ".tunnel.url";
const TUNNEL_LOG = root + "tunnel.log";
const CONFIG_FILE = root + ".ikonic.json";
const APP_JS = root + "public/app.js";
const PORT = parseInt(process.env.PORT || "8080", 10);
const WIN = process.platform === "win32";

// --- looks -----------------------------------------------------------------
//
// Colour when there is a terminal to show it in, plain text otherwise (a pipe,
// a log, NO_COLOR set). The box characters only go out when the terminal is
// known to draw them: Windows Terminal and anything not Windows. The old cmd
// console with a legacy code page turns them into mush, so it gets ASCII.
const COLOR = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (code) => (text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const blue = paint("34");
const magenta = paint("35");
const cyan = paint("36");

const FANCY = !WIN || Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === "vscode";
const BOX = FANCY
  ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
  : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
const WIDTH = 78;

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

/** A titled box around a list of lines. Lines longer than the box are kept. */
function box(title, lines, tint = cyan) {
  const inner = WIDTH - 2;
  const head = title ? ` ${title} ` : "";
  const top = BOX.tl + BOX.h + head + BOX.h.repeat(Math.max(0, inner - head.length - 1)) + BOX.tr;
  console.log(tint(top));
  for (const text of lines) {
    const pad = Math.max(0, inner - 1 - stripAnsi(text).length);
    console.log(tint(BOX.v) + " " + text + " ".repeat(pad) + tint(BOX.v));
  }
  console.log(tint(BOX.bl + BOX.h.repeat(inner) + BOX.br));
}

function banner() {
  const art = [
    "  ___ _  __ ___  _  _ ___ ___ ",
    " |_ _| |/ // _ \\| \\| |_ _/ __|",
    "  | || ' <| (_) | .` || | (__ ",
    " |___|_|\\_\\\\___/|_|\\_|___\\___|",
  ];
  console.log("");
  for (const row of art) console.log(magenta(bold(row)));
  console.log(dim("  your own proxy, on your own PC") + "\n");
}

const OK = green("  ok  ");
const BAD = red(" miss ");
const WARN = yellow(" warn ");

// --- config ----------------------------------------------------------------

const PROVIDERS = {
  local: { name: "Just this PC (no tunnel)" },
  cloudflare: { name: "Cloudflare quick tunnel", tool: "cloudflared" },
  tailscale: { name: "Tailscale Funnel", tool: "tailscale" },
  devtunnel: { name: "Microsoft Dev Tunnels", tool: "devtunnel" },
};

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeConfig(patch) {
  const next = { ...(readConfig() || {}), ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function provider() {
  const cfg = readConfig();
  return cfg && PROVIDERS[cfg.provider] ? cfg.provider : "cloudflare";
}

// --- checks ----------------------------------------------------------------

// Every dependency that has to be unpacked in node_modules before anything
// else works. Checked by directory rather than require.resolve() because these
// packages do not all export their own package.json.
const DEPS = [
  "@mercuryworkshop/scramjet",
  "scramjet2",
  "@mercuryworkshop/scramjet-controller",
  "@mercuryworkshop/libcurl-transport",
  "libcurl2",
  "@mercuryworkshop/epoxy-transport",
  "@mercuryworkshop/bare-mux",
  "@mercuryworkshop/wisp-js",
  "@titaniumnetwork-dev/ultraviolet",
  "ws",
];

// Browser-side files copied out of node_modules by scripts/copy-assets.js.
// Missing any of these means the frontend loads but cannot proxy anything.
const ASSETS = [
  "public/m/e1/e1.js",
  "public/m/e1/e1s.js",
  "public/m/e1/e1.wasm",
  "public/m/e3/e3.js",
  "public/m/e3/e3.wasm",
  "public/m/c3/c3a.js",
  "public/m/c3/c3w.js",
  "public/m/c3/c3i.js",
  "public/m/mx/index.js",
  "public/m/mx/worker.js",
  "public/m/t1/index.mjs",
  "public/m/t2/index.mjs",
  "public/m/t3/index.mjs",
  "public/m/e2/e2.js",
  "public/m/e2/e2w.js",
  "public/m/e2/e2h.js",
  "public/m/e2/e2c.js",
];

// Hand-written frontend. If one of these is gone the repo is damaged and no
// automatic fix applies.
const FRONTEND = ["public/index.html", "public/app.js", "public/style.css", "public/sw.js", "public/cfg.js", "public/blocked.js"];

const missing = (paths) => paths.filter((p) => !existsSync(root + p));

function checkNode() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return {
    label: `Node.js ${process.versions.node}`,
    state: major >= 18 ? "ok" : "bad",
    detail: major >= 18 ? "" : "Node 18 or newer is required.",
  };
}

function checkDeps() {
  const gone = DEPS.filter((name) => !existsSync(root + "node_modules/" + name));
  return {
    label: "Dependencies (node_modules)",
    state: gone.length ? "bad" : "ok",
    detail: gone.length ? `missing: ${gone.join(", ")}` : "",
    fix: { label: "npm install", run: () => runNpm(["install"]) },
  };
}

function checkAssets() {
  const gone = missing(ASSETS);
  return {
    label: "Browser assets (public/m/)",
    state: gone.length ? "bad" : "ok",
    detail: gone.length ? `missing: ${gone.join(", ")}` : "",
    // Run the script directly rather than through npm: one less process, and
    // it works even if npm is not on PATH.
    fix: { label: "npm run assets", run: () => run(process.execPath, ["scripts/copy-assets.js"]) },
  };
}

function checkFrontend() {
  const gone = missing(FRONTEND);
  return {
    label: "Frontend files (public/)",
    state: gone.length ? "bad" : "ok",
    detail: gone.length ? `missing: ${gone.join(", ")} -- restore them from git` : "",
  };
}

// The backend refuses any socket that does not carry the token. It used to be
// written into app.js on the way out; now the page earns it with the access
// code, so a token in app.js is only ever a leftover from an old checkout.
function checkToken() {
  const { created } = ensureToken();
  let committed = false;
  try {
    committed = /const WISP_TOKEN = "\S+";/.test(readFileSync(APP_JS, "utf8"));
  } catch {}
  if (committed) {
    return {
      label: "Backend secret (.wisp-token)",
      state: "warn",
      detail: "public/app.js has a token written into it -- clear it, the repo is public",
    };
  }
  return { label: "Backend secret (.wisp-token)", state: "ok", detail: created ? "generated just now" : "present" };
}

function checkAccessCode() {
  const { created } = ensureAccessCode();
  return { label: "Access code (.access-code)", state: "ok", detail: created ? "generated just now" : "present" };
}

function onPath(tool) {
  const probe = spawnSync(WIN ? "where" : "which", [tool], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0].trim() : null;
}

function checkTunnelTool() {
  const which = provider();
  const p = PROVIDERS[which];
  if (!p.tool) return { label: "Tunnel: none chosen (just this PC)", state: "ok", detail: "" };
  const found = onPath(p.tool);
  return {
    label: `${p.name} (${p.tool})`,
    state: found ? "ok" : "warn",
    detail: found ? "installed" : "not on PATH -- the proxy still runs locally, nobody else can reach it",
  };
}

const allChecks = () => [checkNode(), checkDeps(), checkAssets(), checkFrontend(), checkToken(), checkAccessCode(), checkTunnelTool()];

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  return res.status === 0;
}

// npm is a .cmd shim on Windows, and spawn refuses to launch those directly.
// Handing cmd.exe the whole line as one argument avoids shell: true, which
// would also mangle paths containing spaces (C:\Program Files\nodejs\node.exe).
function runNpm(args) {
  return WIN ? run("cmd", ["/c", ["npm", ...args].join(" ")]) : run("npm", args);
}

/** winget on Windows; elsewhere the person is told where to get it. */
function installTool(id, fallback) {
  if (WIN && onPath("winget")) {
    console.log(dim(`\n  winget install --id ${id}\n`));
    return run("winget", ["install", "--id", id, "--accept-package-agreements", "--accept-source-agreements"]);
  }
  console.log(`\n  Install it from ${fallback}`);
  return false;
}

// --- proxy process ---------------------------------------------------------

function readPid(file) {
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function remove(file) {
  try {
    unlinkSync(file);
  } catch {}
}

function isAlive(pid) {
  try {
    // Signal 0 does not kill anything, it just tests for existence.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err.code === "EPERM";
  }
}

function portBusy(port = PORT, timeout = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * ours     -- started from here and still alive
 * foreign  -- something else already holds the port
 * stopped  -- nothing listening
 */
async function proxyStatus() {
  const pid = readPid(PID_FILE);
  if (pid && isAlive(pid)) return { kind: "ours", pid };
  if (pid) remove(PID_FILE); // stale file from a crash or a reboot
  return { kind: (await portBusy()) ? "foreign" : "stopped", pid: null };
}

/** Ask a process to quit, then insist. Resolves true once it is gone. */
async function killPid(pid) {
  try {
    process.kill(pid);
  } catch {}

  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) return true;
    await sleep(250);
  }
  // Windows ignores graceful signals often enough to need the blunt version.
  if (WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(250);
  }
  return !isAlive(pid);
}

function spawnDetached(cmd, args, logFile, mode = "a") {
  const log = openSync(logFile, mode);
  const child = spawn(cmd, args, { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
  child.unref();
  return child;
}

// details:false during a rotation, where the caller prints the block itself
// once everything has settled.
async function startProxy({ details = true } = {}) {
  const status = await proxyStatus();
  if (status.kind === "ours") {
    console.log(`\nAlready running (pid ${status.pid}).`);
    if (details) printBackend({ copy: true });
    return;
  }
  if (status.kind === "foreign") {
    console.log(red(`\nPort ${PORT} is already in use by another program. Close it first, or set PORT.`));
    return;
  }

  // "a" so a restart appends rather than wiping the previous run's errors.
  const child = spawnDetached(process.execPath, ["src/server.js"], LOG_FILE);
  writeFileSync(PID_FILE, String(child.pid));

  process.stdout.write("\nStarting");
  for (let i = 0; i < 40; i++) {
    if (await portBusy()) {
      console.log(green("\nProxy running") + dim(` (pid ${child.pid}, log: proxy.log)`));
      if (details) printBackend({ copy: true });
      return;
    }
    if (!isAlive(child.pid)) break;
    process.stdout.write(".");
    await sleep(250);
  }
  console.log(red("\nIt did not come up.") + ` Check ${LOG_FILE}.`);
}

/**
 * The quick way up: the proxy on its own, and the browser pointed at it.
 *
 * Served from localhost the frontend talks to the backend on the same origin,
 * so no tunnel, no Pages deploy and no address in app.js are involved -- it
 * works the moment the process is listening. A tunnel can still be started
 * afterwards from the menu if the address needs to be shared.
 */
async function startLocal() {
  const status = await proxyStatus();
  if (status.kind === "stopped") {
    await startProxy({ details: false });
    if ((await proxyStatus()).kind !== "ours") return;
  } else if (status.kind === "foreign") {
    console.log(red(`\nPort ${PORT} is already in use by another program. Close it first, or set PORT.`));
    return;
  }

  const url = `http://localhost:${PORT}/`;
  const { code } = ensureAccessCode();
  box(
    "Local",
    [
      `${bold("Open")}         ${cyan(url)}`,
      `${bold("Access code")}  ${yellow(code)}`,
      "",
      dim("Only this machine can reach that. To share it, start a tunnel."),
    ],
    green
  );
  openInBrowser(url);
}

/** Hands a URL to the default browser; silently does nothing if that fails. */
function openInBrowser(url) {
  try {
    // On Windows `start` is a cmd builtin, and an empty first argument is its
    // window title -- without it the URL itself would be taken as the title.
    const [cmd, args] = WIN
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {}
}

async function stopProxy() {
  const status = await proxyStatus();
  if (status.kind === "foreign") {
    console.log(`\nPort ${PORT} is held by a process this script did not start -- leaving it alone.`);
    return;
  }
  if (status.kind === "stopped") {
    console.log("\nNot running.");
    return;
  }

  const { pid } = status;
  const gone = await killPid(pid);
  if (gone) remove(PID_FILE);
  console.log(gone ? `\nStopped (pid ${pid}).` : red(`\nCould not stop pid ${pid}.`));
}

// --- tunnels ---------------------------------------------------------------
//
// Three ways for someone else's browser to reach the backend on this PC. They
// all end in an https address that forwards to localhost:PORT; they differ in
// who runs the daemon and whether the address survives a restart.
//
//   cloudflare  cloudflared, a fresh random trycloudflare.com name every run
//   tailscale   the Tailscale client's Funnel, a stable <pc>.<tailnet>.ts.net
//   devtunnel   Microsoft's devtunnel, a random *.devtunnels.ms name per run
//
// Cloudflare and devtunnel are processes this script starts and tracks by pid;
// Tailscale's is configuration held by its own daemon, so it is asked instead.

const TRYCLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DEVTUNNEL = /https:\/\/[a-z0-9-]+\.[a-z0-9]+\.devtunnels\.ms/i;
const TS_NET = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i;

function tailscaleStatus() {
  const res = spawnSync("tailscale", ["funnel", "status"], { encoding: "utf8" });
  const text = (res.stdout || "") + (res.stderr || "");
  const match = text.match(TS_NET);
  const running = res.status === 0 && Boolean(match) && new RegExp(`:${PORT}\\b`).test(text);
  return { running, pid: null, url: running ? match[0] : null };
}

function tunnelStatus() {
  if (provider() === "tailscale") return tailscaleStatus();
  const pid = readPid(TUNNEL_PID_FILE);
  if (pid && isAlive(pid)) {
    let url = null;
    try {
      url = readFileSync(TUNNEL_URL_FILE, "utf8").trim() || null;
    } catch {}
    return { running: true, pid, url };
  }
  if (pid) {
    remove(TUNNEL_PID_FILE);
    remove(TUNNEL_URL_FILE);
  }
  return { running: false, pid: null, url: null };
}

/** Waits for an address to appear in the tunnel log, or the process to die. */
async function waitForAddress(child, pattern, note) {
  process.stdout.write("\nOpening tunnel");
  for (let i = 0; i < 90; i++) {
    let text = "";
    try {
      text = readFileSync(TUNNEL_LOG, "utf8");
    } catch {}
    const match = text.match(pattern);
    if (match) {
      writeFileSync(TUNNEL_URL_FILE, match[0]);
      console.log(green("\n\nTunnel up") + dim(` (pid ${child.pid})`));
      if (note) console.log(dim(note));
      printBackend({ copy: true });
      return;
    }
    if (!isAlive(child.pid)) break;
    process.stdout.write(".");
    await sleep(500);
  }
  console.log(red("\nNo address appeared.") + ` Check ${TUNNEL_LOG}.`);
}

async function startTunnel() {
  const which = provider();
  if (which === "local") {
    console.log("\nSet up for this PC only. Run first-time setup again to pick a tunnel provider.");
    return;
  }
  const existing = tunnelStatus();
  if (existing.running) {
    console.log(`\nTunnel already running: ${existing.url || "address not read yet"}`);
    return;
  }
  const tool = PROVIDERS[which].tool;
  if (!onPath(tool)) {
    console.log(red(`\n${tool} is not installed.`) + " Run first-time setup again from the menu to install it.");
    return;
  }
  if ((await proxyStatus()).kind === "stopped") {
    console.log("\nStart the proxy first -- a tunnel to nothing just returns errors.");
    return;
  }

  if (which === "cloudflare") {
    // Truncate: the address is scraped back out of this log, and a previous
    // run's address would be picked up as if it were live.
    const child = spawnDetached("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], TUNNEL_LOG, "w");
    writeFileSync(TUNNEL_PID_FILE, String(child.pid));
    await waitForAddress(child, TRYCLOUDFLARE, "It is a fresh random address every time the tunnel restarts.");
    return;
  }

  if (which === "devtunnel") {
    const child = spawnDetached("devtunnel", ["host", "-p", String(PORT), "--allow-anonymous"], TUNNEL_LOG, "w");
    writeFileSync(TUNNEL_PID_FILE, String(child.pid));
    await waitForAddress(child, DEVTUNNEL, "Anonymous access is on: visitors need no Microsoft account, just the access code.");
    return;
  }

  if (which === "tailscale") {
    const res = spawnSync("tailscale", ["funnel", "--bg", String(PORT)], { encoding: "utf8" });
    const text = (res.stdout || "") + (res.stderr || "");
    const status = tailscaleStatus();
    if (res.status !== 0 || !status.running) {
      console.log(red("\nTailscale did not enable Funnel:"));
      console.log(text.trim());
      console.log("\nFunnel has to be allowed for your tailnet once, in the admin console -- Tailscale prints");
      console.log("the exact link when it is not. Then try again.");
      return;
    }
    console.log(green("\nFunnel on") + dim(" (a stable address: it survives restarts, and it is off when you say so)"));
    printBackend({ copy: true });
  }
}

async function stopTunnel() {
  if (provider() === "tailscale") {
    if (!tailscaleStatus().running) {
      console.log("\nFunnel is not on.");
      return;
    }
    const res = spawnSync("tailscale", ["funnel", "reset"], { encoding: "utf8" });
    if (res.status !== 0) spawnSync("tailscale", ["serve", "reset"], { encoding: "utf8" });
    console.log(tailscaleStatus().running ? red("\nCould not turn Funnel off.") : "\nFunnel off.");
    return;
  }
  const status = tunnelStatus();
  if (!status.running) {
    console.log("\nTunnel is not running.");
    return;
  }
  const gone = await killPid(status.pid);
  if (gone) {
    remove(TUNNEL_PID_FILE);
    remove(TUNNEL_URL_FILE);
  }
  console.log(gone ? `\nTunnel stopped (pid ${status.pid}).` : red(`\nCould not stop pid ${status.pid}.`));
}

/** https://x.example -> wss://x.example/wisp/ */
function wispFrom(url) {
  return url.replace(/^https:/i, "wss:").replace(/\/*$/, "") + "/wisp/";
}

/**
 * Points DEFAULT_WISP in public/app.js at this tunnel, so the deployed Pages
 * site uses it without anyone having to touch Backend settings. Only Pages
 * needs it: served from the tunnel itself, the page finds the backend on its
 * own origin.
 */
function useTunnelAsDefault(url) {
  const wisp = wispFrom(url);
  let source;
  try {
    source = readFileSync(APP_JS, "utf8");
  } catch {
    console.log(red(`\nCould not read ${APP_JS}.`));
    return;
  }
  const line = /const DEFAULT_WISP = "[^"]*";/;
  if (!line.test(source)) {
    console.log(red("\nDEFAULT_WISP is not where it used to be in public/app.js -- edit it by hand."));
    return;
  }
  writeFileSync(APP_JS, source.replace(line, `const DEFAULT_WISP = "${wisp}";`));
  console.log(`\npublic/app.js now defaults to:\n  ${cyan(wisp)}`);
  console.log("\nCommit and push for the Pages site to pick it up:");
  console.log(dim('  git commit -am "Point at the current tunnel" && git push'));
}

// --- backend details -------------------------------------------------------

/** owner/repo from the git remote, for the Pages link. */
function repoSlug() {
  const res = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: root, encoding: "utf8" });
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\s*$/.exec(res.stdout || "");
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** https://<owner>.github.io/<repo>/ -- where the deployed frontend lives. */
function pagesLink() {
  const slug = repoSlug();
  if (!slug) return null;
  const owner = slug.owner.toLowerCase();
  // A repo literally named <owner>.github.io is served from the domain root.
  return slug.repo.toLowerCase() === `${owner}.github.io`
    ? `https://${owner}.github.io/`
    : `https://${owner}.github.io/${slug.repo}/`;
}

/** Puts text on the clipboard. Best effort -- reports whether it landed. */
function copyToClipboard(text) {
  const [cmd, args] = WIN ? ["clip", []] : process.platform === "darwin" ? ["pbcopy", []] : ["xclip", ["-selection", "clipboard"]];
  try {
    return spawnSync(cmd, args, { input: text }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Everything needed to actually use the backend, in one box: where to send
 * people, the code they need once they get there, and the plumbing underneath.
 * The access code is what gets copied -- it is the thing you hand out.
 */
function printBackend({ copy = false } = {}) {
  const { token } = ensureToken();
  const { code } = ensureAccessCode();
  const tunnel = tunnelStatus();
  const pages = pagesLink();
  const copied = copy && copyToClipboard(code);

  const lines = [];
  if (tunnel.url) lines.push(`${bold("Link")}         ${cyan(tunnel.url)}`);
  else lines.push(`${bold("Link")}         ${cyan(`http://localhost:${PORT}/`)}  ${dim("(this PC only: no tunnel is up)")}`);
  if (pages) lines.push(`${bold("Pages link")}   ${cyan(pages)}  ${dim("(needs the address below pushed)")}`);
  lines.push(`${bold("Access code")}  ${yellow(code)}${copied ? dim("  copied") : ""}`);
  lines.push("");
  lines.push(dim("Give people the link and the code. The link alone does nothing."));
  lines.push("");
  lines.push(dim(`backend   ${tunnel.url ? wispFrom(tunnel.url) : `ws://localhost:${PORT}/wisp/`}`));
  lines.push(dim(`secret    ${token}  (.wisp-token, stays on this PC)`));
  box("Backend", lines);
}

/**
 * Rotates the backend secret: every browser that has unlocked stops working
 * until it enters the access code again, which is the point.
 */
async function rotateToken(rl) {
  const answer = await ask(rl, "\nEvery browser using the proxy will have to enter the access code again. Continue? [y/N] ");
  if (answer === null || !/^y/i.test(answer.trim())) {
    console.log("\nLeft alone.");
    return;
  }
  remove(TOKEN_FILE);
  ensureToken();
  // The running backend still holds the old one in memory.
  if ((await proxyStatus()).kind === "ours") {
    console.log("\nRestarting the proxy so it picks the new one up.");
    await stopProxy();
    await startProxy({ details: false });
  }
  printBackend({ copy: true });
}

/**
 * Changes the access code. Browsers already unlocked keep working -- they hold
 * the token, not the code -- so to cut people off, rotate the secret as well.
 */
async function changeAccessCode(rl) {
  const current = readAccessCode();
  const suggestion = generateAccessCode();
  console.log(`\nCurrent code: ${yellow(current)}`);
  const answer = await ask(rl, `New code [Enter for ${suggestion}, or type your own]: `);
  if (answer === null) return;
  const next = answer.trim() || suggestion;
  if (next.length < 6) {
    console.log(red("\nToo short. Six characters or more, please."));
    return;
  }
  setAccessCode(next);
  console.log(green(`\nAccess code is now ${next}`) + dim(" -- the backend reads it fresh, no restart needed."));
  console.log(dim("Anyone already unlocked stays unlocked. To throw everyone out, change the backend secret too."));
  printBackend({ copy: true });
}

// --- first-time setup ------------------------------------------------------

// Set once the input stream ends -- Ctrl+D, a closed window, or a piped run.
// Prompts after that answer null, which every caller reads as "close", so the
// script exits quietly instead of throwing ERR_USE_AFTER_CLOSE.
let inputClosed = false;
let onInputClosed = () => {};
const inputClosedPromise = new Promise((resolve) => {
  onInputClosed = resolve;
});

async function ask(rl, prompt) {
  if (inputClosed) return null;
  try {
    // Raced against the stream ending: a question asked just before Ctrl+D or
    // a closed window would otherwise wait forever for an answer.
    return await Promise.race([rl.question(prompt), inputClosedPromise.then(() => null)]);
  } catch {
    return null;
  }
}

function report(checks) {
  const rows = checks.map(
    (c) => `${c.state === "ok" ? OK : c.state === "bad" ? BAD : WARN} ${c.label}${c.detail ? dim(`  ${c.detail}`) : ""}`
  );
  box("Checks", rows);
}

/** Runs every check, offers the fixes, and says whether the proxy can run. */
async function runChecks(rl) {
  let checks = allChecks();
  report(checks);

  for (const check of checks.filter((c) => c.state === "bad" && c.fix)) {
    const answer = await ask(rl, `\n${check.label} -- run ${bold(check.fix.label)} now? [Y/n] `);
    if (answer === null) return false;
    if (/^n/i.test(answer.trim())) continue;
    console.log("");
    const ok = check.fix.run();
    console.log(ok ? green(`\n${check.fix.label} finished.`) : red(`\n${check.fix.label} failed -- see above.`));
  }

  checks = allChecks();
  const blocking = checks.filter((c) => c.state === "bad");
  if (blocking.length) {
    console.log(red("\nStill not ready:"));
    for (const c of blocking) console.log(`  - ${c.label}${c.detail ? ` (${c.detail})` : ""}`);
  }
  return blocking.length === 0;
}

/**
 * Walks through the one-off decisions: the two secrets, and how people reach
 * the proxy. Everything it settles is written to .ikonic.json (which provider)
 * and the two secret files, none of which are committed.
 */
async function firstRun(rl) {
  box(
    "First-time setup",
    [
      "Three things get settled here, once:",
      "",
      `  1. ${bold("the backend secret")}   made for you, stays on this PC`,
      `  2. ${bold("the access code")}      what you give people, with the link`,
      `  3. ${bold("how people reach it")}  this PC only, or through a tunnel`,
    ],
    magenta
  );

  const ready = await runChecks(rl);

  // 1 + 2: secrets.
  const { token } = ensureToken();
  const { code, created } = ensureAccessCode();
  box("Secrets", [
    `${bold("Backend secret")}  ${dim(token)}`,
    dim("  Gates the socket itself. Never shown to visitors."),
    "",
    `${bold("Access code")}     ${yellow(code)}${created ? dim("  (just generated)") : ""}`,
    dim("  Visitors type this; only then does the page get the secret."),
    dim("  A link alone is worth nothing. Change it any time from the menu."),
  ]);
  const custom = await ask(rl, `Keep the access code ${yellow(code)}? [Enter to keep, or type a new one] `);
  if (custom === null) return false;
  if (custom.trim()) {
    if (custom.trim().length < 6) console.log(red("Too short to use -- keeping the generated one."));
    else {
      setAccessCode(custom.trim());
      console.log(green(`Access code is now ${custom.trim()}`));
    }
  }

  // 3: reach.
  const keys = Object.keys(PROVIDERS);
  box("How will people reach it?", [
    `  1) ${PROVIDERS.local.name}`,
    dim("       Only this machine. The quickest way to try it."),
    `  2) ${PROVIDERS.cloudflare.name}`,
    dim("       Free, no account. A new random address every time it starts."),
    `  3) ${PROVIDERS.tailscale.name}`,
    dim("       Free account. A stable address that survives restarts."),
    `  4) ${PROVIDERS.devtunnel.name}`,
    dim("       Free Microsoft account. Random address per run."),
  ]);
  const current = keys.indexOf(provider()) + 1;
  const pick = await ask(rl, `Choice [1-4, Enter for ${current}]: `);
  if (pick === null) return false;
  const which = keys[(parseInt(pick.trim(), 10) || current) - 1] || provider();
  writeConfig({ provider: which, firstRunDone: true });
  console.log(`\nUsing: ${bold(PROVIDERS[which].name)}`);

  await prepareProvider(rl, which);

  box(
    "Done",
    [
      ready ? green("Everything needed is in place.") : red("Some checks still fail -- see above."),
      "",
      `Next: pick ${bold("Start locally")} from the menu to try it here,`,
      which === "local"
        ? dim("or run this again to choose a tunnel when you want to share it.")
        : dim(`then ${bold("Start a tunnel")} to get a link for other people.`),
    ],
    green
  );
  return ready;
}

/** Installs and signs in to the chosen tunnel tool, as far as that can be automated. */
async function prepareProvider(rl, which) {
  const p = PROVIDERS[which];
  if (!p.tool) return;

  if (!onPath(p.tool)) {
    const ids = {
      cloudflared: ["Cloudflare.cloudflared", "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"],
      tailscale: ["tailscale.tailscale", "https://tailscale.com/download"],
      devtunnel: ["Microsoft.devtunnel", "https://aka.ms/devtunnels/download"],
    }[p.tool];
    const answer = await ask(rl, `\n${p.tool} is not installed. Install it now? [Y/n] `);
    if (answer !== null && !/^n/i.test(answer.trim())) {
      const ok = installTool(ids[0], ids[1]);
      if (ok && !onPath(p.tool)) console.log(yellow("\nInstalled, but not on PATH in this window yet -- close and reopen this setup."));
    }
    if (!onPath(p.tool)) return;
  }

  if (which === "tailscale") {
    const st = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
    let state = null;
    try {
      state = JSON.parse(st.stdout || "{}").BackendState;
    } catch {}
    if (state !== "Running") {
      console.log(`\nTailscale is installed but not signed in (state: ${state || "unknown"}).`);
      const answer = await ask(rl, "Sign in now? It opens a browser window. [Y/n] ");
      if (answer !== null && !/^n/i.test(answer.trim())) run("tailscale", ["up"]);
    } else console.log(green("\nTailscale is signed in."));
    console.log(dim("Funnel itself is enabled per tailnet, once, from the admin console; Tailscale shows the link if it is not."));
  }

  if (which === "devtunnel") {
    const st = spawnSync("devtunnel", ["user", "show"], { encoding: "utf8" });
    const text = (st.stdout || "") + (st.stderr || "");
    if (!/logged in as/i.test(text)) {
      console.log("\ndevtunnel is installed but not signed in.");
      const answer = await ask(rl, "Sign in now with a Microsoft account? It opens a browser window. [Y/n] ");
      if (answer !== null && !/^n/i.test(answer.trim())) run("devtunnel", ["user", "login"]);
    } else console.log(green("\ndevtunnel is signed in."));
  }

  if (which === "cloudflare") console.log(green("\ncloudflared is installed; nothing to sign in to."));
}

// --- menu ------------------------------------------------------------------

async function menu(rl, ready) {
  for (;;) {
    const proxy = await proxyStatus();
    const tunnel = tunnelStatus();
    const running = proxy.kind !== "stopped";
    const which = provider();

    console.log("");
    const status = [];
    if (proxy.kind === "ours") status.push(`${bold("Proxy")}   ${green("running")}${dim(`  port ${PORT}, pid ${proxy.pid}`)}`);
    else if (proxy.kind === "foreign") status.push(`${bold("Proxy")}   ${yellow(`port ${PORT} in use by another program`)}`);
    else status.push(`${bold("Proxy")}   ${red("stopped")}`);
    status.push(
      `${bold("Tunnel")}  ${tunnel.running ? green(tunnel.url || "up, address not read yet") : dim("off")}${dim(`  (${PROVIDERS[which].name})`)}`
    );
    box("Status", status, blue);

    // Built per pass so each entry reflects the state just printed. The local
    // entry comes first because it is the one most people want most of the time.
    const notReady = async () => console.log(red("\nFix the items above first -- the proxy will not work as it stands."));
    const options = [
      {
        label: running ? `Open it locally  ${dim(`http://localhost:${PORT}`)}` : `Start locally  ${dim(`proxy only, opens http://localhost:${PORT}`)}`,
        run: ready ? startLocal : notReady,
      },
      running ? { label: "Stop the proxy", run: stopProxy } : { label: "Start the proxy", run: ready ? startProxy : notReady },
    ];
    if (which !== "local") {
      options.push(
        tunnel.running
          ? { label: `Stop the tunnel  ${dim(PROVIDERS[which].name)}`, run: stopTunnel }
          : { label: `Start a tunnel  ${dim(PROVIDERS[which].name)}`, run: startTunnel }
      );
    }
    if (tunnel.url) {
      options.push({ label: `Use that address as the Pages default  ${dim("edits public/app.js")}`, run: async () => useTunnelAsDefault(tunnel.url) });
    }
    options.push({ label: `Show the link and access code  ${dim("copies the code")}`, run: async () => printBackend({ copy: true }) });
    options.push({ label: "Change the access code", run: async () => changeAccessCode(rl) });
    options.push({ label: `Change the backend secret  ${dim("logs everyone out")}`, run: async () => rotateToken(rl) });
    options.push({
      label: `Run first-time setup again  ${dim("tunnel provider, secrets, checks")}`,
      run: async () => {
        ready = await firstRun(rl);
      },
    });
    options.push({ label: "Close", close: true });

    options.forEach((option, i) => console.log(`  ${cyan(String(i + 1) + ")")} ${option.label}`));

    const reply = await ask(rl, `\n${bold("Choice")} [1-${options.length}]: `);
    if (reply === null) return;
    const answer = reply.trim().toLowerCase();
    if (answer === "" || answer === "q" || answer === "close") return;

    const choice = options[parseInt(answer, 10) - 1];
    if (!choice) {
      console.log(`Pick a number between 1 and ${options.length}.`);
      continue;
    }
    if (choice.close) return;
    await choice.run();
  }
}

// --- entry -----------------------------------------------------------------

const arg = (process.argv[2] || "").replace(/^--/, "");
const COMMANDS = ["start", "local", "stop", "status", "check", "tunnel", "tunnel-stop", "backend", "code"];

if (COMMANDS.includes(arg)) {
  // Non-interactive forms, useful from other scripts or a shortcut.
  if (arg === "start") await startProxy();
  else if (arg === "local") await startLocal();
  else if (arg === "stop") await stopProxy();
  else if (arg === "tunnel") await startTunnel();
  else if (arg === "tunnel-stop") await stopTunnel();
  else if (arg === "backend") printBackend({ copy: true });
  else if (arg === "code") console.log(ensureAccessCode().code);
  else if (arg === "status") {
    const proxy = await proxyStatus();
    const tunnel = tunnelStatus();
    console.log(`proxy   ${proxy.kind === "ours" ? `running (pid ${proxy.pid})` : proxy.kind}`);
    console.log(`tunnel  ${tunnel.running ? tunnel.url || `running (pid ${tunnel.pid})` : "stopped"} (${provider()})`);
  } else {
    report(allChecks());
    const bad = [checkNode(), checkDeps(), checkAssets(), checkFrontend()].some((c) => c.state === "bad");
    process.exitCode = bad ? 1 : 0;
  }
} else if (!process.stdin.isTTY && arg !== "setup") {
  // No console to prompt in -- report and stop rather than hanging on input.
  banner();
  report(allChecks());
  const proxy = await proxyStatus();
  const tunnel = tunnelStatus();
  console.log(`\nProxy:  ${proxy.kind === "ours" ? `running (pid ${proxy.pid})` : proxy.kind}`);
  console.log(`Tunnel: ${tunnel.running ? tunnel.url || `running (pid ${tunnel.pid})` : "stopped"}`);
  console.log("Run this in a terminal for the start/stop menu.");
} else {
  // `setup` forces the first-time walk-through even when it has been done.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => {
    inputClosed = true;
    onInputClosed();
  });
  try {
    banner();
    const cfg = readConfig();
    const ready = cfg && cfg.firstRunDone && arg !== "setup" ? await runChecks(rl) : await firstRun(rl);
    if (!inputClosed) await menu(rl, ready);
  } finally {
    rl.close();
  }
  console.log(dim("\nBye.\n"));
}
