// Wisp backend + static file server.
//
// On your home PC this process does two jobs:
//   1. serves public/ for local testing at http://localhost:8080
//   2. terminates the wisp websocket at /wisp/ -- this is the part that
//      actually opens sockets to target sites, and the only part that MUST
//      run on your machine once the frontend lives on GitHub Pages.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { ensureToken } from "./token.js";
import { loadTCPSocket, CONNECT_TIMEOUT } from "./tcp.js";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const APP_JS = fileURLToPath(new URL("../public/app.js", import.meta.url));
const TOKEN_LINE = /const WISP_TOKEN = "[^"]*";/;
const PORT = parseInt(process.env.PORT || "8080", 10);
const { token: WISP_TOKEN, created: TOKEN_IS_NEW } = ensureToken();

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

const server = createServer(async (req, res) => {
  // The frontend is served from a different origin (github.io) than this
  // backend, so allow it to read anything static we hand out.
  res.setHeader("Access-Control-Allow-Origin", "*");

  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
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
    let body = await readFile(full);
    // app.js is committed to a public repo, so it ships with an empty
    // WISP_TOKEN and is given the real one here, on the way out. GitHub Pages
    // does the same from a repository secret -- see the Pages workflow. Either
    // way the token reaches the browser without ever entering git.
    if (full === APP_JS) {
      body = body.toString("utf8").replace(TOKEN_LINE, `const WISP_TOKEN = "${WISP_TOKEN}";`);
    }
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
  if (TOKEN_IS_NEW) {
    console.log("\nA backend token was generated and saved to .wisp-token.");
    console.log("The address above is now a credential -- treat it like a password.");
    console.log("Pages deploys need it as the WISP_TOKEN repository secret; pages.yml has the details.");
  }
});
