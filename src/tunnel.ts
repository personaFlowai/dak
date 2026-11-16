import { existsSync, readFileSync, writeFileSync, chmodSync, openSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
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

/* The door's tunnel runs as its own process (detached), so a Dak update or restart does not
   change the address the remote agent has saved. Its state lives in ~/.dak/door.json. */
interface DoorState { agent: string; tool: "cloudflare" | "ngrok"; pid: number; url: string | null; log: string }
const doorPath = () => join(dakHome(), "door.json");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function readDoor(): DoorState | null {
  try { const d = JSON.parse(readFileSync(doorPath(), "utf8")) as DoorState; return alive(d.pid) ? d : null; } catch { return null; }
}

function urlIn(d: DoorState): string | null {
  try {
    const text = readFileSync(d.log, "utf8");
    if (d.tool === "cloudflare") return /Registered tunnel connection/.test(text) ? text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null : null;
    return text.match(/"url":"(https:\/\/[^"]+)"/)?.[1] ?? null;
  } catch { return null; }
}

export function doorStatus() {
  const d = readDoor();
  if (!d) return { open: false };
  if (!d.url) { d.url = urlIn(d); if (d.url) writeFileSync(doorPath(), JSON.stringify(d)); }
  return { open: true, agent: d.agent, tool: d.tool, url: d.url, error: null };
}

// Cloudflare's quick tunnel needs no account; its address changes when the tunnel restarts.
// ngrok uses the account it is already signed in to.
export async function openDoor(agent: string, port: number, tool: "cloudflare" | "ngrok" = "cloudflare") {
  const cur = readDoor();
  if (cur && cur.agent === agent && cur.tool === tool) { agentKey(agent); return doorStatus(); }
  closeDoor();
  agentKey(agent);
  const log = join(dakHome(), "door-tunnel.log");
  writeFileSync(log, "");
  const out = openSync(log, "a");
  const [cmd, ...args] = tool === "cloudflare"
    ? ["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`]
    : ["ngrok", "http", `127.0.0.1:${port}`, "--log", "stdout", "--log-format", "json"];
  let proc: ReturnType<typeof spawn>;
  try { proc = spawn(cmd, args, { detached: true, stdio: ["ignore", out, out] }); }
  catch { throw new DakError("no_tunnel_tool", `${cmd} is not installed.`, 502); }
  if (!proc.pid) throw new DakError("no_tunnel_tool", `${cmd} is not installed.`, 502);
  proc.unref();
  const d: DoorState = { agent, tool, pid: proc.pid, url: null, log };
  writeFileSync(doorPath(), JSON.stringify(d));
  for (let i = 0; i < 120 && !urlIn(d) && alive(d.pid); i++) await Bun.sleep(250);
  if (!urlIn(d)) { closeDoor(); return { open: false, error: "The tunnel did not come up within 30 seconds." }; }
  await Bun.sleep(4000); // give Cloudflare's DNS a moment before anyone asks for the address
  return doorStatus();
}

export function closeDoor() {
  const d = readDoor();
  if (d) { try { process.kill(d.pid); } catch { /* already gone */ } }
  try { unlinkSync(doorPath()); } catch { /* none */ }
}

export function instructionsFor(agent: string, url: string, key: string, person: string): string {
  return [
    `You can reach ${person}'s review inbox (Dak) over HTTPS. Use it to send ${person} messages and to read ${person}'s replies.`,
    `Base address: ${url}`,
    `Send this header on every call: Authorization: Bearer ${key}`,
    ``,
    `Send a message:   POST ${url}/x/send   JSON {"subject": "...", "body": "Markdown text", "link": "optional URL", "to": "optional agent name"}   returns {"thread": {"id": ...}}`,
    `                  Leave "to" out to write to ${person}; set it to write to another agent directly. Who you can write to: GET ${url}/x/agents`,
    ``,
    `Optional fields on a send or a reply (the same as the agents on this Mac use):`,
    `  "options": ["Ship it", "Hold"]       buttons ${person} answers with; the pick comes back as "choice"`,
    `  "fyi": true                          an update that needs no answer (keeps it out of what waits on ${person})`,
    `  "type": "pr" | "brief" | "decision"  what kind of answer you need; a doc, spec or mock is a brief`,
    `  "blocks": "Rohan, #2433"             what the answer releases; shown on the ask`,
    `  "tier": "urgent" | "normal" | "later", "why": "unblocks 8 PRs"   its priority in ${person}'s list (urgent: a production bug, security, an unblocker)`,
    `  "cost": {"estimate": 0.15, "cap": 0.25}   what a yes would spend, shown beside the buttons`,
    `  "done": true (reply only)            the work is finished; the topic leaves ${person}'s list`,
    `  "from": "orbit"                      send as one of your bots, under its own name (letters, digits, - and _). Each bot keeps its name; replies to any of them arrive in your inbox, and each message's thread says which bot it is for.`,
    `Change the type, blocks or priority later: PUT ${url}/x/priority/<thread id> with the same fields. ${person}'s own order wins over yours.`,
    `Reply on a thread: POST ${url}/x/reply/<thread id>   JSON {"body": "..."}`,
    `Wait for a reply:  GET  ${url}/x/wait/<thread id>?timeout=50   returns {"messages": [...]} or {"timed_out": true}`,
    `Read new replies:  GET  ${url}/x/inbox`,
    ``,
    `Getting your mail: Dak cannot reach into your sandbox, so you must ask. At the start of every task and before you finish, call GET ${url}/x/inbox and act on what is there. While you wait for an answer, keep GET ${url}/x/wait/<thread id>?timeout=50 open in a loop rather than stopping.`,
    `These instructions, current: GET ${url}/x/skill. Read them again when something here does not work as described.`,
    `You appear in Dak as "${agent}". Keep messages short and say what you need.`,
  ].join("\n");
}
