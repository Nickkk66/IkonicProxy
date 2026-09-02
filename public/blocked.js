// Hosts that exist only to serve adverts, analytics or tracking.
//
// Blocking them is not a matter of taste here, it is a matter of the proxy
// working at all. On a filtered connection these hosts do not refuse the
// connection, they swallow it: nothing ever answers, so every request to one
// costs the full connect timeout and holds a wisp stream open for five seconds
// while it waits. That alone would only be slow. What breaks pages is what the
// site does in the meantime -- an advert SDK still waiting on its advert keeps
// the rest of the page waiting with it, and the page never draws.
//
// Refusing them outright, the way an ad blocker does, puts a site straight onto
// the error path it already has and it carries on.
//
// Loaded three times over, which is why it lives at the site root and hangs
// everything off `self`: by the page (as a <script>), by the service worker
// (via importScripts), and through the page by the transport wrapper that
// Scramjet 2 needs -- version 2 fetches a page's subresources itself rather
// than through the worker, so a list that only the worker consulted would let
// every one of them through.
(() => {
  const self_ = typeof self !== "undefined" ? self : globalThis;

  const BLOCKED_HOSTS = [
    // Google's advertising and measurement stack.
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagservices.com",
    "googletagmanager.com",
    "google-analytics.com",
    "analytics.google.com",
    "adservice.google.com",
    "2mdn.net",
    // The IMA advert SDK. Worth spelling out why a *library* is on this list:
    // a site asks it whether an advert is available and waits for the answer.
    // Reachable but unable to fetch an advert, it never answers, and the site
    // waits for it forever behind a popup it has already hidden -- which is
    // precisely the black screen higherlowergame shows after a wrong answer.
    // Unreachable, the site skips the advert and carries straight on, which is
    // what it does off the proxy and what it should do on it.
    "imasdk.googleapis.com",
    // Exchanges and ad networks.
    "adnxs.com",
    "adsafeprotected.com",
    "adsrvr.org",
    "amazon-adsystem.com",
    "casalemedia.com",
    "criteo.com",
    "criteo.net",
    "moatads.com",
    "openx.net",
    "outbrain.com",
    "pubmatic.com",
    "rubiconproject.com",
    "smartadserver.com",
    "taboola.com",
    // Analytics, A/B testing and session recording.
    "clarity.ms",
    "fullstory.com",
    "hotjar.com",
    "mixpanel.com",
    "nr-data.net",
    "quantserve.com",
    "scorecardresearch.com",
    "segment.io",
    "visualwebsiteoptimizer.com",
  ];

  /** True for a blocked host and for anything under it. */
  self_.isBlockedHost = function isBlockedHost(hostname) {
    if (!hostname) return false;
    return BLOCKED_HOSTS.some((domain) => hostname === domain || hostname.endsWith("." + domain));
  };
})();
