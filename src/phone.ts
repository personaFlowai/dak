/* Dak on the person's phone. A Cloudflare quick tunnel (no account) gives this Mac one HTTPS
   address; the phone signs in once with a long key and keeps it as a cookie. Everything else
   that arrives through the tunnel without that key is refused.

   The tunnel runs as its own process, apart from Dak's server, so a Dak update or restart
   does not change the address the phone has saved. It changes only when the tunnel itself
   restarts (a reboot, a network change), and Settings then shows a new code to scan.
   "Sign out phone" makes a new key, so the old cookie stops working at once. */
import { existsSync, readFileSync, writeFileSync, chmodSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { dakHome } from "./config";
import { DakError } from "./types";

const keyPath = () => join(dakHome(), "phone-key");
const statePath = () => join(dakHome(), "phone.json");
const logPath = () => join(dakHome(), "phone-tunnel.log");

interface State { pid: number; url: string | null; started_at: string }

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function phoneKey(rotate = false): string {
  if (!rotate && existsSync(keyPath())) return readFileSync(keyPath(), "utf8").trim();
  const k = `dakp_${randomBytes(24).toString("hex")}`;
  writeFileSync(keyPath(), k);
  chmodSync(keyPath(), 0o600);
  return k;
}

export function isPhoneKey(k: string | null | undefined): boolean {
  if (!k || !existsSync(keyPath())) return false;
  const a = Buffer.from(k), b = Buffer.from(phoneKey());
  return a.length === b.length && timingSafeEqual(a, b);
}

function readState(): State | null {
  try { const s = JSON.parse(readFileSync(statePath(), "utf8")) as State; return alive(s.pid) ? s : null; } catch { return null; }
}

// The address, read from the tunnel's log when it has printed it and registered.
function urlFromLog(): string | null {
  try {
    const log = readFileSync(logPath(), "utf8");
    if (!/Registered tunnel connection/.test(log)) return null;
    return log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
  } catch { return null; }
}

export function phoneStatus() {
  const s = readState();
  if (!s) return { open: false as const };
  const url = s.url ?? urlFromLog();
  if (url && !s.url) writeFileSync(statePath(), JSON.stringify({ ...s, url }));
  return { open: true as const, url, link: url ? `${url}/m?k=${phoneKey()}` : null };
}

export const phoneHost = (): string | null => { const u = phoneStatus() as any; return u.url ? new URL(u.url).host : null; };

export async function openPhone(port: number) {
  if (readState()) return phoneStatus();
  phoneKey();
  if (existsSync(logPath())) unlinkSync(logPath());
  const out = openSync(logPath(), "a");
  // Its own process group (detached), so quitting or updating Dak does not take it down and
  // the address saved on the phone keeps working.
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { detached: true, stdio: ["ignore", out, out] });
  } catch { throw new DakError("no_tunnel_tool", "cloudflared is not installed: brew install cloudflared", 502); }
  if (!proc.pid) throw new DakError("no_tunnel_tool", "cloudflared is not installed: brew install cloudflared", 502);
  proc.unref();
  writeFileSync(statePath(), JSON.stringify({ pid: proc.pid, url: null, started_at: new Date().toISOString() }));
  for (let i = 0; i < 120 && !urlFromLog() && alive(proc.pid!); i++) await Bun.sleep(250);
  if (!urlFromLog()) { closePhone(); throw new DakError("tunnel_failed", "The tunnel did not come up within 30 seconds.", 502); }
  await Bun.sleep(3000); // let Cloudflare's DNS catch up before the phone asks for the address
  return phoneStatus();
}

export function closePhone(signOut = false) {
  const s = readState();
  if (s) { try { process.kill(s.pid); } catch { /* gone */ } }
  try { unlinkSync(statePath()); } catch { /* none */ }
  if (signOut) phoneKey(true);
}

// What the phone may not do from outside: change how this Mac is set up, or read past the PR.
export function phoneMayNot(method: string, parts: string[]): boolean {
  if (["door", "phone", "wake"].includes(parts[0])) return true;
  if (parts[0] === "settings" && method !== "GET") return true;
  if (parts[0] === "connect" || parts[0] === "login") return true;
  // Code hopping reads any file in the checkout, not just the PR: it stays on the Mac.
  if (parts[0] === "lookup") return true;
  return false;
}

export function cookieKey(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)dak_phone=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
