// Paths here are relative to this file, NOT to the site root. That matters
// because GitHub Pages serves project sites from /<repo>/ rather than /.
importScripts("m/e1/e1.js");

// Both rewriters live in this one worker, so switching engines in the UI does
// not mean registering and unregistering workers. They share the scope and are
// told apart by URL prefix.
importScripts("m/e2/e2.js");
importScripts("cfg.js");
importScripts("m/e2/e2w.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const ultraviolet = new UVServiceWorker();

// Both engines render a failure page carrying the full stack, the proxied URL,
// their build number and the backend's hostname. They share the same marker id
// (Scramjet double-quotes it, Ultraviolet single-quotes it); recognise either
// and swap it for something that says nothing.
const ENGINE_ERROR_MARKER = /id=['"]errorTitle/;

/** The site that was being loaded, dug back out of the proxied URL. */
function targetHost(proxiedUrl) {
  const decoders = [
    ["/m/p1/", (part) => decodeURIComponent(part)],
    ["/m/p2/", (part) => __uv$config.decodeUrl(part)],
  ];

  for (const [marker, decode] of decoders) {
    const at = proxiedUrl.indexOf(marker);
    if (at === -1) continue;
    try {
      return new URL(decode(proxiedUrl.slice(at + marker.length))).host;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A failure page with no diagnostics on it. The original page is carried along
 * in the markup and swapped in if the pass phrase is typed, so nothing is lost
 * -- it just isn't on screen for whoever is looking over your shoulder.
 */
function errorPage(originalHtml, host) {
  // Escaping "<" keeps the embedded copy from closing this script tag early.
  const details = JSON.stringify(originalHtml).replace(/</g, "\\u003c");
  const what = host ? `<b>${host}</b>` : "That page";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Didn't load</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex; align-items: center; justify-content: center;
        padding: 2rem 1.5rem;
        background: #0f1115;
        color: #e6e8ee;
        font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        text-align: center;
      }
      .card { max-width: 34rem; }
      h1 {
        margin: 0 0 0.6rem;
        font-size: clamp(1.6rem, 5vw, 2.1rem);
        font-weight: 650;
        letter-spacing: -0.03em;
      }
      p { margin: 0; color: #9aa3b2; font-size: 0.95rem; }
      b { color: #e6e8ee; font-weight: 600; }
      button {
        margin-top: 1.6rem;
        padding: 0.6rem 1.4rem;
        border: 0; border-radius: 10px;
        background: #5b8cff; color: #0c1020;
        font: 600 0.92rem system-ui, sans-serif;
        cursor: pointer;
      }
      button:hover { filter: brightness(1.08); }
    </style>
  </head>
  <body data-ikonic-error>
    <div class="card">
      <h1>That didn't load</h1>
      <p>${what} never came back. Could be the site, could be the connection, could be your spelling.</p>
      <button type="button" id="retry">Try again</button>
    </div>
    <script>
      document.getElementById("retry").addEventListener("click", () => {
        // Let the app re-navigate (spinner, no blank reload); reload as fallback.
        try { parent.postMessage({ ikonic: "retry" }, "*"); } catch (e) {}
        setTimeout(() => location.reload(), 500);
      });

      // Type the pass phrase anywhere on this page to bring back the full
      // technical report, stack trace and all.
      const DETAILS = ${details};
      let typed = "";
      addEventListener("keydown", (event) => {
        if (event.key.length !== 1) return;
        typed = (typed + event.key.toLowerCase()).slice(-8);
        if (!typed.endsWith("rich")) return;
        document.open();
        document.write(DETAILS);
        document.close();
      });
    <\/script>
  </body>
</html>`;
}

function masked(details, event) {
  return new Response(errorPage(String(details), targetHost(event.request.url)), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleRequest(event) {
  // Route to whichever engine owns this request; fall through to the network
  // if neither does. A thrown failure is masked immediately.
  let response;
  if (ultraviolet.route(event)) {
    try {
      response = await ultraviolet.fetch(event);
    } catch (err) {
      return masked((err && err.stack) || err, event);
    }
  } else {
    await scramjet.loadConfig();
    if (!scramjet.route(event)) return fetch(event.request);
    try {
      response = await scramjet.fetch(event);
    } catch (err) {
      return masked((err && err.stack) || err, event);
    }
  }

  // Both engines render their diagnostics as a 500 of HTML. Catch either one
  // and swap it for the page that says nothing; leave everything else alone,
  // including a genuine 500 from the site itself.
  const type = response.headers.get("content-type") || "";
  if (response.status !== 500 || !type.includes("text/html")) {
    return response;
  }

  const html = await response.text();
  if (!ENGINE_ERROR_MARKER.test(html)) {
    return new Response(html, response);
  }
  return masked(html, event);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});

// Without these two, an edited worker sits in "waiting" until every tab using
// the old one is closed -- which is why changes here appear not to happen.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
