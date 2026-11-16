import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { dakHome } from "./config";
import { DakError } from "./types";

// A door for an agent that does not run on this Mac (Grok Bot's agent runs in a
// remote sandbox). A tunnel gives Dak one public HTTPS address, and the agent gets a
// key of its own that opens only the outside routes (/x/...) and only as itself:
// it can send to the person and read its own replies, nothing else. The master
// token never leaves this Mac, and every other route still refuses a non-local Host.

const keysPath = () => join(dakHome(), "agent-keys.json");

function readKeys(): Record<string, string> {
  try { return JSON.parse(readFileSync(keysPath(), "utf8")); } catch { return {}; }
}

export function agentKey(name: string, rotate = false): string {
  const keys = readKeys();
  if (!keys[name] || rotate) {
    keys[name] = `dak_${name}_${randomBytes(18).toString("hex")}`;
    writeFileSync(keysPath(), JSON.stringify(keys, null, 2));
    chmodSync(keysPath(), 0o600);
  }
  return keys[name];
}

export function agentForKey(key: string | null): string | null {
  if (!key) return null;
  const hit = Object.entries(readKeys()).find(([, k]) => k === key);
  return hit?.[0] ?? null;
}

export function revokeKey(name: string) {
  const keys = readKeys();
  delete keys[name];
  writeFileSync(keysPath(), JSON.stringify(keys, null, 2));
}

interface Door { agent: string; tool: "cloudflare" | "ngrok"; url: string | null; ready: boolean; proc: ReturnType<typeof Bun.spawn>; error?: string }
let door: Door | null = null;

export function doorStatus() {
  return door ? { open: true, agent: door.agent, tool: door.tool, url: door.url, error: door.error ?? null } : { open: false };
}

// Cloudflare's quick tunnel needs no account; its address changes on every start.
// ngrok uses the account it is already signed in to.
export async function openDoor(agent: string, port: number, tool: "cloudflare" | "ngrok" = "cloudflare") {
  if (door) closeDoor();
  agentKey(agent);
  const cmd = tool === "cloudflare"
    ? ["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`]
    : ["ngrok", "http", `127.0.0.1:${port}`, "--log", "stdout", "--log-format", "json"];
  let proc: ReturnType<typeof Bun.spawn>;
  try { proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" }); }
  catch { throw new DakError("no_tunnel_tool", `${cmd[0]} is not installed.`, 502); }
  door = { agent, tool, url: null, ready: tool === "ngrok", proc };
  const d = door;
  const want = tool === "cloudflare" ? /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ : /"url":"(https:\/\/[^"]+)"/;
  const read = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream as any) {
      const text = dec.decode(chunk);
      const m = text.match(want);
      if (m && !d.url) d.url = m[1] ?? m[0];
      // The address is printed before Cloudflare can route to it. Asking for it that
      // early caches a "no such host" on the asker's side, so wait for registration.
      if (/Registered tunnel connection/.test(text)) d.ready = true;
    }
  };
  read(proc.stdout as any); read(proc.stderr as any);
  proc.exited.then((code) => { if (door === d) { d.error = `The tunnel stopped (exit ${code}).`; } });
  for (let i = 0; i < 120 && !(d.url && d.ready) && !d.error; i++) await Bun.sleep(250);
  if (!d.url || !d.ready) d.error ??= "The tunnel did not come up within 30 seconds.";
  else await Bun.sleep(4000); // give Cloudflare's DNS a moment before anyone asks for the address
  return doorStatus();
}

export function closeDoor() {
  if (!door) return;
  try { door.proc.kill(); } catch { /* already gone */ }
  door = null;
}

export function instructionsFor(agent: string, url: string, key: string, person: string): string {
  return [
    `You can reach ${person}'s review inbox (Dak) over HTTPS. Use it to send ${person} messages and to read ${person}'s replies.`,
    `Base address: ${url}`,
    `Send this header on every call: Authorization: Bearer ${key}`,
    ``,
    `Send a message:   POST ${url}/x/send   JSON {"subject": "...", "body": "Markdown text", "link": "optional URL"}   returns {"thread": {"id": ...}}`,
    `Reply on a thread: POST ${url}/x/reply/<thread id>   JSON {"body": "..."}`,
    `Wait for a reply:  GET  ${url}/x/wait/<thread id>?timeout=50   returns {"messages": [...]} or {"timed_out": true}`,
    `Read new replies:  GET  ${url}/x/inbox`,
    ``,
    `You appear in Dak as "${agent}". Keep messages short and say what you need from ${person}.`,
  ].join("\n");
}
