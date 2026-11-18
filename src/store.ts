import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { dakHome, loadConfig } from "./config";
import type {
  Anchor, Attachment, Comment, Message, Reader, Thread, ThreadKind, ThreadStatus, Verdict,
} from "./types";
import { DakError, ROLES, type Participant, type Role, type MessageExtra, type Cost } from "./types";
import { known } from "./presence";
import { approvedNow, prStates, type PrState } from "./verdicts";

// One SQLite file shared by every CLI call and the server. WAL lets many agents
// write at once; busy_timeout makes a writer wait for a lock instead of failing.
let db: Database | null = null;
let dbHome = "";

export function store(): Database {
  const home = dakHome();
  if (db && dbHome === home) return db;
  db = new Database(join(home, "dak.db"), { create: true });
  dbHome = home;
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, to_reader TEXT NOT NULL, from_name TEXT NOT NULL,
      subject TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS threads_to ON threads(to_reader, updated_at);
    CREATE INDEX IF NOT EXISTS threads_from ON threads(from_name, updated_at);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id),
      author TEXT NOT NULL, body TEXT NOT NULL, verdict TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id),
      type TEXT NOT NULL, name TEXT NOT NULL, meta TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id),
      message_id INTEGER NOT NULL REFERENCES messages(id), attachment_id TEXT,
      author TEXT NOT NULL, anchor TEXT, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS comments_message ON comments(message_id);
    -- How far each reader has read each thread. Unread = later messages by someone else.
    CREATE TABLE IF NOT EXISTS reads (
      reader TEXT NOT NULL, thread_id TEXT NOT NULL, last_seen INTEGER NOT NULL,
      PRIMARY KEY (reader, thread_id));
    -- A conversation the reader put away, and when. It stays put away until someone else
    -- writes in it after that moment; nothing is deleted.
    -- Everyone else on a thread besides its sender and addressee, with what they are there
    -- for: a reviewer, an approver, a watcher, or a member of the group it was sent to.
    CREATE TABLE IF NOT EXISTS participants (
      thread_id TEXT NOT NULL REFERENCES threads(id), name TEXT NOT NULL, role TEXT NOT NULL,
      PRIMARY KEY (thread_id, name));
    -- A named set of readers, so one message reaches all of them: --to group:engineers.
    CREATE TABLE IF NOT EXISTS groups (
      name TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (name, member));
    CREATE TABLE IF NOT EXISTS archives (
      reader TEXT NOT NULL, peer TEXT NOT NULL, archived_at TEXT NOT NULL,
      PRIMARY KEY (reader, peer));
    -- An attachment taken off a topic (a merged PR nobody needs): kept, but out of the way.
    CREATE TABLE IF NOT EXISTS hidden_attachments (
      attachment_id TEXT PRIMARY KEY, by_name TEXT NOT NULL, hidden_at TEXT NOT NULL);
  `);
  // Columns added after the first release. ALTER TABLE has no IF NOT EXISTS, so look first.
  const cols = new Set((db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("options")) db.exec("ALTER TABLE messages ADD COLUMN options TEXT");
  if (!cols.has("choice")) db.exec("ALTER TABLE messages ADD COLUMN choice TEXT");
  // Structured parts of a message: a ready-for-review handoff, the cost of what it asks for.
  if (!cols.has("extra")) db.exec("ALTER TABLE messages ADD COLUMN extra TEXT");
  // When a reader last got further into a thread: the "read" signal a sender sees.
  const readCols = new Set((db.query("PRAGMA table_info(reads)").all() as { name: string }[]).map((c) => c.name));
  if (!readCols.has("seen_at")) db.exec("ALTER TABLE reads ADD COLUMN seen_at TEXT");
  settleUpdates();
  return db;
}

const now = () => new Date().toISOString();
const newId = (p: string) => `${p}_${randomBytes(4).toString("hex")}`;

/* ---------- blobs ---------- */

export function putBlob(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = join(dakHome(), "blobs", sha);
  if (!existsSync(path)) writeFileSync(path, bytes);
  return sha;
}

export function blobPath(sha: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new DakError("bad_blob", "That is not a blob id.", 404);
  const path = join(dakHome(), "blobs", sha);
  if (!existsSync(path)) throw new DakError("no_blob", "No blob with that id.", 404);
  return path;
}

export const readBlobText = (sha: string) => readFileSync(blobPath(sha), "utf8");

/* ---------- readers ---------- */

export function requireReader(name: string): Reader {
  const readers = loadConfig().readers;
  const found = readers.find((r) => r.name === name.toLowerCase());
  if (!found) {
    throw new DakError(
      "unknown_reader",
      `"${name}" is not a reader. Readers: ${readers.map((r) => r.name).join(", ")}. Add one with: dak readers add <name>`,
    );
  }
  return found;
}

/* ---------- writes ---------- */

export type NewAttachment = Omit<Attachment, "id">;
export interface NewComment { attachment_id?: string | null; anchor: Anchor | null; body: string }

export function createThread(input: {
  to: string; from: string; subject: string; kind: ThreadKind; body: string; attachments: NewAttachment[]; needs_reply?: boolean; options?: string[];
  participants?: Participant[]; extra?: MessageExtra;
}): { thread: Thread; message: Message; routed?: { to: string; via: string; from_group: string } } {
  const to = String(input.to ?? "").trim().toLowerCase();
  if (!to) throw new DakError("no_reader", "Say who it is for with --to <name>.");
  // A group is its members: each one is on the thread and gets the message.
  const members = to.startsWith("group:") ? groupMembers(to.slice(6)) : null;
  if (members && !members.length) throw new DakError("unknown_group", `No group "${to.slice(6)}". Make one with: dak group set ${to.slice(6)} <name> <name>...`);
  const others = [...(members ?? []).map((m) => ({ name: m, role: "member" as Role })), ...(input.participants ?? [])];
  for (const p of others) if (!known(p.name)) throw new DakError("unknown_reader", `"${p.name}" is not a reader and has never used Dak.`);
  if (!members && !known(to)) {
    const readers = loadConfig().readers.map((r) => r.name).join(", ");
    throw new DakError("unknown_reader", `"${to}" is not a reader and has never used Dak. Readers: ${readers}. Run dak agents for every session Dak knows.`);
  }
  const from = input.from.trim().toLowerCase();
  if (!from) throw new DakError("no_sender", "Say who is sending with --from <name>.");
  // A route rule: a PR or brief from a group's member to this reader goes to someone else first.
  const route = routeFor(to, from, input.kind);
  if (route) {
    const r = createThread({ ...input, to: route.via, body: `${input.body.trim() ? input.body.trim() + "\n\n" : ""}(Sent to ${to}; ${to}'s rule sends ${route.from_group}'s PRs and briefs to ${route.via} first.)` });
    return { ...r, routed: { to, via: route.via, from_group: route.from_group } };
  }
  if (!input.subject.trim()) throw new DakError("no_subject", "A thread needs a subject.");
  const id = newId("t");
  const t = now();
  const s = store();
  const tx = s.transaction(() => {
    s.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run(id, to, from, input.subject.trim(), input.kind, input.needs_reply === false && !cleanOptions(input.options) ? "informed" : "waiting", t, t);
    for (const p of others) if (p.name !== to && p.name !== from) addParticipantRow(id, p);
    // Sent with --fyi: an update, delivered at the reader's next turn rather than interrupting it.
    const quiet = input.needs_reply === false && !cleanOptions(input.options);
    return insertMessage(id, from, input.body, null, input.attachments, [], cleanOptions(input.options), undefined, quiet ? { ...input.extra, quiet: true } : input.extra);
  });
  const messageId = tx();
  return { thread: getThreadRow(id), message: getMessage(messageId) };
}

export function addMessage(threadId: string, input: {
  author: string; body: string; verdict?: Verdict | null; attachments?: NewAttachment[]; comments?: NewComment[];
  needs_reply?: boolean; // the sender's say; left out, needsReply() decides
  options?: string[]; choice?: string; extra?: MessageExtra;
  prs?: number[]; // the PRs a verdict is about (a thread can carry several)
}): Message {
  const thread = getThreadRow(threadId);
  const author = input.author.trim().toLowerCase();
  if (!author) throw new DakError("no_author", "Say who is replying with --from <name>.");
  if (!input.body.trim() && !input.comments?.length && !input.attachments?.length && !input.verdict && !input.choice) {
    throw new DakError("empty_message", "Nothing to send: add a message, a comment, a verdict or an attachment.");
  }
  // The reader answering moves the thread to "answered". The sender writing puts it back on the
  // reader only when it needs an answer; an update leaves the thread where it was.
  // The addressee answers. A group member's ack answers a group thread. Anyone else on the
  // thread (a reviewer's findings, a watcher's note) leaves it where it stands: still on the
  // addressee if it was waiting on them.
  const other = author !== thread.from && author !== thread.to && isParticipant(threadId, author);
  const settled = thread.status === "informed" || thread.status === "closed";
  const asks = !other && author !== thread.to && needsReply(thread, input);
  const status: ThreadStatus = input.extra?.reviewing !== undefined ? thread.status // "on it" (or "stopped") is not an answer
    : author === thread.to && othersStillWaiting(threadId, author, input) ? "waiting"
    : author === thread.to ? "answered"
    : other ? (thread.to.startsWith("group:") && !settled ? "answered" : thread.status)
    : asks ? "waiting" : thread.status;
  // An update needs nothing from whoever reads it: the sender said so (--fyi, --done), or it is
  // the sender's text after an approval, or "I'm reviewing". It reaches the reader at their next
  // turn and never interrupts one or wakes an idle session. Buttons, verdicts and new versions
  // always ask.
  const quiet = !input.options?.length && !input.verdict && !input.choice && !input.attachments?.length
    && (input.needs_reply === false || input.extra?.reviewing !== undefined || (author === thread.from && !other && !asks));
  // An approval records exactly what was approved (head and diff), so a later push can be told
  // apart: the merge queue says "head moved since your approval" and whether the changes differ.
  let extra: MessageExtra | undefined = quiet ? { ...input.extra, quiet: true } : input.extra;
  // A pick on a "try it" note is the Checking result: record it plainly, with the ticket, so the
  // agent's hook and dak wait --json both say what to do (works: post the proof, move it to Done).
  if (input.choice) {
    const q = store().query("SELECT options, extra FROM messages WHERE thread_id = ? AND options IS NOT NULL ORDER BY id DESC LIMIT 1").get(threadId) as { options: string; extra: string | null } | null;
    const tryit = q?.extra ? JSON.parse(q.extra).tryit : undefined;
    if (tryit) extra = { ...extra, tryit_result: { result: JSON.parse(q!.options)[0] === input.choice ? "works" : "wrong", ...(tryit.ticket ? { ticket: tryit.ticket } : {}) } };
  }
  // A verdict names the PRs it is about. On a thread carrying several, an approval must name
  // them: "Approve" on one PR read as approving all sixteen is the mistake this refuses.
  if (input.verdict) {
    const prs = prStates(getThread(threadId).messages, []);
    const named = [...new Set(input.prs ?? [])];
    const missing = named.filter((n) => !prs.some((p) => p.number === n));
    if (missing.length) throw new DakError("no_such_pr", `This thread carries no ${missing.map((n) => `#${n}`).join(", ")}. It has ${prs.map((p) => p.key).join(", ") || "no PR"}.`);
    if (input.verdict === "approve" && !named.length && prs.length > 1) {
      throw new DakError("pick_pr", `This thread has ${prs.length} PRs (${prs.map((p) => p.key).join(", ")}). Name the ones you approve (dak reply --on 5002, or several: --on 5001,5002).`);
    }
    if (named.length) extra = { ...extra, prs: named };
    if (input.verdict === "approve") {
      // Exactly what was approved (head and diff), per PR, so a later push can be told apart.
      const targets = named.length ? prs.filter((p) => named.includes(p.number!)) : prs;
      const heads = Object.fromEntries(targets.filter((p) => p.head_sha && p.diff_blob).map((p) => [p.key, { head_sha: p.head_sha!, diff_blob: p.diff_blob! }]));
      if (Object.keys(heads).length) extra = { ...extra, approved_heads: heads, ...(targets.length === 1 && heads[targets[0].key] ? { approved: heads[targets[0].key] } : {}) };
    }
  }
  const s = store();
  const id = s.transaction(() => {
    const mid = insertMessage(threadId, author, input.body, input.verdict ?? null, input.attachments ?? [], input.comments ?? [], cleanOptions(input.options), input.choice, extra);
    s.query("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), threadId);
    return mid;
  })();
  return getMessage(id);
}

// A verdict on some of a thread's PRs leaves it waiting while another PR has no verdict yet from
// the reader: approving #2450 must not take #2451 off their list.
function othersStillWaiting(threadId: string, reader: string, input: { verdict?: Verdict | null; prs?: number[] }): boolean {
  if (!input.verdict || !input.prs?.length) return false;
  return prStates(getThread(threadId).messages, [reader]).some((p) => p.verdict === null && !input.prs!.includes(p.number!));
}

// Does a message from the sender need the reader to answer? The sender can say so (--fyi).
// Otherwise: a new version or a question does; text after the reader approved is an update
// ("merged", "running the tests"), which does not.
function needsReply(thread: Thread, input: { verdict?: Verdict | null; attachments?: NewAttachment[]; needs_reply?: boolean; options?: string[] }): boolean {
  if (input.options?.length) return true; // buttons are a question
  if (input.needs_reply !== undefined) return input.needs_reply;
  if (input.attachments?.length || input.verdict === "question") return true;
  return !approvedSince(thread.id, thread.to);
}

// The reader's last verdict was an approval, and nothing new to review has come since.
function approvedSince(threadId: string, reader: string): boolean {
  return approvedNow(getThread(threadId).messages, reader);
}

// Threads written before updates stopped counting as asks: an approved thread whose
// later messages are only updates is not waiting on anyone. Cheap, and safe to repeat.
function settleUpdates() {
  const s = db!;
  for (const t of s.query("SELECT id, to_reader FROM threads WHERE status = 'waiting'").all() as { id: string; to_reader: string }[]) {
    const last = s.query("SELECT author, verdict, options FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(t.id) as { author: string; verdict: string | null; options: string | null } | null;
    // Buttons are a question, even after an approval: those stay waiting.
    if (last && last.author !== t.to_reader && last.verdict !== "question" && !last.options && approvedSince(t.id, t.to_reader)) {
      s.query("UPDATE threads SET status = 'answered' WHERE id = ?").run(t.id);
    }
  }
}

// Buttons: short, distinct, at most six, so they fit under a message and read as a choice.
function cleanOptions(o?: string[]): string[] | undefined {
  const list = [...new Set((o ?? []).map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 6);
  return list.length ? list : undefined;
}

function insertMessage(threadId: string, author: string, body: string, verdict: Verdict | null,
  attachments: NewAttachment[], comments: NewComment[], options?: string[], choice?: string, extra?: MessageExtra): number {
  const s = store();
  const hasExtra = extra && Object.values(extra).some((v) => v !== undefined);
  const res = s.query("INSERT INTO messages (thread_id, author, body, verdict, created_at, options, choice, extra) VALUES (?,?,?,?,?,?,?,?)")
    .run(threadId, author, body, verdict, now(), options ? JSON.stringify(options) : null, choice ?? null, hasExtra ? JSON.stringify(extra) : null);
  const mid = Number(res.lastInsertRowid);
  for (const a of attachments) {
    s.query("INSERT INTO attachments VALUES (?,?,?,?,?)").run(newId("a"), mid, a.type, a.name, JSON.stringify(a.meta));
  }
  for (const c of comments) {
    if (!c.body?.trim()) continue;
    s.query("INSERT INTO comments (thread_id, message_id, attachment_id, author, anchor, body) VALUES (?,?,?,?,?,?)")
      .run(threadId, mid, c.attachment_id ?? null, author, c.anchor ? JSON.stringify(c.anchor) : null, c.body.trim());
  }
  // Your own message is read by definition.
  markRead(author, threadId, mid);
  return mid;
}

export function setStatus(threadId: string, status: ThreadStatus) {
  getThreadRow(threadId);
  store().query("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), threadId);
}

// The newest PR on a thread, swapped for a fresh snapshot of the same PR: after a rebase the
// reader sees the current head without a new version, a new message or a notification.
export function refreshPr(threadId: string, rebuild: (old: any) => any): { id: string; meta: any } {
  getThreadRow(threadId);
  const row = store().query(`SELECT a.id, a.meta FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE m.thread_id = ? AND a.type = 'pr' ORDER BY a.message_id DESC, a.rowid DESC LIMIT 1`).get(threadId) as { id: string; meta: string } | null;
  if (!row) throw new DakError("no_pr", `Thread ${threadId} has no PR to refresh.`);
  const meta = rebuild(JSON.parse(row.meta));
  store().query("UPDATE attachments SET meta = ? WHERE id = ?").run(JSON.stringify(meta), row.id);
  // The open window reloads a thread when updated_at moves; no message, so no notification.
  store().query("UPDATE threads SET updated_at = ? WHERE id = ?").run(now(), threadId);
  return { id: row.id, meta };
}

export function markRead(reader: string, threadId: string, upTo: number) {
  store().query(`INSERT INTO reads (reader, thread_id, last_seen, seen_at) VALUES (?,?,?,?) ON CONFLICT(reader, thread_id)
    DO UPDATE SET seen_at = CASE WHEN excluded.last_seen > last_seen THEN excluded.seen_at ELSE seen_at END,
      last_seen = max(last_seen, excluded.last_seen)`).run(reader, threadId, upTo, now());
}

/* ---------- archives ---------- */

// peer is an agent's name, or two agents' names joined by "+" for a conversation between them.
export function archives(reader: string): Record<string, string> {
  const rows = store().query("SELECT peer, archived_at FROM archives WHERE reader = ?").all(reader) as { peer: string; archived_at: string }[];
  return Object.fromEntries(rows.map((r) => [r.peer, r.archived_at]));
}

export function setArchived(reader: string, peer: string, on: boolean) {
  if (!peer.trim()) throw new DakError("no_peer", "Say which conversation to archive.");
  if (on) store().query("INSERT INTO archives VALUES (?,?,?) ON CONFLICT(reader, peer) DO UPDATE SET archived_at = excluded.archived_at").run(reader, peer, now());
  else store().query("DELETE FROM archives WHERE reader = ? AND peer = ?").run(reader, peer);
  return archives(reader);
}

/* ---------- pins ---------- */

// Agents the person keeps at the top of their list, in the order they pinned them.
export function pins(reader: string): Record<string, string> {
  store().exec("CREATE TABLE IF NOT EXISTS pins (reader TEXT NOT NULL, peer TEXT NOT NULL, pinned_at TEXT NOT NULL, PRIMARY KEY (reader, peer))");
  const rows = store().query("SELECT peer, pinned_at FROM pins WHERE reader = ? ORDER BY pinned_at").all(reader) as { peer: string; pinned_at: string }[];
  return Object.fromEntries(rows.map((r) => [r.peer, r.pinned_at]));
}
export function setPinned(reader: string, peer: string, on: boolean): Record<string, string> {
  if (!peer.trim()) throw new DakError("no_peer", "Say which conversation to pin.");
  pins(reader);
  if (on) store().query("INSERT INTO pins VALUES (?,?,?) ON CONFLICT(reader, peer) DO NOTHING").run(reader, peer, now());
  else store().query("DELETE FROM pins WHERE reader = ? AND peer = ?").run(reader, peer);
  return pins(reader);
}

/* ---------- reads ---------- */

function rowToThread(r: any): Thread {
  return { id: r.id, to: r.to_reader, from: r.from_name, subject: r.subject, kind: r.kind,
    status: r.status, created_at: r.created_at, updated_at: r.updated_at };
}

export function getThreadRow(id: string): Thread {
  const r = store().query("SELECT * FROM threads WHERE id = ?").get(id);
  if (!r) throw new DakError("no_thread", `No thread ${id}.`, 404);
  return rowToThread(r);
}

function hydrate(rows: any[]): Message[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const atts = store().query(`SELECT a.*, (h.attachment_id IS NOT NULL) AS hidden FROM attachments a LEFT JOIN hidden_attachments h ON h.attachment_id = a.id
    WHERE a.message_id IN (${marks})`).all(...ids) as any[];
  const coms = store().query(`SELECT * FROM comments WHERE message_id IN (${marks}) ORDER BY id`).all(...ids) as any[];
  return rows.map((r) => ({
    id: r.id, thread_id: r.thread_id, author: r.author, body: r.body, verdict: r.verdict, created_at: r.created_at,
    ...(r.options ? { options: JSON.parse(r.options) } : {}), ...(r.choice ? { choice: r.choice } : {}),
    ...(r.extra ? JSON.parse(r.extra) : {}),
    attachments: atts.filter((a) => a.message_id === r.id)
      .map((a) => ({ id: a.id, type: a.type, name: a.name, meta: JSON.parse(a.meta), ...(a.hidden ? { hidden: true } : {}) }) as Attachment),
    comments: coms.filter((c) => c.message_id === r.id).map((c) => ({
      id: c.id, thread_id: c.thread_id, message_id: c.message_id, attachment_id: c.attachment_id,
      author: c.author, anchor: c.anchor ? JSON.parse(c.anchor) : null, body: c.body,
    }) as Comment),
  }));
}

export function getMessage(id: number): Message {
  const r = store().query("SELECT * FROM messages WHERE id = ?").get(id);
  if (!r) throw new DakError("no_message", `No message ${id}.`, 404);
  return hydrate([r])[0];
}

export interface ReadMark { reader: string; up_to: number; seen_at: string | null }

// Who has read how far, so a sender can tell "not opened yet" from "read, no answer".
// A reader's own messages count as read, so only readers other than the author show.
export function getThread(id: string): { thread: Thread; messages: Message[]; reads: ReadMark[]; participants: Participant[]; prs: PrState[] } {
  const thread = getThreadRow(id);
  const rows = store().query("SELECT * FROM messages WHERE thread_id = ? ORDER BY id").all(id) as any[];
  const reads = store().query("SELECT reader, last_seen AS up_to, seen_at FROM reads WHERE thread_id = ? ORDER BY reader").all(id) as ReadMark[];
  const participants = participantsOf(id);
  const messages = hydrate(rows);
  // Each PR on the thread with its own verdict, from the addressee or anyone added as approver:
  // what an agent reads to know which PRs are approved.
  const deciders = [thread.to, ...participants.filter((p) => p.role === "approver").map((p) => p.name)];
  return { thread, messages, reads, participants, prs: prStates(messages, deciders) };
}

// Take an attachment off its topic, or put it back. It is never deleted: the message still says
// it was sent, and Restore brings it back.
export function setAttachmentHidden(threadId: string, attId: string, by: string, hidden: boolean) {
  const ok = store().query(`SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND m.thread_id = ?`).get(attId, threadId);
  if (!ok) throw new DakError("no_attachment", "That attachment is not on this thread.", 404);
  if (hidden) store().query("INSERT OR REPLACE INTO hidden_attachments VALUES (?,?,?)").run(attId, by, now());
  else store().query("DELETE FROM hidden_attachments WHERE attachment_id = ?").run(attId);
}

// The newest thread carrying PR #n, for a stacked PR's link to the one below it.
export function threadForPr(n: number): string | null {
  const r = store().query(`SELECT m.thread_id FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE a.type = 'pr' AND json_extract(a.meta, '$.number') = ? ORDER BY a.message_id DESC LIMIT 1`).get(n) as { thread_id: string } | null;
  return r?.thread_id ?? null;
}

/* ---------- participants and groups ---------- */

export function participantsOf(threadId: string): Participant[] {
  return store().query("SELECT name, role FROM participants WHERE thread_id = ? ORDER BY rowid").all(threadId) as Participant[];
}
const isParticipant = (threadId: string, name: string) =>
  !!store().query("SELECT 1 FROM participants WHERE thread_id = ? AND name = ?").get(threadId, name);
function addParticipantRow(threadId: string, p: Participant) {
  store().query("INSERT INTO participants VALUES (?,?,?) ON CONFLICT(thread_id, name) DO UPDATE SET role = excluded.role")
    .run(threadId, p.name.toLowerCase(), p.role);
}

// Bring someone onto a thread that already exists: the reviewer once the PR is up, say.
// They get the whole thread as unread mail, so they start from the beginning.
export function addParticipant(threadId: string, p: Participant): Participant[] {
  const t = getThreadRow(threadId);
  if (!ROLES.includes(p.role)) throw new DakError("bad_role", `Role must be one of: ${ROLES.join(", ")}.`);
  if (!known(p.name)) throw new DakError("unknown_reader", `"${p.name}" is not a reader and has never used Dak.`);
  if (p.name !== t.to && p.name !== t.from) addParticipantRow(threadId, p);
  return participantsOf(threadId);
}

/* ---------- routes ---------- */

// "PRs and briefs that engineers send to pratik go to atlas": the reader's own way of saying who
// reviews first. Only new PR and doc threads are routed; replies, notes and questions are not,
// so anything on a thread the person is already on still reaches them.
export interface Route { to_reader: string; from_group: string; via: string }
function ensureRoutes() {
  store().exec("CREATE TABLE IF NOT EXISTS routes (to_reader TEXT NOT NULL, from_group TEXT NOT NULL, via TEXT NOT NULL, PRIMARY KEY (to_reader, from_group))");
}
export function routes(): Route[] { ensureRoutes(); return store().query("SELECT * FROM routes ORDER BY to_reader, from_group").all() as Route[]; }
export function setRoute(to: string, fromGroup: string, via: string | null): Route[] {
  ensureRoutes();
  const t = to.trim().toLowerCase(), g = fromGroup.trim().toLowerCase().replace(/^group:/, ""), v = via?.trim().toLowerCase() ?? null;
  if (v === null) { store().query("DELETE FROM routes WHERE to_reader = ? AND from_group = ?").run(t, g); return routes(); }
  if (!groupMembers(g).length) throw new DakError("unknown_group", `No group "${g}". Make one with: dak group set ${g} <name>...`);
  if (!known(t) || !known(v)) throw new DakError("unknown_reader", `Both ${t} and ${v} must be readers or have used Dak.`);
  if (t === v) throw new DakError("bad_route", "A route sends to someone else.");
  store().query("INSERT INTO routes VALUES (?,?,?) ON CONFLICT(to_reader, from_group) DO UPDATE SET via = excluded.via").run(t, g, v);
  return routes();
}
function routeFor(to: string, from: string, kind: ThreadKind): Route | null {
  if (kind !== "pr" && kind !== "doc") return null;
  ensureRoutes();
  for (const r of store().query("SELECT * FROM routes WHERE to_reader = ?").all(to) as Route[]) {
    if (r.via !== from && groupMembers(r.from_group).includes(from)) return r;
  }
  return null;
}

export function groupMembers(name: string): string[] {
  return (store().query("SELECT member FROM groups WHERE name = ? ORDER BY member").all(name.toLowerCase()) as { member: string }[]).map((r) => r.member);
}
export function groups(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of store().query("SELECT name, member FROM groups ORDER BY name, member").all() as { name: string; member: string }[]) (out[r.name] ??= []).push(r.member);
  return out;
}
export function setGroup(name: string, members: string[]): string[] {
  const n = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(n)) throw new DakError("bad_group", "A group name is letters, digits, - and _.");
  const list = [...new Set(members.map((m) => m.trim().toLowerCase()).filter(Boolean))];
  for (const m of list) if (!known(m)) throw new DakError("unknown_reader", `"${m}" is not a reader and has never used Dak.`);
  const s = store();
  s.transaction(() => {
    s.query("DELETE FROM groups WHERE name = ?").run(n);
    for (const m of list) s.query("INSERT INTO groups VALUES (?,?)").run(n, m);
  })();
  return list;
}

// Every button a reader has picked: a decision, with the question it answered, to cite later.
export interface Decision { thread_id: string; subject: string; asked_by: string; question: string; choice: string; decided_at: string; cost?: Cost }
export function decisions(reader: string): Decision[] {
  const rows = store().query(`SELECT m.thread_id, t.subject, m.choice, m.created_at,
      q.author AS asked_by, q.body AS question, q.extra AS q_extra
    FROM messages m JOIN threads t ON t.id = m.thread_id
    LEFT JOIN messages q ON q.id = (SELECT max(id) FROM messages WHERE thread_id = m.thread_id AND id < m.id AND options IS NOT NULL)
    WHERE m.author = ? AND m.choice IS NOT NULL ORDER BY m.id DESC`).all(reader) as any[];
  return rows.map((r) => ({ thread_id: r.thread_id, subject: r.subject, asked_by: r.asked_by ?? "", question: r.question ?? "", choice: r.choice, decided_at: r.created_at,
    ...(r.q_extra && JSON.parse(r.q_extra).cost ? { cost: JSON.parse(r.q_extra).cost } : {}) }));
}

export interface ThreadSummary extends Thread { unread: number; last_body: string; last_author: string; message_count: number; participants: string[]; reviewing_since: string | null }

// When the addressee said "I'm reviewing" and has neither given a verdict nor said they stopped since.
const REVIEWING = `(SELECT CASE WHEN r.extra LIKE '%"reviewing":true%' THEN r.created_at END FROM messages r
  WHERE r.thread_id = t.id AND r.author = t.to_reader AND r.extra LIKE '%"reviewing":%'
  AND r.id > coalesce((SELECT max(id) FROM messages v WHERE v.thread_id = t.id AND v.author = t.to_reader AND v.verdict IS NOT NULL), 0)
  ORDER BY r.id DESC LIMIT 1)`;

// "I'm reviewing" (or "stopped reviewing"), on the whole topic or on the PRs named: the sender
// hears it as an update, and the topic stays waiting on the reader either way.
export function setReviewing(threadId: string, author: string, opts: { prs?: number[]; stop?: boolean; body?: string } = {}): Message {
  const on = opts.prs?.length ? ` ${opts.prs.map((n) => `#${n}`).join(", ")}` : "";
  const body = opts.body?.trim() || (opts.stop ? `Stopped reviewing${on || " this"} for now; it is still waiting on me.` : `Reviewing${on || " this"} now.`);
  return addMessage(threadId, { author, body, needs_reply: false, extra: { reviewing: !opts.stop, ...(opts.prs?.length ? { prs: opts.prs } : {}) } });
}

// On the thread: its sender, its addressee, or anyone else added to it.
const ON = `(t.to_reader = $r OR t.from_name = $r OR EXISTS (SELECT 1 FROM participants p WHERE p.thread_id = t.id AND p.name = $r))`;

// A reader's threads: the ones addressed to them, and the ones they started.
// "others" is every thread the reader is not part of: agents writing to each other, which the person may read.
export function listThreads(reader: string, opts: { box?: "to" | "from" | "all" | "others"; limit?: number } = {}): ThreadSummary[] {
  const box = opts.box ?? "all";
  const where = box === "to" ? "t.to_reader = $r" : box === "from" ? "t.from_name = $r"
    : box === "others" ? `NOT ${ON}` : ON;
  return (store().query(`
    SELECT t.*,
      (SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND m.author != $r
         AND m.id > coalesce((SELECT last_seen FROM reads WHERE reader = $r AND thread_id = t.id), 0)) AS unread,
      (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
      (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT author FROM messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_author,
      (SELECT json_group_array(name) FROM participants p WHERE p.thread_id = t.id) AS participants,
      ${REVIEWING} AS reviewing_since
    FROM threads t WHERE ${where} ORDER BY t.updated_at DESC LIMIT $limit`)
    .all({ $r: reader, $limit: opts.limit ?? 200 }) as any[])
    .map((r) => ({ ...rowToThread(r), unread: r.unread, message_count: r.message_count, last_body: r.last_body ?? "", last_author: r.last_author ?? "", participants: JSON.parse(r.participants ?? "[]"), reviewing_since: r.reviewing_since ?? null }));
}

// PRs waiting on a person's review, oldest first, and whether they have said they are on it.
export interface PrSize { files: number; additions: number; deletions: number }
export interface AwaitingReview { thread_id: string; subject: string; from: string; pr: number | null; waiting_since: string; reviewing_since: string | null; size: PrSize | null }
/* Everything waiting on the person, with what kind of answer it needs:
     pr: a PR to review (a new version since any approval);
     brief: a doc, a spec, a mock to read and approve;
     decision: a question with buttons, or a question asked after they approved.
   Updates (FYIs), closed topics, and PRs they approved that only wait to merge are not here:
   the merge queue holds those. An agent can name the type itself (--type), which wins. */
export type ReviewType = "pr" | "brief" | "decision" | "tryit";
export function awaitingReview(reader: string, typed: Map<string, string> = new Map()): (AwaitingReview & { type: ReviewType })[] {
  const rows = store().query(`SELECT t.id AS thread_id, t.kind, t.subject, t.from_name AS "from", t.updated_at AS waiting_since, ${REVIEWING} AS reviewing_since
    FROM threads t WHERE t.to_reader = ? AND t.status = 'waiting' ORDER BY t.updated_at`).all(reader) as any[];
  return rows.map((r) => {
    const p = latestPr(r.thread_id);
    const { kind: _k, ...rest } = r;
    return { ...rest, pr: p?.number ?? null, size: p?.size ?? null, type: (typed.get(r.thread_id) as ReviewType) ?? reviewTypeOf(r.thread_id, r.kind, reader) };
  });
}

function reviewTypeOf(threadId: string, kind: string, reader: string): ReviewType {
  const msgs = store().query(`SELECT m.id, m.author, m.verdict, m.options,
      (SELECT group_concat(a.type) FROM attachments a WHERE a.message_id = m.id) AS atts
    FROM messages m WHERE m.thread_id = ? ORDER BY m.id`).all(threadId) as { id: number; author: string; verdict: string | null; options: string | null; atts: string | null }[];
  const last = [...msgs].reverse().find((m) => m.author !== reader);
  // A PR waiting for its review is a PR, whatever buttons came with it, and however the thread began.
  if (kind === "pr" || msgs.some((m) => m.author !== reader && (m.atts ?? "").includes("pr"))) {
    // Once every PR on it is approved, only a new version is a PR to review again; anything else is a question.
    return approvedSince(threadId, reader) ? "decision" : "pr";
  }
  if (last?.options) return "decision"; // buttons are a choice
  if (kind === "doc" || /link|file/.test(last?.atts ?? "")) return "brief";
  return "decision";
}

// The newest PR on a thread: its number and how big it is, so a reader can tell a ten-line
// fix from a four-hundred-line change before opening either.
export function latestPr(threadId: string): { number: number | null; size: PrSize } | null {
  const row = store().query(`SELECT a.meta FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE m.thread_id = ? AND a.type = 'pr' ORDER BY a.message_id DESC LIMIT 1`).get(threadId) as { meta: string } | null;
  if (!row) return null;
  const meta = JSON.parse(row.meta);
  const files = (meta.files ?? []) as { additions: number; deletions: number }[];
  return { number: meta.number ?? null, size: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) } };
}

// Messages a reader has not seen yet, oldest first. Reading them can mark them read,
// and a thread's sender reading the reply is what "picked up" means.
export function takeUnread(reader: string, opts: { threadId?: string; peek?: boolean } = {}): Message[] {
  const rows = store().query(`
    SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE ${ON} AND m.author != $r
      AND ($t IS NULL OR t.id = $t)
      AND m.id > coalesce((SELECT last_seen FROM reads WHERE reader = $r AND thread_id = t.id), 0)
    ORDER BY m.id`).all({ $r: reader, $t: opts.threadId ?? null }) as any[];
  const msgs = hydrate(rows);
  if (!opts.peek) {
    for (const m of msgs) {
      markRead(reader, m.thread_id, m.id);
      const t = getThreadRow(m.thread_id);
      if (t.from === reader && t.status === "answered") setStatus(t.id, "picked_up");
    }
  }
  return msgs;
}

// Search across every conversation: message text, thread subjects, and what is attached
// (file names, PR titles, chapter notes). Newest first, one hit per message.
export interface SearchHit { thread_id: string; subject: string; to: string; from: string; message_id: number; author: string; created_at: string; text: string }
export function search(q: string, limit = 60): SearchHit[] {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  return store().query(`
    SELECT t.id AS thread_id, t.subject, t.to_reader AS "to", t.from_name AS "from", m.id AS message_id, m.author, m.created_at,
      CASE WHEN m.body LIKE $q ESCAPE '\\' THEN m.body
           WHEN t.subject LIKE $q ESCAPE '\\' THEN t.subject
           ELSE coalesce((SELECT a.name || ' ' || a.meta FROM attachments a WHERE a.message_id = m.id AND (a.name LIKE $q ESCAPE '\\' OR a.meta LIKE $q ESCAPE '\\') LIMIT 1), m.body) END AS text
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.body LIKE $q ESCAPE '\\' OR t.subject LIKE $q ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND (a.name LIKE $q ESCAPE '\\' OR a.meta LIKE $q ESCAPE '\\'))
    ORDER BY m.id DESC LIMIT $limit`).all({ $q: like, $limit: limit }) as SearchHit[];
}

export function latestMessageId(): number {
  return (store().query("SELECT coalesce(max(id), 0) AS id FROM messages").get() as any).id;
}
