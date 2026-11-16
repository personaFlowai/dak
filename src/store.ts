import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { dakHome, loadConfig } from "./config";
import type {
  Anchor, Attachment, Comment, Message, Reader, Thread, ThreadKind, ThreadStatus, Verdict,
} from "./types";
import { DakError } from "./types";
import { known } from "./presence";

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
    CREATE TABLE IF NOT EXISTS archives (
      reader TEXT NOT NULL, peer TEXT NOT NULL, archived_at TEXT NOT NULL,
      PRIMARY KEY (reader, peer));
  `);
  // Columns added after the first release. ALTER TABLE has no IF NOT EXISTS, so look first.
  const cols = new Set((db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("options")) db.exec("ALTER TABLE messages ADD COLUMN options TEXT");
  if (!cols.has("choice")) db.exec("ALTER TABLE messages ADD COLUMN choice TEXT");
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
}): { thread: Thread; message: Message } {
  const to = String(input.to ?? "").trim().toLowerCase();
  if (!to) throw new DakError("no_reader", "Say who it is for with --to <name>.");
  if (!known(to)) {
    const readers = loadConfig().readers.map((r) => r.name).join(", ");
    throw new DakError("unknown_reader", `"${to}" is not a reader and has never used Dak. Readers: ${readers}. Run dak agents for every session Dak knows.`);
  }
  const from = input.from.trim().toLowerCase();
  if (!from) throw new DakError("no_sender", "Say who is sending with --from <name>.");
  if (!input.subject.trim()) throw new DakError("no_subject", "A thread needs a subject.");
  const id = newId("t");
  const t = now();
  const s = store();
  const tx = s.transaction(() => {
    s.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run(id, to, from, input.subject.trim(), input.kind, input.needs_reply === false && !cleanOptions(input.options) ? "informed" : "waiting", t, t);
    return insertMessage(id, from, input.body, null, input.attachments, [], cleanOptions(input.options));
  });
  const messageId = tx();
  return { thread: getThreadRow(id), message: getMessage(messageId) };
}

export function addMessage(threadId: string, input: {
  author: string; body: string; verdict?: Verdict | null; attachments?: NewAttachment[]; comments?: NewComment[];
  needs_reply?: boolean; // the sender's say; left out, needsReply() decides
  options?: string[]; choice?: string;
}): Message {
  const thread = getThreadRow(threadId);
  const author = input.author.trim().toLowerCase();
  if (!author) throw new DakError("no_author", "Say who is replying with --from <name>.");
  if (!input.body.trim() && !input.comments?.length && !input.attachments?.length && !input.verdict && !input.choice) {
    throw new DakError("empty_message", "Nothing to send: add a message, a comment, a verdict or an attachment.");
  }
  // The reader answering moves the thread to "answered". The sender writing puts it back on the
  // reader only when it needs an answer; an update leaves the thread where it was.
  const status: ThreadStatus = author === thread.to ? "answered"
    : needsReply(thread, input) ? "waiting" : thread.status;
  const s = store();
  const id = s.transaction(() => {
    const mid = insertMessage(threadId, author, input.body, input.verdict ?? null, input.attachments ?? [], input.comments ?? [], cleanOptions(input.options), input.choice);
    s.query("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), threadId);
    return mid;
  })();
  return getMessage(id);
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
  const rows = store().query(`SELECT m.author, m.verdict, (SELECT count(*) FROM attachments a WHERE a.message_id = m.id) AS atts
    FROM messages m WHERE m.thread_id = ? ORDER BY m.id`).all(threadId) as { author: string; verdict: string | null; atts: number }[];
  let approved = false;
  for (const r of rows) {
    if (r.author === reader && r.verdict) approved = r.verdict === "approve";
    else if (r.author !== reader && r.atts > 0) approved = false;
  }
  return approved;
}

// Threads written before updates stopped counting as asks: an approved thread whose
// later messages are only updates is not waiting on anyone. Cheap, and safe to repeat.
function settleUpdates() {
  const s = db!;
  for (const t of s.query("SELECT id, to_reader FROM threads WHERE status = 'waiting'").all() as { id: string; to_reader: string }[]) {
    const last = s.query("SELECT author, verdict FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(t.id) as { author: string; verdict: string | null } | null;
    if (last && last.author !== t.to_reader && last.verdict !== "question" && approvedSince(t.id, t.to_reader)) {
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
  attachments: NewAttachment[], comments: NewComment[], options?: string[], choice?: string): number {
  const s = store();
  const res = s.query("INSERT INTO messages (thread_id, author, body, verdict, created_at, options, choice) VALUES (?,?,?,?,?,?,?)")
    .run(threadId, author, body, verdict, now(), options ? JSON.stringify(options) : null, choice ?? null);
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

export function markRead(reader: string, threadId: string, upTo: number) {
  store().query(`INSERT INTO reads VALUES (?,?,?) ON CONFLICT(reader, thread_id)
    DO UPDATE SET last_seen = max(last_seen, excluded.last_seen)`).run(reader, threadId, upTo);
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
  const atts = store().query(`SELECT * FROM attachments WHERE message_id IN (${marks})`).all(...ids) as any[];
  const coms = store().query(`SELECT * FROM comments WHERE message_id IN (${marks}) ORDER BY id`).all(...ids) as any[];
  return rows.map((r) => ({
    id: r.id, thread_id: r.thread_id, author: r.author, body: r.body, verdict: r.verdict, created_at: r.created_at,
    ...(r.options ? { options: JSON.parse(r.options) } : {}), ...(r.choice ? { choice: r.choice } : {}),
    attachments: atts.filter((a) => a.message_id === r.id)
      .map((a) => ({ id: a.id, type: a.type, name: a.name, meta: JSON.parse(a.meta) }) as Attachment),
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

export function getThread(id: string): { thread: Thread; messages: Message[] } {
  const thread = getThreadRow(id);
  const rows = store().query("SELECT * FROM messages WHERE thread_id = ? ORDER BY id").all(id) as any[];
  return { thread, messages: hydrate(rows) };
}

export interface ThreadSummary extends Thread { unread: number; last_body: string; last_author: string; message_count: number }

// A reader's threads: the ones addressed to them, and the ones they started.
// "others" is every thread the reader is not part of: agents writing to each other, which the person may read.
export function listThreads(reader: string, opts: { box?: "to" | "from" | "all" | "others"; limit?: number } = {}): ThreadSummary[] {
  const box = opts.box ?? "all";
  const where = box === "to" ? "t.to_reader = $r" : box === "from" ? "t.from_name = $r"
    : box === "others" ? "(t.to_reader != $r AND t.from_name != $r)" : "(t.to_reader = $r OR t.from_name = $r)";
  return (store().query(`
    SELECT t.*,
      (SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND m.author != $r
         AND m.id > coalesce((SELECT last_seen FROM reads WHERE reader = $r AND thread_id = t.id), 0)) AS unread,
      (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
      (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT author FROM messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_author
    FROM threads t WHERE ${where} ORDER BY t.updated_at DESC LIMIT $limit`)
    .all({ $r: reader, $limit: opts.limit ?? 200 }) as any[])
    .map((r) => ({ ...rowToThread(r), unread: r.unread, message_count: r.message_count, last_body: r.last_body ?? "", last_author: r.last_author ?? "" }));
}

// Messages a reader has not seen yet, oldest first. Reading them can mark them read,
// and a thread's sender reading the reply is what "picked up" means.
export function takeUnread(reader: string, opts: { threadId?: string; peek?: boolean } = {}): Message[] {
  const rows = store().query(`
    SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE (t.to_reader = $r OR t.from_name = $r) AND m.author != $r
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
