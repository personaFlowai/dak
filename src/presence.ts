import { basename, join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { loadConfig, readerForFolder } from "./config";
import { store } from "./store";

// Who is out there to message. Three sources, merged by name:
//   readers   - named in config (you, atlas, ...)
//   seen      - anything that used Dak as itself: sent, waited, read its inbox, or ran the hook
//   running   - agent processes found on this Mac right now, named by their folder
// A session's name is its working folder's name, because that is what tells two
// Claude sessions apart (each runs in its own worktree) and what the hook can see.

export interface Agent {
  name: string;
  kind: "person" | "agent";
  reader: boolean;
  about: string | null;
  tool: string | null; // claude-code, codex, cursor, grok, cli
  where: string | null; // working folder
  last_seen: string | null;
  running: boolean; // a matching process exists now
  listening: boolean; // has used Dak in the last 10 minutes, so it will read a message soon
}

export const nameFor = (folder: string) =>
  basename(folder).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "session";

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS presence (
    name TEXT PRIMARY KEY, tool TEXT, where_ TEXT, session_id TEXT, last_seen TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_names (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL)`);
}

// The name a session goes by is the one it SENDS as (dak send/reply --from). Reading
// someone's inbox (--for) never changes who you are, or a quick look would take their mail. An agent that runs
// "dak send --from atlas" inside a Claude Code session is atlas from then on, so its
// hooks deliver atlas's mail there, whatever folder it runs in. Without this, replies
// to a name the folder does not produce reach no session at all.
export function claimName(name: string) {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const n = name?.trim().toLowerCase();
  if (!session || !n) return;
  if (loadConfig().readers.some((r) => r.name === n && r.kind === "person")) return; // a person, not this agent
  ensure();
  store().query("INSERT INTO session_names VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, at = excluded.at")
    .run(session, n, new Date().toISOString());
}

export function claimedName(session: string | undefined): string | null {
  if (!session) return null;
  ensure();
  return (store().query("SELECT name FROM session_names WHERE session_id = ?").get(session) as { name: string } | null)?.name ?? null;
}

export function detectTool(): string {
  const e = process.env;
  if (e.DAK_TOOL) return e.DAK_TOOL;
  if (e.CLAUDECODE) return "claude-code";
  if (e.CURSOR_AGENT || e.CURSOR_TRACE_ID) return "cursor";
  if (Object.keys(e).some((k) => k.startsWith("CODEX_"))) return "codex";
  return "cli";
}

export function touch(name: string, info: { tool?: string; where?: string; session?: string } = {}) {
  if (!name) return;
  ensure();
  store().query(`INSERT INTO presence VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
      tool = coalesce(excluded.tool, tool), where_ = coalesce(excluded.where_, where_),
      session_id = coalesce(excluded.session_id, session_id), last_seen = excluded.last_seen`)
    .run(name.toLowerCase(), info.tool ?? null, info.where ?? null, info.session ?? null, new Date().toISOString());
}

export function known(name: string): boolean {
  ensure();
  const n = name.toLowerCase();
  return loadConfig().readers.some((r) => r.name === n) || !!store().query("SELECT 1 FROM presence WHERE name = ?").get(n);
}

interface Proc { tool: string; where: string | null }

// One ps, then one lsof per agent process for its folder. Only run when someone
// opens the compose screen, never on a timer.
export function running(): Proc[] {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,comm="], { stdout: "pipe" }).stdout.toString();
  const found: { pid: string; tool: string }[] = [];
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const exe = m[2];
    const tool = /\/claude$/.test(exe) || exe === "claude" ? "claude-code"
      : /(^|\/)codex$/.test(exe) ? "codex"
      : /cursor-agent$/.test(exe) ? "cursor"
      : /Grok/i.test(exe) && /\.app\//.test(exe) && /MacOS\/[^/]+$/.test(exe) ? "grok" : null;
    if (tool) found.push({ pid: m[1], tool });
  }
  return found.map(({ pid, tool }) => {
    if (tool === "grok") return { tool, where: null };
    const out = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
    return { tool, where: out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null };
  });
}

// Codex writes one file per session under ~/.codex/sessions/YYYY/MM/DD, opening with
// its working folder. Sessions from the last two weeks count as "seen"; runs that
// Dak itself started (codex exec, in a temp folder) are not sessions to write to.
export function codexSessions(days = 14): { where: string; last_seen: string }[] {
  const root = process.env.DAK_CODEX_HOME ? join(process.env.DAK_CODEX_HOME, "sessions") : join(homedir(), ".codex", "sessions");
  const out = new Map<string, string>();
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86400000);
    const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      try {
        const path = join(dir, f);
        // The opening line carries the session's whole instructions, so read the head
        // and pick the two fields out rather than parsing a line that may be cut short.
        const fd = openSync(path, "r"); const buf = Buffer.alloc(65536); const n = readSync(fd, buf, 0, 65536, 0); closeSync(fd);
        const head = buf.toString("utf8", 0, n);
        const where = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
        const originator = head.match(/"originator":"([^"]*)"/)?.[1];
        if (!where || originator === "codex_exec" || where.startsWith(tmpdir()) || where.startsWith("/private/var/")) continue;
        const seen = statSync(path).mtime.toISOString();
        if (!out.has(where) || out.get(where)! < seen) out.set(where, seen);
      } catch { /* a file being written, or another format */ }
    }
  }
  return [...out].map(([where, last_seen]) => ({ where, last_seen }));
}

export function codexDefaultModel(): string | null {
  try { return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null; }
  catch { return null; }
}

// Before DAK_HELPER existed, the Ask helper's temporary folders (dak-ask-…) were recorded
// as if they were agents. They never were; clear them so nobody can write to one.
let cleared = false;
function clearHelperGhosts() {
  if (cleared) return;
  cleared = true;
  store().query("DELETE FROM presence WHERE name LIKE 'dak-ask-%'").run();
}

export function agents(opts: { scan?: boolean } = {}): Agent[] {
  ensure();
  clearHelperGhosts();
  const cfg = loadConfig();
  const byName = new Map<string, Agent>();
  const recent = (iso: string | null) => !!iso && Date.now() - Date.parse(iso) < 10 * 60_000;
  for (const r of cfg.readers) {
    byName.set(r.name, { name: r.name, kind: r.kind, reader: true, about: r.about ?? null, tool: r.tool ?? null, where: r.where ?? null, last_seen: null, running: false, listening: false });
  }
  for (const p of store().query("SELECT * FROM presence").all() as any[]) {
    const a = byName.get(p.name) ?? { name: p.name, kind: "agent", reader: false, about: null, tool: null, where: null, last_seen: null, running: false, listening: false };
    Object.assign(a, { tool: p.tool ?? a.tool, where: p.where_ ?? a.where, last_seen: p.last_seen, listening: recent(p.last_seen) });
    byName.set(p.name, a);
  }
  if (opts.scan) {
    for (const c of codexSessions()) {
      const name = readerForFolder(c.where) ?? nameFor(c.where);
      const a = byName.get(name) ?? { name, kind: "agent", reader: false, about: null, tool: "codex", where: c.where, last_seen: null, running: false, listening: false };
      if (!a.last_seen || a.last_seen < c.last_seen) a.last_seen = c.last_seen;
      a.tool ??= "codex";
      byName.set(name, a);
    }
    for (const proc of running()) {
      const name = proc.tool === "grok" ? "grok" : proc.where ? (readerForFolder(proc.where) ?? nameFor(proc.where)) : null;
      if (!name) continue;
      const a = byName.get(name) ?? { name, kind: "agent", reader: false, about: null, tool: proc.tool, where: proc.where, last_seen: null, running: false, listening: false };
      a.running = true;
      a.tool ??= proc.tool;
      a.where ??= proc.where;
      byName.set(name, a);
    }
  }
  const people = [...byName.values()].filter((a) => a.kind === "person");
  const rest = [...byName.values()].filter((a) => a.kind !== "person");
  rest.sort((x, y) => Number(y.reader) - Number(x.reader) || Number(y.listening) - Number(x.listening)
    || Number(y.running) - Number(x.running) || x.name.localeCompare(y.name));
  return [...people, ...rest];
}
