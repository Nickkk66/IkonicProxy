// Wisp backend + static file server.
//
// On your home PC this process does two jobs:
//   1. serves public/ for local testing at http://localhost:8080
//   2. terminates the wisp websocket at /wisp/ -- this is the part that
//      actually opens sockets to target sites, and the only part that MUST
//      run on your machine once the frontend lives on GitHub Pages.
//
// It also answers POST /unlock: the page sends the access code, and gets the
// backend token back if the code is right. That is the whole reason a shared
// link is safe to share -- see src/token.js.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { ensureToken, ensureAccessCode, readAccessCode, accessCodeMatches } from "./token.js";
import { loadTCPSocket, CONNECT_TIMEOUT } from "./tcp.js";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const PORT = parseInt(process.env.PORT || "8080", 10);
const { token: WISP_TOKEN, created: TOKEN_IS_NEW } = ensureToken();
const { code: ACCESS_CODE_AT_START, created: CODE_IS_NEW } = ensureAccessCode();

logging.set_level(logging.WARN);
// WISP_DNS=1.1.1.1,1.0.0.1 sends lookups to those servers instead of the
// system resolver. Worth trying if pages stall: a router or ISP resolver that
// answers blocked ad domains with an unroutable address (rather than NXDOMAIN)
// makes every such subresource hang until the connect times out. Off by
// default, because a network that blocks outbound DNS would break entirely.
const dnsServers = (process.env.WISP_DNS || "").split(",").map((s) => s.trim()).filter(Boolean);

Object.assign(wisp.options, {
  allow_udp_streams: false,
  // Note: dns_servers is only read when dns_method is "resolve". Setting it
  // alongside the default "lookup" does nothing, which is how it used to be.
  ...(dnsServers.length ? { dns_method: "resolve", dns_servers: dnsServers } : {}),
  // Prefer A records: an AAAA on a machine with no working IPv6 route is a
  // guaranteed connect timeout with nothing to fall back to.
  dns_result_order: "ipv4first",
});

// Replaces the stock socket with one that gives up on a dead address in
// CONNECT_TIMEOUT rather than the OS default, and tries every address for a
// host instead of only the first. Null if the library's internals moved, in
// which case wisp uses its own and everything still works.
const TCPSocket = await loadTCPSocket(logging);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// --- the access-code gate --------------------------------------------------
//
// A wrong code costs a second, and a burst of them costs everyone a pause: the
// code is short enough to be said aloud, so it has to be too slow to guess.
// Global rather than per-address because behind a tunnel every visitor arrives
// from the tunnel's own addresses, so per-address limits would be no limit.
const WRONG_DELAY = 1000;
const BURST_LIMIT = 8;
const BURST_WINDOW = 60_000;
const BURST_PAUSE = 30_000;
let wrongAttempts = [];
let pausedUntil = 0;

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function unlock(req, res) {
  const now = Date.now();
  if (now < pausedUntil) {
    json(res, 429, { error: "Too many wrong codes. Try again in a bit." });
    return;
  }

  let given = "";
  try {
    const body = await readBody(req);
    given = String(JSON.parse(body || "{}").code || "");
  } catch {
    json(res, 400, { error: "Send { \"code\": \"...\" }." });
    return;
  }

  // Read fresh each time, so a code changed from the setup menu applies without
  // a restart -- the token still needs one, this does not.
  const expected = readAccessCode();
  if (expected && accessCodeMatches(given, expected)) {
    wrongAttempts = [];
    json(res, 200, { token: WISP_TOKEN });
    return;
  }

  wrongAttempts = wrongAttempts.filter((t) => now - t < BURST_WINDOW);
  wrongAttempts.push(now);
  if (wrongAttempts.length >= BURST_LIMIT) {
    pausedUntil = now + BURST_PAUSE;
    wrongAttempts = [];
  }
  await new Promise((r) => setTimeout(r, WRONG_DELAY));
  json(res, 401, { error: "Wrong access code." });
}

const server = createServer(async (req, res) => {
  // The frontend may be served from a different origin (github.io) than this
  // backend, so allow it to read anything static we hand out, and to POST the
  // access code. The preflight is what a cross-origin JSON POST triggers.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }

  if (path === "/unlock") {
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    await unlock(req, res);
    return;
  }

  if (path.endsWith("/")) path += "index.html";

  // Reject traversal outside public/. resolve() drops the trailing separator,
  // which normalize() keeps -- comparing against that rejected every path.
  const root = resolve(publicPath);
  const full = resolve(join(root, path));
  if (full !== root && !full.startsWith(root + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(full);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
      // Service workers must be allowed to control the whole path.
      "Service-Worker-Allowed": "/",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("404");
  }
});

/** Constant-time string compare, so the token cannot be guessed a byte at a time. */
function tokenMatches(given) {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(WISP_TOKEN, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

server.on("upgrade", (req, socket, head) => {
  // The socket is the part that opens connections to target sites, so it is
  // the part that has to be gated: /wisp/<token>/ and nothing else. Anything
  // shorter is refused, including the bare /wisp/ that used to work.
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    path = "";
  }

  const offered = /^\/wisp\/([^/]+)\/?$/.exec(path);
  if (!offered || !tokenMatches(offered[1])) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }

  // wisp-js labels the connection with the request path and logs it, and it
  // wants a trailing slash. Hand it the plain prefix so the token stays out
  // of proxy.log.
  req.url = "/wisp/";
  wisp.routeRequest(req, socket, head, TCPSocket ? { TCPSocket } : {});
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`frontend  http://localhost:${PORT}`);
  console.log(`wisp      ws://localhost:${PORT}/wisp/${WISP_TOKEN}/`);
  console.log(`access    ${ACCESS_CODE_AT_START}`);
  if (TOKEN_IS_NEW) {
    console.log("\nA backend token was generated and saved to .wisp-token.");
  }
  if (CODE_IS_NEW) {
    console.log("An access code was generated and saved to .access-code -- that is what you give people.");
  }
});
