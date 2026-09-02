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
// Scramjet 2 is installed under an alias so that it and v1 can both be on
// disk: the engine picker offers each of them, and one is not a drop-in
// replacement for the other. Its controller -- the half that talks to the
// service worker -- is a separate package in v2.
const { scramjetPath: scramjet2Path } = require("scramjet2/path");
const controller2Path = dirname(require.resolve("@mercuryworkshop/scramjet-controller"));
// Scramjet 2 needs libcurl 2, which is not what the other two engines run on,
// so it is aliased in beside the older one rather than replacing it. Resolved
// rather than imported: its entry point throws outside a browser.
const libcurl2Path = dirname(require.resolve("libcurl2"));
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
  {
    // Scramjet 2's core. Only the IIFE build and the wasm are wanted: the ESM
    // twin and the wasm-inlined bundle are another 2.7 MB that nothing loads,
    // and the service worker cannot importScripts an ES module anyway.
    dest: "m/e3",
    src: scramjet2Path,
    filter: (s) =>
      !s.endsWith(".mjs") && !basename(s).startsWith("scramjet_bundled") && !s.includes("temp-types-build"),
    rename: {
      "scramjet.js": "e3.js",
      "scramjet.wasm": "e3.wasm",
    },
  },
  {
    // Scramjet 2's controller: the page half (api), the service worker half
    // (sw), and the script injected into each proxied frame (inject).
    dest: "m/c3",
    src: controller2Path,
    filter: (s) => !basename(s).startsWith("controller-external"),
    rename: {
      "controller.api.js": "c3a.js",
      "controller.sw.js": "c3w.js",
      "controller.inject.js": "c3i.js",
    },
  },
  { dest: "m/mx", src: baremuxPath },
  { dest: "m/t1", src: libcurlPath },
  // Only the ESM bundle, as with epoxy below.
  { dest: "m/t3", src: libcurl2Path, filter: (s) => !s.endsWith("index.js") },
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
