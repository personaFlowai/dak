/* Waking a Claude Code session whose process has ended. The Claude desktop app closes an idle
   session's process after a while; Dak's wake hook lives in that process, so it ends too, and
   mail would wait until someone opens the session. Here the server notices mail waiting for a
   session that has no live process, and runs one turn on it in the background
   (`claude -p --resume <session>` in its folder) with the mail as the prompt. The person gets
   a notification saying so. While that turn runs, Dak shows it; opening the session then would
   put two processes on one conversation, so the run is short and announced. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dakHome, loadConfig, person } from "./config";
import { hasOpenWork } from "./work";
import { store, takeUnread } from "./store";
import { brief } from "./hook";

const SESSIONS = () => process.env.DAK_CLAUDE_SESSIONS ?? join(homedir(), ".claude", "sessions");
const GRACE_MS = Number(process.env.DAK_WAKE_GRACE_MS ?? 30_000); // a live hook gets the first chance
const RUN_LIMIT_MS = 30 * 60_000;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS wake_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session_id TEXT NOT NULL,
    thread_id TEXT, from_name TEXT, subject TEXT, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, log_path TEXT)`);
}

// Is any Claude Code process running this session? Claude Code writes one file per running
// process, naming its session; a file whose process is gone does not count.
export function sessionRunning(sessionId: string): boolean {
  const dir = SESSIONS();
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (s.sessionId === sessionId && alive(Number(s.pid))) return true;
    } catch { /* a file being written */ }
  }
  return false;
}

// The Claude Code binary: on the PATH, else the newest one the desktop app ships.
function claudeBin(): string | null {
  if (process.env.DAK_CLAUDE_BIN) return process.env.DAK_CLAUDE_BIN;
  for (const p of [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) if (existsSync(p)) return p;
  const root = join(homedir(), "Library/Application Support/Claude/claude-code");
  if (!existsSync(root)) return null;
  const versions = readdirSync(root).filter((v) => /^\d/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const v of versions.reverse()) {
    const dir = join(root, v);
    for (const sub of readdirSync(dir)) { const bin = join(dir, sub, "claude.app/Contents/MacOS/claude"); if (existsSync(bin)) return bin; }
  }
  return null;
}

const running = new Map<string, { started: number }>(); // session → its background turn

export function activeWakes(): { agent: string; session_id: string; started_at: string }[] {
  ensure();
  return store().query("SELECT agent, session_id, started_at FROM wake_runs WHERE status = 'running'").all() as any[];
}

export function recentWakes(limit = 20) {
  ensure();
  return store().query("SELECT id, agent, thread_id, from_name, subject, started_at, ended_at, status FROM wake_runs ORDER BY id DESC LIMIT ?").all(limit) as any[];
}

// Called by the server every few seconds.
export function tickSleepers(run = startRun, opts: { force?: boolean } = {}) {
  if (!opts.force && (process.env.DAK_NO_WAKE || loadConfig().wake_closed === false)) return;
  ensure();
  const now = Date.now();
  // Only sessions used in the last week, and only mail from the last day: an old session with
  // old unread mail is not woken to a backlog nobody is waiting on.
  const week = new Date(now - 7 * 86_400_000).toISOString(), day = now - 86_400_000;
  const agents = store().query(`SELECT name, session_id, where_ FROM presence WHERE tool = 'claude-code' AND session_id IS NOT NULL AND session_id != '' AND last_seen > ?`)
    .all(week) as { name: string; session_id: string; where_: string | null }[];
  for (const a of agents) {
    if (running.has(a.session_id) || !a.where_ || !existsSync(a.where_)) continue;
    // Updates (no reply needed) never wake a session; they wait for its next turn.
    const mail = takeUnread(a.name, { peek: true }).filter((m) => !m.quiet && Date.parse(m.created_at) > day);
    if (!mail.length) continue;
    // Wait for the hooks first: a running session gets its mail at its next turn or wake.
    if (now - Date.parse(mail[0].created_at) < GRACE_MS) continue;
    if (sessionRunning(a.session_id)) continue;
    // No work, no start: a closed agent is started for the person's own mail, or when it owns a
    // piece of work to start from. Another agent's ping waits for the session's next turn.
    if (!hasOpenWork(a.name) && !mail.some((m) => m.author === person(loadConfig()))) continue;
    run(a.name, a.session_id, a.where_);
  }
}

export function startRun(agent: string, sessionId: string, where: string) {
  const bin = claudeBin();
  if (!bin) return;
  const mail = takeUnread(agent); // taken now, so no hook hands it over a second time
  if (!mail.length) return;
  const first = mail[0];
  const subject = (store().query("SELECT subject FROM threads WHERE id = ?").get(first.thread_id) as { subject: string } | null)?.subject ?? "";
  const dir = join(dakHome(), "wake-runs");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${agent}-${Date.now()}.log`);
  const id = Number(store().query("INSERT INTO wake_runs (agent, session_id, thread_id, from_name, subject, started_at, status, log_path) VALUES (?,?,?,?,?,?,?,?)")
    .run(agent, sessionId, first.thread_id, first.author, subject, new Date().toISOString(), "running", log).lastInsertRowid);
  running.set(sessionId, { started: Date.now() });
  const prompt = `${brief(agent, mail)}\n\n(Dak started this turn because your session was closed when the mail arrived. Act on it as you would at a normal turn, then stop.)`;
  const proc = Bun.spawn([bin, "-p", "--resume", sessionId, prompt], {
    cwd: where, stdout: Bun.file(log), stderr: Bun.file(log + ".err"), stdin: "ignore",
    env: { ...process.env, DAK_WAKE_RUN: "1" },
  });
  const timer = setTimeout(() => proc.kill(), RUN_LIMIT_MS);
  proc.exited.then((code) => {
    clearTimeout(timer);
    running.delete(sessionId);
    store().query("UPDATE wake_runs SET status = ?, ended_at = ? WHERE id = ?").run(code === 0 ? "done" : proc.killed ? "timed_out" : "failed", new Date().toISOString(), id);
  });
}

// Runs left marked running by a server that stopped mid-run.
export function settleWakes() {
  ensure();
  store().query("UPDATE wake_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(new Date().toISOString());
}

export const logSize = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
