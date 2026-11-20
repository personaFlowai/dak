/* The main topic: one topic per conversation (you and an agent, or a group) that never closes,
   for everything that is not a piece of work. A message with no topic picked goes there, so quick
   questions stop turning into topics of their own. Work gets a topic of its own: "Make it work"
   on any message makes a piece, moves that message into the piece's topic, and leaves a line in
   the main topic pointing there. */
import { loadConfig, person } from "./config";
import { addMessage, createThread, getMessage, getThreadRow, newId, store, type NewAttachment } from "./store";
import { addWork, assignWork, getWork, type WorkItem } from "./work";
import { DakError } from "./types";

function ensure() {
  store().exec("CREATE TABLE IF NOT EXISTS main_topics (thread_id TEXT PRIMARY KEY, peer TEXT NOT NULL UNIQUE)");
}
// Who a main topic is with: the group, or the agent on the other side of the person.
const peerKey = (to: string, from: string, me: string) => (to.startsWith("group:") ? to : to === me ? from : to);

export function mainTopics(): { thread_id: string; peer: string }[] {
  ensure();
  return store().query("SELECT thread_id, peer FROM main_topics").all() as { thread_id: string; peer: string }[];
}
export const isMain = (threadId: string) => { ensure(); return !!store().query("SELECT 1 FROM main_topics WHERE thread_id = ?").get(threadId); };

// Write in the main topic with an agent or a group, starting it the first time.
export function postToMain(input: { to: string; body: string; by: string; attachments?: NewAttachment[] }): { thread_id: string; message_id: number } {
  ensure();
  const me = person(loadConfig());
  const to = input.to.trim().toLowerCase();
  const peer = peerKey(to, input.by, me);
  const had = store().query("SELECT thread_id FROM main_topics WHERE peer = ?").get(peer) as { thread_id: string } | null;
  if (had) { const m = addMessage(had.thread_id, { author: input.by, body: input.body, attachments: input.attachments ?? [] }); return { thread_id: had.thread_id, message_id: m.id }; }
  const { thread, message } = createThread({ to, from: input.by, subject: "Main", kind: "note", body: input.body, attachments: input.attachments ?? [] });
  store().query("INSERT INTO main_topics VALUES (?, ?)").run(thread.id, peer);
  return { thread_id: thread.id, message_id: message.id };
}

/* "Make it work": a piece from a message. The message moves into the piece's own topic, between
   the same people, and the topic it came from keeps a line saying where it went. With an owner,
   the piece is assigned (and the agent told there); without one it waits, not assigned. */
export function workFromMessage(messageId: number, input: { title: string; kind?: string; owner?: string | null; ticket?: string | null; by: string }): { work: WorkItem; thread_id: string } {
  const me = person(loadConfig());
  if (input.by !== me) throw new DakError("not_yours", `Only ${me} makes work from a message.`, 403);
  const m = getMessage(messageId);
  const from = getThreadRow(m.thread_id);
  const title = input.title?.trim() || m.body.split("\n").find((l) => l.trim())?.slice(0, 100) || "";
  const w = addWork({ title, kind: input.kind ?? "code", owner: "", ticket: input.ticket ?? null, by: me });
  const id = newId("t"), t = new Date().toISOString();
  const s = store();
  s.transaction(() => {
    s.query("INSERT INTO threads (id, to_reader, from_name, subject, kind, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, from.to, from.from, `${w.id}: ${w.title}`.slice(0, 200), "note", "informed", t, t);
    s.query("INSERT INTO participants (thread_id, name, role) SELECT ?, name, role FROM participants WHERE thread_id = ?").run(id, from.id);
    s.query("UPDATE messages SET thread_id = ? WHERE id = ?").run(id, messageId);
    s.query("UPDATE comments SET thread_id = ? WHERE message_id = ?").run(id, messageId);
    // Whoever had read the message where it was has read it here too.
    s.query("INSERT INTO reads (reader, thread_id, last_seen) SELECT reader, ?, ? FROM reads WHERE thread_id = ? AND last_seen >= ?").run(id, messageId, from.id, messageId);
    s.query("UPDATE work SET thread_id = ? WHERE id = ?").run(id, Number(w.id.slice(2)));
  })();
  addMessage(from.id, { author: me, body: `Made ${w.id} from a message; it moved to its own topic.`, needs_reply: false, extra: { moved: { work: w.id, thread: id } } as any });
  const owner = input.owner?.trim().toLowerCase();
  const work = owner ? assignWork(w.id, owner, me) : getWork(w.id);
  return { work, thread_id: id };
}
