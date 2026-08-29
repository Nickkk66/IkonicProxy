// The shared secret that gates the wisp websocket.
//
// Without it the tunnel address is an open relay: anyone who turns up the
// hostname can route arbitrary traffic through this PC, under this IP. The
// token moves the gate onto the socket itself -- /wisp/<token>/ or nothing --
// which makes the backend address a credential rather than just an address.
//
// It lives in .wisp-token (gitignored) so the server and the setup script
// agree on it across restarts. WISP_TOKEN in the environment wins, for hosts
// that would rather not keep it on disk.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TOKEN_FILE = fileURLToPath(new URL("../.wisp-token", import.meta.url));

/** The configured token, or null if there is not one yet. */
export function readToken() {
  const fromEnv = (process.env.WISP_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * The configured token, minting and saving one on first run so a fresh clone
 * comes up closed rather than open. Returns { token, created } -- callers use
 * `created` to tell the owner that the backend address just changed.
 */
export function ensureToken() {
  const existing = readToken();
  if (existing) return { token: existing, created: false };

  // base64url: safe in a URL path with no escaping, 192 bits of entropy.
  const token = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return { token, created: true };
}
