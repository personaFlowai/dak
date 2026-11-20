/* Starting a session from Dak: the person picks a tool, who it is for, a folder and the first
   message; Dak makes the folder (a fresh git worktree off main, or an existing folder), opens a
   topic with the message, and runs the tool there in the background under that name. The
   conversation is the topic; the agent answers with dak reply like any other.

   Only the person starts one, and never while the machine is busy: a session started on a
   loaded laptop slows every other one down. The limit is the number of cores unless the
   person sets another (start_load_limit in config). */
import { existsSync, mkdirSync } from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { basename, join } from "node:path";
import { dakHome, loadConfig, person } from "./config";
import { createThread, markRead, store } from "./store";
import { touch } from "./presence";
import { claudeBin } from "./sleeper";
import { getWork, moveWork, reassignWork } from "./work";
import { DakError } from "./types";
import { setMember, team } from "./team";

export const TOOLS = ["claude-code", "codex", "cursor"] as const;
export type LaunchTool = (typeof TOOLS)[number];

export interface Launch {
  id: number; name: string; tool: LaunchTool; folder: string; branch: string | null; thread_id: string;
  work_id: string | null; session_id: string | null; started_at: string; ended_at: string | null; status: string; log: string;
}

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS launches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tool TEXT NOT NULL,
    folder TEXT NOT NULL, branch TEXT, thread_id TEXT NOT NULL, work_id TEXT, session_id TEXT, started_at TEXT NOT NULL,
    ended_at TEXT, status TEXT NOT NULL, log TEXT NOT NULL)`);
}

// Bun's os.loadavg() reads as zero on macOS (1.1.42), which would let anything start; ask the
// kernel instead there.
function oneMinuteLoad(): number {
  if (process.platform === "darwin") {
    const out = Bun.spawnSync(["sysctl", "-n", "vm.loadavg"], { stdout: "pipe" }).stdout.toString();
    const n = Number(out.replace(/[{}]/g, "").trim().split(/\s+/)[0]);
    if (Number.isFinite(n)) return n;
  }
  return loadavg()[0];
}

export function load(): { now: number; limit: number; ok: boolean } {
  const limit = Number(process.env.DAK_START_LOAD_LIMIT ?? (loadConfig() as any).start_load_limit ?? 0) || cpus().length;
  const now = Math.round(oneMinuteLoad() * 10) / 10;
  return { now, limit, ok: now < limit };
}

// The repositories agents have worked in lately: where a new worktree can come from.
export function repos(): string[] {
  const rows = store().query("SELECT where_ FROM presence WHERE where_ IS NOT NULL ORDER BY last_seen DESC LIMIT 200").all() as { where_: string }[];
  const out: string[] = [];
  for (const { where_ } of rows) {
    const root = where_.split("/.claude/worktrees/")[0].split("/.codex/worktrees/")[0];
    // A real project: not the home folder, not a tool's own hidden folder (~/.codex/memories).
    if (!root || root === homedir() || root.includes("/.") || root.startsWith("/private/") || root.startsWith("/tmp/")) continue;
    if (!out.includes(root) && existsSync(join(root, ".git"))) out.push(root);
  }
  return out.slice(0, 12);
}

// Folders agents have worked in lately: where a new agent can work without a new worktree.
export function folders(): { path: string; name: string; last_seen: string }[] {
  const rows = store().query("SELECT name, where_, last_seen FROM presence WHERE where_ IS NOT NULL ORDER BY last_seen DESC LIMIT 60").all() as { name: string; where_: string; last_seen: string }[];
  const seen = new Set<string>(), out: { path: string; name: string; last_seen: string }[] = [];
  for (const r of rows) if (!seen.has(r.where_) && existsSync(r.where_) && !r.where_.startsWith("/private/") && !r.where_.startsWith("/tmp/")) { seen.add(r.where_); out.push({ path: r.where_, name: r.name, last_seen: r.last_seen }); }
  return out.slice(0, 12);
}

export function launches(limit = 20): Launch[] {
  ensure();
  return store().query("SELECT * FROM launches ORDER BY id DESC LIMIT ?").all(limit) as Launch[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

// A fresh worktree off main (or master, or what is checked out) on a new branch, under ~/.dak.
function worktree(repo: string, branch: string): string {
  if (!existsSync(join(repo, ".git"))) throw new DakError("not_a_repo", `${repo} is not a git repository.`);
  const base = ["main", "master"].find((b) => git(repo, "rev-parse", "--verify", "--quiet", b).ok) ?? "HEAD";
  const path = join(dakHome(), "worktrees", basename(repo), slug(branch));
  if (existsSync(path)) throw new DakError("folder_taken", `${path} already exists. Pick another branch name.`, 409);
  mkdirSync(join(dakHome(), "worktrees", basename(repo)), { recursive: true });
  const r = git(repo, "worktree", "add", "-b", branch, path, base);
  if (!r.ok) throw new DakError("worktree_failed", `git could not make the worktree: ${r.err || r.out}`, 409);
  return path;
}

function commandFor(tool: LaunchTool, prompt: string, sessionId: string): string[] {
  if (tool === "claude-code") {
    const bin = claudeBin();
    if (!bin) throw new DakError("no_tool", "Claude Code is not installed on this Mac.", 409);
    return [bin, "-p", prompt, "--session-id", sessionId];
  }
  if (tool === "codex") return [process.env.DAK_CODEX_BIN || "codex", "exec", prompt];
  return [process.env.DAK_CURSOR_BIN || join(homedir(), ".local/bin/cursor-agent"), "-p", prompt];
}

export function startSession(input: {
  tool: string; name: string; message: string; by: string;
  repo?: string | null; folder?: string | null; branch?: string | null; work?: string | null;
}, run = spawnRun): Launch {
  ensure();
  const me = person(loadConfig());
  if (input.by !== me) throw new DakError("not_yours", `Only ${me} starts a session.`, 403);
  const tool = input.tool as LaunchTool;
  if (!TOOLS.includes(tool)) throw new DakError("bad_tool", `Tool is one of ${TOOLS.join(", ")}.`);
  // Like adding someone to the team: it has a name. "Designer" goes by @designer; a name already
  // on the team adds a session to that agent instead of a second agent.
  const display = input.name?.trim() ?? "";
  const name = slug(display);
  if (!display || name === "session") throw new DakError("bad_name", "Give it a name, such as Designer.");
  if (name === me) throw new DakError("bad_name", "A session is an agent, not you.");
  const work = input.work ? getWork(input.work) : null;
  const message = input.message?.trim() || (work ? `Start on ${work.id}: ${work.title}.` : "");
  if (!message) throw new DakError("no_message", "Say what the session should do first.");
  const l = load();
  if (!l.ok) throw new DakError("busy", `The machine is busy (load ${l.now}, limit ${l.limit}). Start it when the load is lower.`, 409);
  // The folder: a new worktree, or a folder that already exists.
  let folder: string, branch: string | null = null;
  if (input.repo) {
    branch = input.branch?.trim() || (work?.ticket && /^[A-Z][A-Z0-9]+-\d+$/.test(work.ticket) ? `${work.ticket}-${slug(work.title)}` : `dak/${slug(name)}-${Date.now().toString(36)}`);
    folder = worktree(input.repo, branch);
  } else {
    folder = input.folder?.trim() || "";
    if (!folder || !existsSync(folder)) throw new DakError("no_folder", "Pick a repository for a new worktree, or a folder that exists.");
  }
  const sessionId = crypto.randomUUID();
  touch(name, { tool, where: folder, ...(tool === "claude-code" ? { session: sessionId } : {}) });
  const { thread, message: first } = createThread({ to: name, from: me, subject: message.split("\n")[0].slice(0, 120), kind: "note", body: message, attachments: [] });
  markRead(name, thread.id, first.id); // it is in the prompt; the hook must not hand it over again
  if (work) { reassignWork(work.id, name, me); moveWork(work.id, "doing", me, { thread_id: thread.id }); }
  // A new name gets a card on the Team page, under the name as typed.
  if (!team({ all: true }).find((m) => m.name === name)?.carded) { try { setMember(name, { display }); } catch { /* the card can be written later */ } }
  const prompt = [
    `${me} started this session from Dak. You are @${name}.`, "", message, "",
    ...(work ? [`You own ${work.id}: "${work.title}" (${work.kind}${work.ticket ? `, ${work.ticket}` : ""}). Move it yourself: dak work ready ${work.id} --proof "..." --topic ${thread.id} when it is ready for ${me}.`, ""] : []),
    `${me} reads Dak, not this session. Answer there: dak reply ${thread.id} --from ${name} "<your answer>"`,
  ].join("\n");
  const log = join(dakHome(), "launches", `${name}-${Date.now()}.log`);
  mkdirSync(join(dakHome(), "launches"), { recursive: true });
  const id = Number(store().query(`INSERT INTO launches (name, tool, folder, branch, thread_id, work_id, session_id, started_at, status, log)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, tool, folder, branch, thread.id, work?.id ?? null, tool === "claude-code" ? sessionId : null, new Date().toISOString(), "running", log).lastInsertRowid);
  run(id, commandFor(tool, prompt, sessionId), folder, name, log);
  return store().query("SELECT * FROM launches WHERE id = ?").get(id) as Launch;
}

// In the background, under the session's name, so its hooks and replies are that member's.
function spawnRun(id: number, cmd: string[], cwd: string, name: string, log: string) {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log + ".err"), env: { ...process.env, DAK_NAME: name } });
  proc.exited.then((code) => store().query("UPDATE launches SET status = ?, ended_at = ? WHERE id = ?").run(code === 0 ? "done" : "failed", new Date().toISOString(), id));
}
