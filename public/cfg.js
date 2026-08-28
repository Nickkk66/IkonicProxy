/*global Ultraviolet*/
// Ultraviolet's own uv.config.js hardcodes root-absolute paths and recognisable
// names. This replaces it: it sits at the site root, works out the base
// directory at load time (so /<repo>/ project sites work), and points at the
// renamed assets under m/.
//
// Loaded twice: by the page (as a <script>) and by the service worker (via
// importScripts). Kept at the root -- not under m/ -- so `new URL("./", here)`
// resolves to the site base in both worlds.
(() => {
  const self_ = typeof self !== "undefined" ? self : globalThis;
  const here =
    typeof document !== "undefined" && document.currentScript
      ? document.currentScript.src
      : self_.location.href;
  const base = new URL("./", here).pathname;

  self_.__uv$config = {
    // Must sit inside the service worker's scope, same as the other prefix.
    prefix: base + "m/p2/",
    encodeUrl: Ultraviolet.codec.xor.encode,
    decodeUrl: Ultraviolet.codec.xor.decode,
    handler: base + "m/e2/e2h.js",
    client: base + "m/e2/e2c.js",
    bundle: base + "m/e2/e2.js",
    config: base + "cfg.js",
    sw: base + "m/e2/e2w.js",
  };
})();
