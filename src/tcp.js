// A TCP socket for wisp that gives up on an unreachable address instead of
// sitting on it for the OS connect timeout (~21s on Windows).
//
// wisp-js resolves a hostname to ONE address and calls socket.connect() on it
// with no timeout and no second attempt, so a single dead address stalls that
// subresource for the full 21 seconds -- and a page waiting on it looks like
// the proxy is slow. proxy.log is full of "connect ETIMEDOUT" at exactly 21.0s.
//
// This resolves every address for the host, races them, and takes the first
// one to answer -- the same shape as the browser's own Happy Eyeballs. If none
// answer within WISP_CONNECT_TIMEOUT the stream fails in seconds rather than
// tens of seconds, and the caller can move on.
import { Resolver } from "node:dns/promises";
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

// wisp-js does not export this from its package entrypoints, so it is loaded
// by path. If that ever stops resolving we fall back to the stock socket --
// slower on dead hosts, but working.
const NET_MJS = new URL("../node_modules/@mercuryworkshop/wisp-js/src/server/net.mjs", import.meta.url);

export const CONNECT_TIMEOUT = parseInt(process.env.WISP_CONNECT_TIMEOUT || "5000", 10);

// A page pulls the same blocked ad host a dozen times. Once one attempt has
// established that nothing is listening, the rest should not each spend
// CONNECT_TIMEOUT rediscovering it -- so a failure is remembered briefly and
// replayed instantly. Short, because a host that is merely down should be
// retried soon rather than written off for the session.
const NEGATIVE_TTL = parseInt(process.env.WISP_FAIL_TTL || "30000", 10);
const recentFailures = new Map();

function recentlyFailed(key) {
  const until = recentFailures.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  recentFailures.delete(key);
  return false;
}

/**
 * Every address for a host. Follows whichever resolver wisp itself is
 * configured to use, so the address this connects to is one the hostname
 * filter has already vetted -- resolving differently here would let a name
 * pass the filter as public and then connect somewhere private.
 */
async function addressesFor(hostname) {
  // A literal IP has nothing to resolve.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return [hostname];

  if (wisp.options.dns_method === "resolve" && wisp.options.dns_servers?.length) {
    const resolver = new Resolver();
    resolver.setServers(wisp.options.dns_servers);
    const found = (await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]))
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (found.length) return found;
  }

  const all = await lookup(hostname, { all: true });
  return all.map((a) => a.address);
}

/**
 * Connects to whichever address answers first. Losers are torn down. Rejects
 * once every address has failed or the timeout expires, whichever comes first.
 */
function raceConnect(addresses, port, timeout) {
  return new Promise((resolve, reject) => {
    const sockets = [];
    let settled = false;
    let failures = 0;

    const finish = (winner, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of sockets) if (s !== winner) s.destroy();
      winner ? resolve(winner) : reject(error);
    };

    const tried = addresses.join(", ");
    const timer = setTimeout(
      () => finish(null, new Error(`nothing answered on :${port} within ${timeout}ms (tried ${tried})`)),
      timeout,
    );

    for (const address of addresses) {
      const socket = createConnection({ host: address, port });
      sockets.push(socket);
      socket.once("connect", () => finish(socket));
      socket.once("error", () => {
        // Only give up early once every candidate has failed; otherwise a fast
        // refusal on one address would cancel a slower address still dialling.
        if (++failures === addresses.length) finish(null, new Error(`no address accepted :${port} (tried ${tried})`));
      });
    }
  });
}

/**
 * Subclasses wisp's own socket and replaces connect(). Everything else --
 * recv, send, close, the flow-control pause/resume -- is inherited, so this
 * stays in step with the library.
 */
export async function loadTCPSocket(logging) {
  let NodeTCPSocket;
  try {
    ({ NodeTCPSocket } = await import(pathToFileURL(fileURLToPath(NET_MJS)).href));
  } catch (err) {
    logging?.warn?.(`connect-timeout socket unavailable (${err.code || err.message}); using the stock one`);
    return null;
  }

  return class TimeoutTCPSocket extends NodeTCPSocket {
    async connect() {
      const started = Date.now();
      const key = `${this.hostname}:${this.port}`;
      if (recentlyFailed(key)) throw new Error(`${key} failed moments ago, not retrying yet`);

      const addresses = await addressesFor(this.hostname);
      let socket;
      try {
        socket = await raceConnect(addresses, this.port, CONNECT_TIMEOUT);
      } catch (err) {
        recentFailures.set(key, Date.now() + NEGATIVE_TTL);
        throw err;
      }
      recentFailures.delete(key);

      const elapsed = Date.now() - started;
      if (elapsed > 1000) logging?.warn?.(`slow connect: ${this.hostname}:${this.port} took ${elapsed}ms`);

      socket.setNoDelay(true);
      socket.on("data", (data) => this.data_queue.put(data));
      socket.on("close", () => {
        this.data_queue.close();
        this.socket = null;
      });
      socket.on("error", (error) => logging?.warn?.(`tcp stream to ${this.hostname} ended with error - ${error}`));
      socket.on("end", () => {
        if (!this.socket) return;
        this.socket.destroy();
        this.socket = null;
      });

      this.socket = socket;
      this.connected = true;
    }
  };
}
