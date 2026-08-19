// Copies the browser-side assets out of node_modules and into public/ so that
// a static host (GitHub Pages) can serve them. Run via: npm run assets
import { cp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { libcurlPath } = require("@mercuryworkshop/libcurl-transport");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Source maps and .d.ts files are dev-only and would bloat the repo.
const filter = (src) =>
  !src.endsWith(".map") && !src.endsWith(".d.ts") && !src.includes("dist\types") && !src.includes("dist/types");

const targets = [
  ["scram", scramjetPath],
  ["libcurl", libcurlPath],
  ["baremux", baremuxPath],
];

for (const [name, src] of targets) {
  const dest = publicPath + name;
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true, filter });
  console.log(`copied ${name}/  <- ${src}`);
}
console.log("assets ready in public/");
