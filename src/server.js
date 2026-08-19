// Wisp backend + static file server.
//
// On your home PC this process does two jobs:
//   1. serves public/ for local testing at http://localhost:8080
//   2. terminates the wisp websocket at /wisp/ -- this is the part that
//      actually opens sockets to target sites, and the only part that MUST
//      run on your machine once the frontend lives on GitHub Pages.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const PORT = parseInt(process.env.PORT || "8080", 10);

logging.set_level(logging.WARN);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.1", "1.0.0.1"],
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
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

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`frontend  http://localhost:${PORT}`);
  console.log(`wisp      ws://localhost:${PORT}/wisp/`);
});
