// Paths here are relative to this file, NOT to the site root. That matters
// because GitHub Pages serves project sites from /<repo>/ rather than /.
importScripts("m/e1/e1.js");

// Both rewriters live in this one worker, so switching engines in the UI does
// not mean registering and unregistering workers. They share the scope and are
// told apart by URL prefix.
importScripts("m/e2/e2.js");
importScripts("cfg.js");
importScripts("m/e2/e2w.js");

// Scramjet 2's service worker half. Unlike the other two it is not handed a
// bundle here: the page's controller ships it the engine and the settings over
// a message port once it connects, so all this file needs is the router.
importScripts("m/c3/c3w.js");

// The advert and tracker list, shared with the page -- see blocked.js for why
// it has to be in both places.
importScripts("blocked.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const ultraviolet = new UVServiceWorker();

// Both engines render a failure page carrying the full stack, the proxied URL,
// their build number and the backend's hostname. They share the same marker id
// (Scramjet double-quotes it, Ultraviolet single-quotes it); recognise either
// and swap it for something that says nothing.
const ENGINE_ERROR_MARKER = /id=['"]errorTitle/;

/** The site that was being loaded, dug back out of the proxied URL. */
function targetUrl(proxiedUrl) {
  const decoders = [
    ["/m/p1/", (part) => decodeURIComponent(part)],
    ["/m/p2/", (part) => __uv$config.decodeUrl(part)],
    // Scramjet 2 writes <controller id>/<frame id>/<address>, and does not
    // encode the address, so the two ids are what has to be stripped.
    ["/m/p3/", (part) => part.split("/").slice(2).join("/")],
  ];

  for (const [marker, decode] of decoders) {
    const at = proxiedUrl.indexOf(marker);
    if (at === -1) continue;
    try {
      return new URL(decode(proxiedUrl.slice(at + marker.length)));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whether a failed request should be answered with the failure page.
 *
 * Only a whole page gets one. A subresource has to fail the way the network
 * fails, because a network failure is the only thing sites are written to
 * handle: hand back a 500 carrying HTML instead of a script or an image and
 * the browser sees a response, so fetch() resolves, onerror never fires, and
 * the site's own fallback never runs. That is the difference between a site
 * shrugging off an advert it could not load and sitting on a black screen
 * waiting for one forever.
 */
function isNavigation(request) {
  return (
    request.mode === "navigate" ||
    request.destination === "document" ||
    request.destination === "iframe"
  );
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
  const target = targetUrl(event.request.url);
  return new Response(errorPage(String(details), target && target.host), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** The failure page for a page, a plain network error for anything else. */
function failed(details, event) {
  return isNavigation(event.request) ? masked(details, event) : Response.error();
}

async function handleRequest(event) {
  // Adverts and trackers never reach the transport. Checked before routing so
  // it costs one string compare rather than a five-second connect.
  const target = targetUrl(event.request.url);
  if (target && isBlockedHost(target.hostname)) return Response.error();

  // Route to whichever engine owns this request; fall through to the network
  // if neither does. A thrown failure is masked immediately.
  let response;
  if ($scramjetController.shouldRoute(event)) {
    // Scramjet 2 answers for itself -- it has its own error pages and its own
    // notion of what a failure looks like -- so only a throw is ours to dress.
    try {
      return await $scramjetController.route(event);
    } catch (err) {
      return failed((err && err.stack) || err, event);
    }
  } else if (ultraviolet.route(event)) {
    try {
      response = await ultraviolet.fetch(event);
    } catch (err) {
      return failed((err && err.stack) || err, event);
    }
  } else {
    await scramjet.loadConfig();
    if (!scramjet.route(event)) return fetch(event.request);
    try {
      response = await scramjet.fetch(event);
    } catch (err) {
      return failed((err && err.stack) || err, event);
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
  return failed(html, event);
}

self.addEventListener("fetch", (event) => {
  // The page pings this while a site is open, purely so the browser keeps
  // this worker alive -- see the keepalive in app.js for why that matters.
  if (event.request.url.indexOf("/keepalive") !== -1 && event.request.mode !== "navigate") {
    event.respondWith(new Response(null, { status: 204 }));
    return;
  }
  event.respondWith(handleRequest(event));
});

// Without these two, an edited worker sits in "waiting" until every tab using
// the old one is closed -- which is why changes here appear not to happen.
//
// Both have to be held open with waitUntil. skipWaiting() returns a promise,
// and calling it bare lets install finish first, at which point the worker is
// already parked in "waiting" and the call has nothing left to skip -- so an
// edited worker still would not take over until every tab was closed, which is
// the exact failure these two lines are here to prevent.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
