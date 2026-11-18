/* The Board: the person's backlog, each engineer's pile, and where every ticket stands.

   Linear stays the backlog (tickets, labels, milestones, its own status); src/linear.ts copies
   open tickets here. Dak holds what Linear cannot: which agent has a ticket, the order of each
   agent's pile, and progress read from the work itself. A ticket's stage comes from facts first
   (Linear's status, the person's verdicts, the merge queue) and from what the engineer said only
   where no fact says more, so it cannot drift the way a hand-written standup does. */
import { loadConfig, person } from "./config";
import { store, createThread, getThread, addMessage } from "./store";
import { queue } from "./queue";
import { prStates } from "./verdicts";
import { team } from "./team";
import { DakError, type Thread } from "./types";

export interface Task {
  id: string; // "REVA-3041" for a Linear ticket, "T-<n>" for one made in Dak
  source: "linear" | "dak";
  title: string; url: string | null;
  labels: string[]; milestone: string | null; project: string | null; team: string | null;
  state: string | null; // Linear's own status name: "Todo", "In Progress", "Checking", "Done"
  state_type: string | null; // backlog, unstarted, started, completed, canceled
  priority: number | null; // Linear: 0 none, 1 urgent ... 4 low
  updated_at: string | null;
}
export type Stage = "backlog" | "next" | "brief" | "building" | "review" | "you" | "changes" | "approved" | "merging" | "live" | "checking" | "done";
export interface Work { kind: "pr" | "doc" | "note"; thread: string; label: string; state: string; at: string }
export interface Card extends Task {
  agent: string | null; position: number | null; assigned_at: string | null; started_at: string | null;
  stage: Stage; stage_note: string | null; // "Cursor round 2", "stopped at: typecheck"
  status: { note: string; blocked: string | null; by: string; at: string } | null; // the engineer's last word
  work: Work[];
  needs_you: boolean;
}

export const STAGES: Stage[] = ["backlog", "next", "brief", "building", "review", "you", "changes", "approved", "merging", "live", "checking", "done"];

function ensure() {
  store().exec(`
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT, labels TEXT NOT NULL DEFAULT '[]',
      milestone TEXT, project TEXT, team TEXT, state TEXT, state_type TEXT, priority INTEGER, updated_at TEXT, synced_at TEXT);
    CREATE TABLE IF NOT EXISTS task_assignments (task_id TEXT PRIMARY KEY, agent TEXT NOT NULL, position REAL NOT NULL,
      assigned_at TEXT NOT NULL, assigned_by TEXT NOT NULL, started_at TEXT);
    CREATE TABLE IF NOT EXISTS task_status (task_id TEXT NOT NULL, agent TEXT NOT NULL, note TEXT NOT NULL, blocked TEXT, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_status_by_task ON task_status (task_id, at);`);
}

const rowToTask = (r: any): Task => ({ id: r.id, source: r.source, title: r.title, url: r.url, labels: JSON.parse(r.labels || "[]"), milestone: r.milestone,
  project: r.project, team: r.team, state: r.state, state_type: r.state_type, priority: r.priority, updated_at: r.updated_at });

/* ---------- the backlog itself ---------- */

// Write what Linear (or a person) says a ticket is. Assignments and status lines are Dak's and stay.
export function upsertTasks(list: Task[], syncedAt = new Date().toISOString()) {
  ensure();
  const q = store().query(`INSERT INTO tasks (id, source, title, url, labels, milestone, project, team, state, state_type, priority, updated_at, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, labels=excluded.labels, milestone=excluded.milestone,
    project=excluded.project, team=excluded.team, state=excluded.state, state_type=excluded.state_type, priority=excluded.priority, updated_at=excluded.updated_at, synced_at=excluded.synced_at`);
  store().transaction(() => { for (const t of list) q.run(t.id, t.source, t.title, t.url, JSON.stringify(t.labels ?? []), t.milestone, t.project, t.team, t.state, t.state_type, t.priority, t.updated_at, syncedAt); })();
}

// A ticket made in Dak, for work that has no Linear ticket.
export function addTask(title: string, opts: { labels?: string[]; milestone?: string } = {}): Task {
  ensure();
  const n = ((store().query("SELECT count(*) AS n FROM tasks WHERE source = 'dak'").get() as { n: number }).n) + 1;
  const t: Task = { id: `T-${n}`, source: "dak", title: title.trim().slice(0, 200), url: null, labels: opts.labels ?? [], milestone: opts.milestone ?? null,
    project: null, team: null, state: "Todo", state_type: "unstarted", priority: null, updated_at: new Date().toISOString() };
  if (!t.title) throw new DakError("no_title", "Say what the task is.");
  upsertTasks([t]);
  return t;
}

export function getTask(id: string): Task {
  ensure();
  const r = store().query("SELECT * FROM tasks WHERE id = ? COLLATE NOCASE").get(id.trim());
  if (!r) throw new DakError("no_task", `No ticket ${id} on the Board. Linear tickets arrive once the Linear key is set.`, 404);
  return rowToTask(r);
}

/* ---------- assigning, ordering, starting ---------- */

// Put a ticket in an agent's pile (or back in the backlog with agent null), before another one
// or at the end. The agent gets a Dak message saying so; Atlas, when there is one, an FYI.
export function assign(taskId: string, agent: string | null, opts: { before?: string | null; by?: string } = {}): Card {
  ensure();
  const task = getTask(taskId);
  const by = opts.by ?? person(loadConfig());
  const prev = store().query("SELECT agent FROM task_assignments WHERE task_id = ?").get(task.id) as { agent: string } | null;
  if (!agent) {
    store().query("DELETE FROM task_assignments WHERE task_id = ?").run(task.id);
    return card(task.id);
  }
  const who = agent.trim().toLowerCase();
  if (!team({ all: true }).some((m) => m.name === who && m.kind !== "person")) throw new DakError("no_member", `No agent called ${who} on the team.`, 404);
  const pile = store().query("SELECT task_id, position FROM task_assignments WHERE agent = ? AND task_id != ? ORDER BY position").all(who, task.id) as { task_id: string; position: number }[];
  const at = opts.before ? pile.findIndex((p) => p.task_id.toLowerCase() === opts.before!.toLowerCase()) : -1;
  const position = at < 0 ? (pile.at(-1)?.position ?? 0) + 1 : at === 0 ? pile[0].position - 1 : (pile[at - 1].position + pile[at].position) / 2;
  store().query(`INSERT INTO task_assignments (task_id, agent, position, assigned_at, assigned_by) VALUES (?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET agent = excluded.agent, position = excluded.position,
      assigned_at = CASE WHEN task_assignments.agent = excluded.agent THEN task_assignments.assigned_at ELSE excluded.assigned_at END,
      started_at = CASE WHEN task_assignments.agent = excluded.agent THEN task_assignments.started_at ELSE NULL END`).run(task.id, who, position, new Date().toISOString(), by);
  if (prev?.agent !== who) tellAssigned(task, who, by);
  return card(task.id);
}

// One standing topic per agent for its pile, and one for Atlas's FYIs, so assigning ten tickets is
// ten messages on one topic, not ten new topics in everyone's list.
function onTopic(to: string, from: string, subject: string, body: string, quiet: boolean) {
  const t = store().query("SELECT id FROM threads WHERE to_reader = ? AND from_name = ? AND subject = ? ORDER BY created_at DESC LIMIT 1").get(to, from, subject) as { id: string } | null;
  if (t) addMessage(t.id, { author: from, body, ...(quiet ? { needs_reply: false } : { needs_reply: true }) });
  else createThread({ to, from, kind: "note", subject, attachments: [], body, ...(quiet ? { needs_reply: false } : {}) });
}

function tellAssigned(task: Task, agent: string, by: string) {
  const place = pileOf(agent).findIndex((c) => c.id === task.id) + 1;
  const link = task.url ? `\n${task.url}` : "";
  onTopic(agent, by, "Board: your pile", `You're on ${task.id}: ${task.title}. It's #${place} in your pile.${link}\n\nTake it when it's next: \`dak next\` gives you the top of your pile. Say where you are with \`dak status ${task.id} "what you're doing"\`.`, false);
  const lead = team({ all: true }).find((m) => m.name === "atlas" && m.kind !== "person");
  if (lead && lead.name !== agent) onTopic(lead.name, by, "Board: assignments", `${by} gave ${task.id} (${task.title}) to ${agent}, #${place} in their pile.`, true);
}

// The next ticket in an agent's pile that has not started; taking it marks it started.
export function next(agent: string): Card | null {
  ensure();
  const r = store().query("SELECT task_id FROM task_assignments WHERE agent = ? AND started_at IS NULL ORDER BY position LIMIT 1").get(agent) as { task_id: string } | null;
  if (!r) return null;
  store().query("UPDATE task_assignments SET started_at = ? WHERE task_id = ?").run(new Date().toISOString(), r.task_id);
  return card(r.task_id);
}

// The engineer's one line: what they are doing on a ticket, and what blocks it.
export function setTaskStatus(taskId: string, agent: string, note: string, blocked?: string | null): Card {
  ensure();
  const task = getTask(taskId);
  if (!note.trim()) throw new DakError("no_note", "Say what you are doing: dak status <ticket> \"fixing Cursor round 2\".");
  store().query("INSERT INTO task_status (task_id, agent, note, blocked, at) VALUES (?,?,?,?,?)").run(task.id, agent, note.trim().slice(0, 300), blocked?.trim() || null, new Date().toISOString());
  store().query("UPDATE task_assignments SET started_at = coalesce(started_at, ?) WHERE task_id = ? AND agent = ?").run(new Date().toISOString(), task.id, agent);
  return card(task.id);
}

/* ---------- reading the work ---------- */

// The Dak topics about a ticket: any whose subject, or a PR's title on it, names the ticket.
function workFor(ids: string[]): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>();
  if (!ids.length) return out;
  const rows = store().query(`SELECT DISTINCT t.* FROM threads t LEFT JOIN messages m ON m.thread_id = t.id LEFT JOIN attachments a ON a.message_id = m.id
    WHERE t.subject LIKE '%-%' OR a.type = 'pr'`).all() as any[];
  const titles = store().query(`SELECT m.thread_id, json_extract(a.meta, '$.title') AS title FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.type = 'pr'`).all() as { thread_id: string; title: string | null }[];
  const re = (id: string) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[-]/g, "\\-")}(?![0-9])`, "i");
  for (const id of ids) {
    const r = re(id);
    const hit = new Set(titles.filter((x) => x.title && r.test(x.title)).map((x) => x.thread_id));
    // Dak's own "Board: ..." topics (an agent's pile, Atlas's FYIs) are about the Board, not work on a ticket.
    const ours = (subject: string) => subject.startsWith("Board: ");
    const list = rows.filter((t) => (r.test(t.subject) || hit.has(t.id)) && !ours(t.subject)).map((t) => ({ id: t.id, to: t.to_reader, from: t.from_name, subject: t.subject, kind: t.kind, status: t.status, created_at: t.created_at, updated_at: t.updated_at }) as Thread);
    out.set(id, [...new Map(list.map((t) => [t.id, t])).values()]);
  }
  return out;
}

const RANK: Record<Stage, number> = { backlog: 0, next: 1, brief: 2, building: 3, review: 4, changes: 5, you: 6, approved: 7, merging: 8, live: 9, checking: 10, done: 11 };

function stageOf(task: Task, a: any, threads: Thread[], me: string, q: Map<number, any>): { stage: Stage; note: string | null; work: Work[]; needs_you: boolean } {
  const work: Work[] = [];
  let needsYou = false;
  const prStagesSeen: Stage[] = [];
  let note: string | null = null;
  for (const t of threads) {
    const full = getThread(t.id);
    const prs = prStates(full.messages, [t.to]);
    const waitingOnMe = t.status === "waiting" && t.to === me;
    if (waitingOnMe) needsYou = true;
    if (prs.length) {
      for (const p of prs) {
        const row = p.number ? q.get(p.number) : null;
        let s: Stage = p.verdict === "approve" ? "approved" : p.verdict === "changes" ? "changes" : waitingOnMe ? "you" : "review";
        if (row) {
          if (row.state === "deployed") s = "live";
          else if (["merged", "migrated"].includes(row.state)) s = "live";
          else if (["testing", "building", "merging", "failed", "held"].includes(row.state)) { s = "merging"; if (row.state === "failed" || row.state === "held") note = `stopped: ${row.note ?? row.state}`; }
        }
        prStagesSeen.push(s);
        work.push({ kind: "pr", thread: t.id, label: `${p.key}${p.title ? ` ${p.title}` : ""}`, state: s, at: t.updated_at });
      }
    } else {
      const s = waitingOnMe ? "you" : t.status === "closed" ? "done" : "brief";
      work.push({ kind: full.messages.some((m) => m.attachments.some((x) => x.type === "doc" || x.type === "file")) ? "doc" : "note", thread: t.id, label: t.subject, state: s, at: t.updated_at });
    }
  }
  // Linear's own word on checking and done wins; otherwise the least advanced open PR sets the
  // stage, because a ticket is only as far along as the PR still furthest behind.
  let stage: Stage;
  if (task.state_type === "completed" || task.state_type === "canceled") stage = "done";
  else if (task.state && /check/i.test(task.state)) stage = "checking";
  else if (prStagesSeen.length) stage = prStagesSeen.reduce((lo, s) => (RANK[s] < RANK[lo] ? s : lo));
  else if (needsYou) stage = "you";
  else if (work.some((w) => w.state === "brief")) stage = "brief";
  else if (a?.started_at) stage = "building";
  else if (a) stage = "next";
  else stage = "backlog";
  if (stage === "you" || needsYou) needsYou = true;
  return { stage, note, work: work.sort((x, y) => x.at.localeCompare(y.at)), needs_you: needsYou };
}

function cardsFor(tasks: Task[]): Card[] {
  const me = person(loadConfig());
  const as = new Map((store().query("SELECT * FROM task_assignments").all() as any[]).map((r) => [r.task_id, r]));
  const st = new Map<string, any>();
  for (const r of store().query("SELECT * FROM task_status ORDER BY at").all() as any[]) st.set(r.task_id, r);
  const q = new Map(queue({ all: true }).map((r) => [r.pr, r]));
  const works = workFor(tasks.map((t) => t.id));
  return tasks.map((t) => {
    const a = as.get(t.id), s = st.get(t.id);
    const { stage, note, work, needs_you } = stageOf(t, a, works.get(t.id) ?? [], me, q);
    return { ...t, agent: a?.agent ?? null, position: a?.position ?? null, assigned_at: a?.assigned_at ?? null, started_at: a?.started_at ?? null,
      stage, stage_note: note ?? (s && !s.blocked ? s.note : s?.blocked ? `blocked: ${s.blocked}` : null),
      status: s ? { note: s.note, blocked: s.blocked, by: s.agent, at: s.at } : null, work, needs_you };
  });
}

export function card(id: string): Card { return cardsFor([getTask(id)])[0]; }

export function pileOf(agent: string): Card[] {
  ensure();
  const ids = (store().query("SELECT task_id FROM task_assignments WHERE agent = ? ORDER BY position").all(agent) as { task_id: string }[]).map((r) => r.task_id);
  const tasks = ids.map((id) => store().query("SELECT * FROM tasks WHERE id = ?").get(id)).filter(Boolean).map(rowToTask);
  return cardsFor(tasks);
}

// Everything for the Board page: open tickets, plus what finished in the last few days.
export function board(): { cards: Card[]; labels: string[]; milestones: string[]; synced_at: string | null } {
  ensure();
  const since = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const tasks = (store().query(`SELECT * FROM tasks WHERE coalesce(state_type, '') NOT IN ('completed', 'canceled') OR updated_at > ? OR id IN (SELECT task_id FROM task_assignments)`).all(since) as any[]).map(rowToTask);
  const cards = cardsFor(tasks).filter((c) => c.stage !== "done" || (c.updated_at ?? "") > since);
  const labels = [...new Set(cards.flatMap((c) => c.labels))].sort();
  const milestones = [...new Set(cards.map((c) => c.milestone).filter(Boolean) as string[])].sort();
  const synced = (store().query("SELECT max(synced_at) AS s FROM tasks WHERE source = 'linear'").get() as { s: string | null }).s;
  return { cards, labels, milestones, synced_at: synced };
}
