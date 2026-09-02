// Setup / control panel. Run via: npm run setup  (or double-click setup.cmd)
//
// It does three things, in order:
//   1. checks that everything needed to run the proxy is present, and offers
//      to fix what is missing (npm install / npm run assets)
//   2. reports whether the wisp backend is already running
//   3. opens a small menu: start the proxy, stop it if it is already up, or
//      close and leave things as they are
//
// The proxy is started detached with its output going to proxy.log, so closing
// this menu -- or the window it opened in -- does not kill the backend.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureToken, TOKEN_FILE } from "../src/token.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const PID_FILE = root + ".proxy.pid";
const LOG_FILE = root + "proxy.log";
const TUNNEL_PID_FILE = root + ".tunnel.pid";
const TUNNEL_URL_FILE = root + ".tunnel.url";
const TUNNEL_LOG = root + "tunnel.log";
const APP_JS = root + "public/app.js";
const PORT = parseInt(process.env.PORT || "8080", 10);
const WIN = process.platform === "win32";

const OK = "  ok  ";
const BAD = " miss ";
const WARN = " warn ";

// --- checks ----------------------------------------------------------------

// Every dependency that has to be unpacked in node_modules before anything
// else works. Checked by directory rather than require.resolve() because these
// packages do not all export their own package.json.
const DEPS = [
  "@mercuryworkshop/scramjet",
  "@mercuryworkshop/libcurl-transport",
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
  "public/m/mx/index.js",
  "public/m/mx/worker.js",
  "public/m/t1/index.mjs",
  "public/m/t2/index.mjs",
  "public/m/e2/e2.js",
  "public/m/e2/e2w.js",
  "public/m/e2/e2h.js",
  "public/m/e2/e2c.js",
];

// Hand-written frontend. If one of these is gone the repo is damaged and no
// automatic fix applies.
const FRONTEND = ["public/index.html", "public/app.js", "public/style.css", "public/sw.js", "public/cfg.js"];

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

// The backend refuses any socket that does not carry the token, so the Pages
// build needs it as a repository secret -- otherwise the deployed site loads
// and then reports nothing but "backend unreachable". Nothing here can read
// GitHub's secrets, so this reports the token and says what to do with it.
function checkToken() {
  const { token, created } = ensureToken();

  // A committed token would be public along with the repo, which is the whole
  // thing this is meant to prevent.
  let committed = false;
  try {
    committed = /const WISP_TOKEN = "\S+";/.test(readFileSync(APP_JS, "utf8"));
  } catch {}
  if (committed) {
    // Warn rather than block: the proxy still runs, it is the secrecy that broke.
    return {
      label: "Backend token (.wisp-token)",
      state: "warn",
      detail: "public/app.js has a token written into it -- clear it, the repo is public",
    };
  }

  return {
    label: "Backend token (.wisp-token)",
    state: created ? "warn" : "ok",
    detail: created
      ? `generated just now: ${token} -- set it as the WISP_TOKEN repository secret for Pages`
      : "served locally, injected on Pages from the WISP_TOKEN secret",
  };
}

function checkCloudflared() {
  const probe = spawnSync(WIN ? "where" : "which", ["cloudflared"], { encoding: "utf8" });
  const found = probe.status === 0 && probe.stdout.trim();
  return {
    label: "cloudflared (only needed to expose the backend)",
    state: found ? "ok" : "warn",
    detail: found
      ? found.split(/\r?\n/)[0].trim()
      : "not on PATH -- the proxy still runs locally, but the Pages site cannot reach it",
  };
}

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
    console.log(`\nPort ${PORT} is already in use by another program. Close it first, or set PORT.`);
    return;
  }

  // "a" so a restart appends rather than wiping the previous run's errors.
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  process.stdout.write("\nStarting");
  for (let i = 0; i < 40; i++) {
    if (await portBusy()) {
      console.log(`\nProxy running (pid ${child.pid})`);
      console.log(`  frontend  http://localhost:${PORT}`);
      console.log(`  log       ${LOG_FILE}`);
      if ((await proxyStatus()).kind === "ours" && !tunnelStatus().running) {
        console.log(`\nTo let the Pages site reach it:  cloudflared tunnel --url http://localhost:${PORT}`);
      }
      if (details) printBackend({ copy: true });
      return;
    }
    if (!isAlive(child.pid)) break;
    process.stdout.write(".");
    await sleep(250);
  }
  console.log(`\nIt did not come up. Check ${LOG_FILE}.`);
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
    console.log(`\nPort ${PORT} is already in use by another program. Close it first, or set PORT.`);
    return;
  }

  const url = `http://localhost:${PORT}/`;
  console.log(`\nLocal:  ${url}`);
  console.log("Only this machine can reach that. To share it, start a tunnel from the menu.");
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
  console.log(gone ? `\nStopped (pid ${pid}).` : `\nCould not stop pid ${pid}.`);
}

// --- cloudflare tunnel -----------------------------------------------------

// What cloudflared prints once a quick tunnel is up. The hostname is three or
// four random words, and it is different on every restart.
const TRYCLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function tunnelStatus() {
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

async function startTunnel() {
  const existing = tunnelStatus();
  if (existing.running) {
    console.log(`\nTunnel already running (pid ${existing.pid}): ${existing.url || "address not read yet"}`);
    return;
  }
  if (checkCloudflared().state !== "ok") {
    console.log("\ncloudflared is not installed. On Windows:");
    console.log("  winget install --id Cloudflare.cloudflared");
    console.log("Otherwise see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    return;
  }
  if ((await proxyStatus()).kind === "stopped") {
    console.log("\nStart the proxy first -- a tunnel to nothing just returns errors.");
    return;
  }

  // Truncate: the address is scraped back out of this log, and a previous
  // run's address would be picked up as if it were live.
  const log = openSync(TUNNEL_LOG, "w");
  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(TUNNEL_PID_FILE, String(child.pid));

  process.stdout.write("\nOpening tunnel");
  for (let i = 0; i < 60; i++) {
    let text = "";
    try {
      text = readFileSync(TUNNEL_LOG, "utf8");
    } catch {}
    const match = text.match(TRYCLOUDFLARE);
    if (match) {
      const url = match[0];
      writeFileSync(TUNNEL_URL_FILE, url);
      console.log(`\n\nTunnel up (pid ${child.pid})`);
      console.log("It is a fresh random address every time the tunnel restarts.");
      printBackend({ copy: true });
      return;
    }
    if (!isAlive(child.pid)) break;
    process.stdout.write(".");
    await sleep(500);
  }
  console.log(`\nNo address appeared. Check ${TUNNEL_LOG}.`);
}

async function stopTunnel() {
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
  console.log(gone ? `\nTunnel stopped (pid ${status.pid}).` : `\nCould not stop pid ${status.pid}.`);
}

/** https://x.trycloudflare.com -> wss://x.trycloudflare.com/wisp/ */
function wispFrom(url) {
  return url.replace(/^https:/i, "wss:").replace(/\/*$/, "") + "/wisp/";
}

/**
 * Points DEFAULT_WISP in public/app.js at this tunnel, so the deployed site
 * uses it without anyone having to touch Backend settings.
 *
 * The address stays tokenless on purpose: this file is committed to a public
 * repo, and the backend token is substituted at serve time instead (locally by
 * src/server.js, on Pages from the WISP_TOKEN repository secret).
 */
function useTunnelAsDefault(url) {
  const wisp = wispFrom(url);
  let source;
  try {
    source = readFileSync(APP_JS, "utf8");
  } catch {
    console.log(`\nCould not read ${APP_JS}.`);
    return;
  }

  const line = /const DEFAULT_WISP = "[^"]*";/;
  if (!line.test(source)) {
    console.log("\nDEFAULT_WISP is not where it used to be in public/app.js -- edit it by hand.");
    return;
  }
  writeFileSync(APP_JS, source.replace(line, `const DEFAULT_WISP = "${wisp}";`));
  console.log(`\npublic/app.js now defaults to:\n  ${wisp}`);
  console.log("\nCommit and push for the Pages site to pick it up:");
  console.log('  git commit -am "Point at the current tunnel" && git push');
}

// --- backend details -------------------------------------------------------

/** owner/repo from the git remote, for the Pages link and the gh command. */
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
 * Everything needed to actually use the backend, in one block: where to send
 * people, what address the site talks to, and the secret that address carries.
 * Printed after starting things, and on demand from the menu.
 */
function printBackend({ copy = false } = {}) {
  const { token } = ensureToken();
  const tunnel = tunnelStatus();
  const pages = pagesLink();
  const slug = repoSlug();

  console.log("\n" + line("="));
  console.log(" Backend");
  console.log(line("="));

  if (tunnel.url) {
    // Same origin as the wisp socket, so it needs no DEFAULT_WISP and cannot
    // go stale -- but the hostname changes every time the tunnel restarts.
    console.log("  Link (always current, rotates)");
    console.log(`    ${tunnel.url}`);
  }
  if (pages) {
    console.log(`${tunnel.url ? "\n" : ""}  Link (stable, needs the address below to be pushed)`);
    console.log(`    ${pages}`);
  }

  console.log("\n  Backend address");
  console.log(`    ${tunnel.url ? wispFrom(tunnel.url) + token + "/" : `ws://localhost:${PORT}/wisp/${token}/`}`);

  const copied = copy && copyToClipboard(token);
  console.log("\n  Secret" + (copied ? "  (copied to clipboard)" : ""));
  console.log(`    ${token}`);

  console.log("\n  It lives in .wisp-token. The Pages build needs the same value as the");
  console.log("  WISP_TOKEN repository secret, or the deployed site cannot reach the backend:");
  console.log(`    gh secret set WISP_TOKEN${slug ? ` --repo ${slug.owner}/${slug.repo}` : ""} --body "${token}"`);
  console.log(line());
}

/**
 * Rotates the secret: old links stop working immediately, which is the point.
 * Only the local half can be automated -- the repository secret is GitHub's.
 */
async function rotateToken(rl) {
  const answer = await ask(rl, "\nThis cuts off everyone using the current link. Continue? [y/N] ");
  if (answer === null || !/^y/i.test(answer.trim())) {
    console.log("\nLeft alone.");
    return;
  }

  remove(TOKEN_FILE);
  const { token } = ensureToken();
  console.log(`\nNew secret: ${token}`);

  // The running backend still holds the old one in memory.
  if ((await proxyStatus()).kind === "ours") {
    console.log("\nRestarting the proxy so it picks the new one up.");
    await stopProxy();
    await startProxy({ details: false });
  }
  printBackend({ copy: true });
  console.log("\nSet that as the repository secret, then push, or the deployed site stays cut off.");
}

// --- menu ------------------------------------------------------------------

// Set once the input stream ends -- Ctrl+D, a closed window, or a piped run.
// Prompts after that answer null, which every caller reads as "close", so the
// script exits quietly instead of throwing ERR_USE_AFTER_CLOSE.
let inputClosed = false;

async function ask(rl, prompt) {
  if (inputClosed) return null;
  try {
    return await rl.question(prompt);
  } catch {
    return null;
  }
}

function line(char = "-") {
  return char.repeat(64);
}

function report(checks) {
  console.log("\n" + line("="));
  console.log(" Scramjet self-host -- setup");
  console.log(line("="));
  for (const c of checks) {
    const tag = c.state === "ok" ? OK : c.state === "warn" ? WARN : BAD;
    console.log(`[${tag}] ${c.label}`);
    if (c.detail) console.log(`         ${c.detail}`);
  }
}

async function runChecks(rl) {
  let checks = [checkNode(), checkDeps(), checkAssets(), checkFrontend(), checkToken(), checkCloudflared()];
  report(checks);

  // Anything with a fix gets offered; the rest is reported and left alone.
  for (const check of checks) {
    if (check.state !== "bad" || !check.fix) continue;
    const answer = await ask(rl, `\nRun "${check.fix.label}" to fix "${check.label}"? [Y/n] `);
    if (answer === null || /^n/i.test(answer.trim())) continue;
    console.log();
    if (!check.fix.run()) console.log(`\n"${check.fix.label}" failed.`);
  }

  // Re-run so the summary reflects whatever the fixes changed.
  checks = [checkNode(), checkDeps(), checkAssets(), checkFrontend(), checkToken(), checkCloudflared()];
  const blocking = checks.filter((c) => c.state === "bad");
  if (blocking.length) {
    console.log("\n" + line());
    console.log("Still not ready:");
    for (const c of blocking) console.log(`  - ${c.label}${c.detail ? ` (${c.detail})` : ""}`);
  }
  return blocking.length === 0;
}

async function menu(rl, ready) {
  for (;;) {
    const proxy = await proxyStatus();
    const tunnel = tunnelStatus();
    const running = proxy.kind !== "stopped";

    console.log("\n" + line());
    if (proxy.kind === "ours") console.log(`Proxy:  running on port ${PORT} (pid ${proxy.pid})`);
    else if (proxy.kind === "foreign") console.log(`Proxy:  port ${PORT} in use by another program`);
    else console.log("Proxy:  stopped");
    console.log(tunnel.running ? `Tunnel: ${tunnel.url || `pid ${tunnel.pid}, address not read yet`}` : "Tunnel: stopped");
    console.log(line());

    // Built per pass so each entry reflects the state just printed. The local
    // entry comes first because it is the one most people want most of the time.
    const options = [
      {
        label: running
          ? `Open it locally (http://localhost:${PORT}, no tunnel needed)`
          : `Start locally (proxy only, opens http://localhost:${PORT})`,
        run: ready
          ? startLocal
          : async () => console.log("\nFix the items above first -- the proxy will not work as it stands."),
      },
      running
        ? { label: "Stop the proxy", run: stopProxy }
        : {
            label: "Start the proxy",
            run: ready
              ? startProxy
              : async () => console.log("\nFix the items above first -- the proxy will not work as it stands."),
          },
      tunnel.running
        ? { label: "Stop the tunnel", run: stopTunnel }
        : { label: "Start a tunnel (free trycloudflare.com address)", run: startTunnel },
    ];
    if (tunnel.url) {
      options.push({
        label: "Use that address as the site default (edits public/app.js)",
        run: async () => useTunnelAsDefault(tunnel.url),
      });
    }
    options.push({
      label: "Show the link and secret (copies the secret)",
      run: async () => printBackend({ copy: true }),
    });
    options.push({ label: "Change the backend secret", run: async () => rotateToken(rl) });
    options.push({ label: "Close", close: true });

    options.forEach((option, i) => console.log(`  ${i + 1}) ${option.label}`));

    const reply = await ask(rl, `\nChoice [1-${options.length}]: `);
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
const COMMANDS = ["start", "local", "stop", "status", "check", "tunnel", "tunnel-stop", "backend"];

if (COMMANDS.includes(arg)) {
  // Non-interactive forms, useful from other scripts or a shortcut.
  if (arg === "start") await startProxy();
  else if (arg === "local") await startLocal();
  else if (arg === "stop") await stopProxy();
  else if (arg === "tunnel") await startTunnel();
  else if (arg === "tunnel-stop") await stopTunnel();
  else if (arg === "backend") printBackend({ copy: true });
  else if (arg === "status") {
    const proxy = await proxyStatus();
    const tunnel = tunnelStatus();
    console.log(`proxy   ${proxy.kind === "ours" ? `running (pid ${proxy.pid})` : proxy.kind}`);
    console.log(`tunnel  ${tunnel.running ? tunnel.url || `running (pid ${tunnel.pid})` : "stopped"}`);
  } else {
    report([checkNode(), checkDeps(), checkAssets(), checkFrontend(), checkToken(), checkCloudflared()]);
    const bad = [checkNode(), checkDeps(), checkAssets(), checkFrontend()].some((c) => c.state === "bad");
    process.exitCode = bad ? 1 : 0;
  }
} else if (!process.stdin.isTTY) {
  // No console to prompt in -- report and stop rather than hanging on input.
  report([checkNode(), checkDeps(), checkAssets(), checkFrontend(), checkToken(), checkCloudflared()]);
  const proxy = await proxyStatus();
  const tunnel = tunnelStatus();
  console.log(`\nProxy:  ${proxy.kind === "ours" ? `running (pid ${proxy.pid})` : proxy.kind}`);
  console.log(`Tunnel: ${tunnel.running ? tunnel.url || `running (pid ${tunnel.pid})` : "stopped"}`);
  console.log("Run this in a terminal for the start/stop menu.");
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => {
    inputClosed = true;
  });
  try {
    const ready = await runChecks(rl);
    await menu(rl, ready);
  } finally {
    rl.close();
  }
  console.log("\nBye.");
}
