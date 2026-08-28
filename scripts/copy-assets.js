// Copies the browser-side assets out of node_modules and into public/ so that
// a static host (GitHub Pages) can serve them. Run via: npm run assets
//
// Everything lands under public/m/ with neutral names rather than
// scram/scramjet.all.js, uv/uv.bundle.js and so on. Those names are what a
// content-inspecting web filter matches on, and none of them need to be
// recognisable for the proxy to work -- our own code references them by the
// paths set here. (The minified bundle *bodies* still contain their original
// identifiers; renaming the files does not touch those.)
import { cp, rm, mkdir, rename } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { libcurlPath } = require("@mercuryworkshop/libcurl-transport");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
// epoxy publishes no path helper, so locate its dist through the entry point.
const epoxyPath = dirname(require.resolve("@mercuryworkshop/epoxy-transport"));
const { uvPath } = require("@titaniumnetwork-dev/ultraviolet");

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Source maps and .d.ts files are dev-only and would bloat the repo.
const base = (src) =>
  !src.endsWith(".map") && !src.endsWith(".d.ts") && !src.includes("dist\\types") && !src.includes("dist/types");

// dest    -- directory under public/ to copy into
// src     -- node_modules source directory
// filter  -- extra per-file predicate on top of `base`
// rename  -- { originalBasename: newBasename } applied after the copy
const targets = [
  {
    dest: "m/e1",
    src: scramjetPath,
    filter: (s) => basename(s) !== "scramjet.bundle.js",
    rename: {
      "scramjet.all.js": "e1.js",
      "scramjet.sync.js": "e1s.js",
      "scramjet.wasm.wasm": "e1.wasm",
    },
  },
  { dest: "m/mx", src: baremuxPath },
  { dest: "m/t1", src: libcurlPath },
  // Only the ESM bundle: the CommonJS twin is another 1.7 MB nobody loads.
  { dest: "m/t2", src: epoxyPath, filter: (s) => !s.endsWith("index.js") && !s.endsWith(".cjs") },
  {
    dest: "m/e2",
    src: uvPath,
    // uv.config.js and the stock sw.js are replaced by ours (cfg.js, sw.js).
    filter: (s) => !["uv.config.js", "sw.js"].includes(basename(s)),
    rename: {
      "uv.bundle.js": "e2.js",
      "uv.sw.js": "e2w.js",
      "uv.handler.js": "e2h.js",
      "uv.client.js": "e2c.js",
    },
  },
];

// Wipe the whole tree so a previous run's differently-named files -- which
// would themselves be a fingerprint -- do not linger.
await rm(publicPath + "m", { recursive: true, force: true });

for (const { dest, src, filter, rename: renames } of targets) {
  const destPath = publicPath + dest;
  await mkdir(destPath, { recursive: true });
  await cp(src, destPath, { recursive: true, filter: (s) => base(s) && (!filter || filter(s)) });

  for (const [from, to] of Object.entries(renames || {})) {
    await rename(destPath + "/" + from, destPath + "/" + to).catch(() => {});
  }
  console.log(`copied ${dest}/  <- ${src}`);
}
console.log("assets ready in public/m/");
