// Why is a page slow? Run this on the machine the backend runs on:
//   npm run doctor
//
// It does two things this repo could not otherwise know: it summarises what
// the backend has actually failed to reach, and it times DNS and TCP against
// those hosts from this machine right now. A page waits for its subresources,
// so a handful of hosts that never answer is enough to make a fast site feel
// like a 30-second one.
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const LOG = root + "proxy.log";
const PROBE_TIMEOUT = 25000;

function logSummary() {
  let text;
  try {
    text = readFileSync(LOG, "utf8");
  } catch {
    console.log(`No ${LOG} yet -- start the proxy and browse a little first.`);
    return [];
  }

  const failures = new Map();
  for (const m of text.matchAll(/tcp stream to (\S+) ended with error - Error: (\w+)/g)) {
    const entry = failures.get(m[1]) || { host: m[1], count: 0, kinds: new Set() };
    entry.count++;
    entry.kinds.add(m[2]);
    failures.set(m[1], entry);
  }

  const ranked = [...failures.values()].sort((a, b) => b.count - a.count);
  const total = ranked.reduce((sum, f) => sum + f.count, 0);
  console.log(`\n${total} failed connections in proxy.log, across ${ranked.length} hosts.`);
  if (!total) {
    console.log("Nothing has failed to connect -- the delay is somewhere else. See the note at the end.");
    return [];
  }
  console.log("\n  failures  host");
  for (const f of ranked.slice(0, 12)) {
    console.log(`  ${String(f.count).padStart(8)}  ${f.host}  (${[...f.kinds].join(", ")})`);
  }
  return ranked.slice(0, 8).map((f) => f.host);
}

const dial = (host, port) =>
  new Promise((resolve) => {
    const started = Date.now();
    const socket = createConnection({ host, port });
    const done = (result) => {
      resolve({ result, seconds: (Date.now() - started) / 1000 });
      socket.destroy();
    };
    socket.setTimeout(PROBE_TIMEOUT);
    socket.once("connect", () => done("ok"));
    socket.once("timeout", () => done("TIMED OUT"));
    socket.once("error", (err) => done(err.code || "error"));
  });

async function probe(hosts) {
  if (!hosts.length) return;
  console.log("\nTiming those hosts from this machine now:\n");
  const stalled = [];

  for (const host of hosts) {
    let addresses = [];
    const dnsStart = Date.now();
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
      console.log(`  ${host.padEnd(34)} DNS ${err.code}`);
      continue;
    }
    const dnsMs = Date.now() - dnsStart;
    const { result, seconds } = await dial(host, 443);
    if (result !== "ok") stalled.push({ host, seconds, addresses });
    console.log(
      `  ${host.padEnd(34)} dns ${String(dnsMs + "ms").padEnd(7)} connect ${result.padEnd(10)} ${seconds.toFixed(1)}s   ${addresses.join(" ")}`,
    );
  }

  console.log();
  if (!stalled.length) {
    console.log("Everything answers now. Those log entries were transient, or the network has changed");
    console.log("since. If pages are still slow, the delay is in the browser rather than out here --");
    console.log("open DevTools > Network on a slow load and look at what is actually waiting.");
    return;
  }

  const worst = Math.max(...stalled.map((s) => s.seconds));
  console.log(`${stalled.length} host(s) still do not answer, the slowest taking ${worst.toFixed(0)}s:`);
  for (const s of stalled) console.log(`  ${s.host} -> ${s.addresses.join(" ")}`);
  console.log("\nA page that pulls anything from those waits on them. Two common causes:");
  console.log("  - a router or ISP resolver that answers blocked ad domains with a dead address");
    console.log("    instead of NXDOMAIN. Test with:  WISP_DNS=1.1.1.1,1.0.0.1 npm start");
  console.log("  - the host genuinely blocking this IP.");
  console.log("\nThe backend caps each attempt at WISP_CONNECT_TIMEOUT (5s default) rather than the");
  console.log("~21s the OS would take, so these cost seconds now instead of tens of seconds.");
}

const hosts = logSummary();
await probe(hosts);
console.log("\nStill slow with nothing failing? The transport is the next suspect: libcurl opens a");
console.log("fresh connection per request. Switch it to epoxy in the settings panel and compare.");
