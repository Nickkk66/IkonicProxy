// The two secrets that stand between a shared link and an open relay.
//
// The backend token gates the wisp websocket itself: /wisp/<token>/ or
// nothing. Without it the tunnel address is an open relay -- anyone who turns
// up the hostname can route arbitrary traffic through this PC, under this IP.
//
// The access code gates the token. The token used to be written into the page
// the backend served, which meant the link alone was enough to use the proxy:
// whoever had it had the secret too, and rotating the tunnel address only
// helped until someone passed the new one on. Now the page asks for a code,
// sends it to the backend, and only then gets the token back. A link on its
// own is worth nothing; the code is what you hand to people, and it can be
// changed without the address moving.
//
// Both live in gitignored files so the server and the setup script agree on
// them across restarts. Environment variables win, for hosts that would rather
// not keep secrets on disk.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TOKEN_FILE = fileURLToPath(new URL("../.wisp-token", import.meta.url));
export const ACCESS_FILE = fileURLToPath(new URL("../.access-code", import.meta.url));

function readSecret(envName, file) {
  const fromEnv = (process.env[envName] || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The configured token, or null if there is not one yet. */
export function readToken() {
  return readSecret("WISP_TOKEN", TOKEN_FILE);
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

/** The configured access code, or null if there is not one yet. */
export function readAccessCode() {
  return readSecret("ACCESS_CODE", ACCESS_FILE);
}

/**
 * Makes a code people can actually pass on by voice or by text: two short
 * words and a number, like "amber-fox-42". Roughly 2^24 possibilities, which
 * against a throttled endpoint is plenty; the token behind it is the real key.
 */
export function generateAccessCode() {
  const words = [
    "amber", "birch", "cedar", "delta", "ember", "flint", "grove", "harbor", "indigo", "juniper",
    "kestrel", "lumen", "maple", "nova", "onyx", "pearl", "quartz", "river", "slate", "tundra",
    "umber", "violet", "willow", "zephyr", "falcon", "otter", "lynx", "heron", "ferret", "puffin",
  ];
  const pick = () => words[randomBytes(1)[0] % words.length];
  const number = 10 + (randomBytes(1)[0] % 90);
  return `${pick()}-${pick()}-${number}`;
}

/** Saves a code chosen by the owner (or a generated one). */
export function setAccessCode(code) {
  writeFileSync(ACCESS_FILE, code.trim() + "\n", { mode: 0o600 });
}

/** The configured access code, generating and saving one on first run. */
export function ensureAccessCode() {
  const existing = readAccessCode();
  if (existing) return { code: existing, created: false };
  const code = generateAccessCode();
  setAccessCode(code);
  return { code, created: true };
}

/**
 * Constant-time comparison, so a wrong code takes exactly as long to refuse as
 * a nearly-right one. Case and surrounding whitespace are forgiven: the code is
 * meant to be typed from memory.
 */
export function accessCodeMatches(given, expected) {
  const a = Buffer.from(String(given || "").trim().toLowerCase(), "utf8");
  const b = Buffer.from(String(expected || "").trim().toLowerCase(), "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
