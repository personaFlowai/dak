/* One conversation per agent. Underneath, every PR, doc or note is still its own
   thread, so a reply reaches the agent on the right piece of work with its anchors.
   On screen, all threads with one agent read as one timeline, split into topics. */
import { api } from "./api";
import { S, me, esc, name, mark, when, agentOf, standing, looking, type Summary } from "./state";
import { I } from "./icons";

// Where typed text is kept: per topic, or per agent while starting a new one.
export const draftKey = () => (S.newTopic ? `new:${S.peer}` : S.cur ?? "");
import type { Message, Participant, Thread } from "../src/types";
import type { ReadMark } from "../src/store";

export type Topic = { thread: Thread; messages: Message[]; participants?: Participant[]; reads?: ReadMark[] };

// Who a thread is with, from your side. A thread between two agents belongs to the pair, "atlas+mitra".
// A thread you were added to (as reviewer, approver, watcher) belongs with whoever started it.
export const peerOf = (t: Pick<Thread, "to" | "from"> & { participants?: string[] }) =>
  t.to === me ? t.from : t.from === me ? t.to : t.participants?.includes(me) ? t.from : [t.from, t.to].sort().join("+");
export const onThread = (t: Pick<Thread, "to" | "from"> & { participants?: string[] }) => t.to === me || t.from === me || !!t.participants?.includes(me);
export const isPair = (peer: string | null) => !!peer?.includes("+");
export const peerName = (peer: string) => peer.split("+").map(name).join(" and ");
export const everyThread = () => [...S.threads, ...S.others];

// Archived until someone other than you writes in it after you archived it; then it is back.
export function isArchived(peer: string): boolean {
  const at = S.archived[peer];
  if (!at) return false;
  return !everyThread().some((t) => peerOf(t) === peer && t.updated_at > at && t.last_author && t.last_author !== me);
}

const archiveBtn = (peer: string) => `<button class="arch icon-btn" data-archive="${esc(peer)}" title="Archive (E)" aria-label="Archive this conversation">${I.archive}</button>`;

export interface Peer { name: string; latest: Summary; waiting: number; unread: number; topics: number }

// The sidebar rows: one per agent, newest first. Only your own threads count.
export function peers(): Peer[] {
  const by = new Map<string, Peer>();
  for (const t of S.threads) {
    if (!onThread(t)) continue;
    const n = peerOf(t);
    const p = by.get(n) ?? { name: n, latest: t, waiting: 0, unread: 0, topics: 0 };
    if (t.updated_at > p.latest.updated_at) p.latest = t;
    if (t.to === me && t.status === "waiting") p.waiting++;
    p.unread += t.unread;
    p.topics++;
    by.set(n, p);
  }
  return [...by.values()].filter((p) => !isArchived(p.name)).sort((a, b) => b.latest.updated_at.localeCompare(a.latest.updated_at));
}

// Agents writing to each other: one row per pair, read-only.
export function pairList(): string {
  const by = new Map<string, Summary>();
  for (const t of S.others) { if (onThread(t)) continue; const k = peerOf(t); const cur = by.get(k); if (!cur || t.updated_at > cur.updated_at) by.set(k, t); }
  const rows = [...by].filter(([k]) => !isArchived(k)).sort((a, b) => b[1].updated_at.localeCompare(a[1].updated_at));
  if (!rows.length) return "";
  return `<div class="side-head sub">Between agents</div>${rows.map(([k, t]) => {
    const [a, b] = k.split("+");
    return `<div class="row-wrap" role="listitem"><button class="item pair" data-peer="${esc(k)}" aria-current="${S.view === "thread" && S.peer === k}">
      <span class="top"><span class="marks">${mark(a, "sm")}${mark(b, "sm")}</span><span class="who">${esc(peerName(k))}</span><time>${when(t.updated_at)}</time></span>
      <span class="subj">${esc(t.subject)}</span></button>${archiveBtn(k)}</div>`;
  }).join("")}`;
}

export function peerList(): string {
  const list = peers();
  if (!list.length) return `<p class="empty">Nothing yet. Agents send here with <code>dak send --to ${esc(me)}</code>, or start one with the pencil above.</p>`;
  // Pinned agents first, in the order you pinned them; the rest newest first.
  const pinned = list.filter((p) => S.pins[p.name]).sort((a, b) => S.pins[a.name].localeCompare(S.pins[b.name]));
  const rest = list.filter((p) => !S.pins[p.name]);
  const rows = (ps: Peer[]) => ps.map(peerRow).join("");
  return pinned.length ? `<div class="side-head sub">Pinned</div>${rows(pinned)}<div class="side-head sub">Others</div>${rows(rest)}` : rows(rest);
}

function peerRow(p: Peer): string {
  {
    const about = agentOf(p.name)?.about;
    // The row names what needs you, not whatever moved last (a topic just closed, say).
    const shown = S.threads.find((t) => t.id === topicFor(p.name)) ?? p.latest;
    const state = p.waiting ? `<span class="you">${p.waiting} waiting on you</span>` : p.topics > 1 ? `${p.topics} topics` : "";
    return `<div class="row-wrap" role="listitem"><button class="item ${p.unread ? "unread" : ""}" data-peer="${esc(p.name)}" aria-current="${S.view === "thread" && S.peer === p.name}">
      <span class="top">${mark(p.name, "sm")}<span class="who">${esc(name(p.name))}</span><time>${when(p.latest.updated_at)}</time></span>
      <span class="subj">${esc(shown.subject)}</span>
      <span class="sub">${[state, about ? esc(about) : ""].filter(Boolean).join(" · ")}</span></button>${pinBtn(p.name)}${archiveBtn(p.name)}</div>`;
  }
}

const pinBtn = (peer: string) => S.pins[peer]
  ? `<button class="pin icon-btn on" data-unpin="${esc(peer)}" title="Unpin" aria-label="Unpin">${I.pin}</button>`
  : `<button class="pin icon-btn" data-pin="${esc(peer)}" title="Pin to the top" aria-label="Pin to the top">${I.pin}</button>`;

// Put-away conversations, at the foot of the list, folded until you open the section.
export function archivedList(): string {
  const names = Object.keys(S.archived).filter(isArchived);
  if (!names.length) return "";
  const latest = (peer: string) => everyThread().filter((t) => peerOf(t) === peer).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const rows = S.showArchived ? names.map((n) => ({ n, t: latest(n) })).filter((x) => x.t).sort((a, b) => b.t.updated_at.localeCompare(a.t.updated_at)).map(({ n, t }) =>
    `<div class="row-wrap" role="listitem"><button class="item archived" data-peer="${esc(n)}" aria-current="${S.view === "thread" && S.peer === n}">
      <span class="top">${isPair(n) ? "" : mark(n, "sm")}<span class="who">${esc(isPair(n) ? peerName(n) : name(n))}</span><time>${when(t.updated_at)}</time></span>
      <span class="subj">${esc(t.subject)}</span></button>
      <button class="arch icon-btn" data-unarchive="${esc(n)}" title="Move back to the Inbox" aria-label="Unarchive">${I.lineUp}</button></div>`).join("") : "";
  return `<button class="side-head sub fold" data-show-archived aria-expanded="${S.showArchived}">${I.next}Archived <span class="count">${names.length}</span></button>${rows}`;
}

// The topic to open when you click an agent: the newest one waiting on you, else the newest open one.
export function topicFor(peer: string): string | null {
  const mine = everyThread().filter((t) => peerOf(t) === peer);
  return (mine.find((t) => t.to === me && t.status === "waiting") ?? mine.find((t) => t.status !== "closed") ?? mine[0])?.id ?? null;
}

// Load every topic with the current agent (the newest S.topicCap of them), reusing
// what is already loaded unless it changed. Reading them marks them read: they are on screen.
const cache = new Map<string, Topic>();
// Coming back to the window: read the open conversation again, now as seen.
export const forgetConvo = () => cache.clear();
export async function loadConvo() {
  if (!S.peer || !S.data) { S.convo = []; return; }
  const all = everyThread().filter((t) => peerOf(t) === S.peer);
  // The newest topics, plus every topic waiting on you however old: the cap trims history,
  // never something that needs you.
  const needsYou = (t: Summary) => t.to === me && t.status === "waiting";
  const shown = [...all.slice(0, S.topicCap), ...all.slice(S.topicCap).filter(needsYou)];
  if (!shown.some((t) => t.id === S.cur)) shown.push(S.data.thread as Summary);
  S.olderTopics = all.length - shown.length;
  cache.set(S.data.thread.id, S.data);
  S.convo = await Promise.all(shown.map(async (t) => {
    const hit = cache.get(t.id);
    if (hit && hit.thread.updated_at === t.updated_at) return hit;
    // Reading agents' mail does not mark it read for them.
    const mine = onThread(t);
    const got = await api<Topic>(`/threads/${t.id}${mine && looking() ? `?read_as=${encodeURIComponent(me)}` : ""}`);
    cache.set(t.id, got);
    return got;
  }));
}

// A short name for a topic: "PR #2402", a doc's file name, or the note's subject.
export function topicLabel(t: Topic): string {
  const pr = t.messages.flatMap((m) => m.attachments).find((a) => a.type === "pr");
  const num = pr?.name.match(/#\d+/)?.[0];
  return num && !t.thread.subject.includes(num) ? `${num} · ${t.thread.subject}` : t.thread.subject;
}


/* The merged timeline. A divider opens each run of messages from one topic; a closed
   topic you are not on folds to its divider. */
export function timeline(render: (m: Message, topic: Topic) => string): string {
  // The topics list picks the topic, on the Mac and the phone, so the conversation is that one topic.
  const shown = S.convo.filter((t) => t.thread.id === S.cur);
  const items = shown.flatMap((t) => t.messages.map((m) => ({ m, t })))
    .sort((a, b) => a.m.created_at.localeCompare(b.m.created_at) || a.m.id - b.m.id);
  const one = shown.length === 1;
  let last = "";
  const out: string[] = [];
  // Done topics leave the conversation; the one you are on stays, so you can still read it.
  const done = shown.filter((t) => t.thread.status === "closed" && t.thread.id !== S.cur);
  const hidden = new Set(S.showDone ? [] : done.map((t) => t.thread.id));
  for (const { m, t } of items) {
    const id = t.thread.id;
    if (hidden.has(id)) continue;
    const closed = t.thread.status === "closed";
    const folded = closed && id !== S.cur && !S.openTopics.has(id);
    if (id !== last && !one) {
      const kind = t.thread.kind === "pr" ? I.pr : t.thread.kind === "doc" ? I.doc : I.chat;
      const st = standing(t.thread, t.messages);
      out.push(`<div class="topic ${id === S.cur ? "on" : ""} ${folded ? "folded" : ""}">
        <button class="tbtn" data-topic="${id}" title="${id === S.cur ? "You are replying on this" : "Reply on this"}"><span class="tl">${kind}<b>${esc(topicLabel(t))}</b></span><span class="ts ${st.cls}">${esc(closed ? "Done" : st.label)}</span></button>
        ${isPair(S.peer) ? "" : `<button class="done-btn" data-done="${id}" data-on="${closed ? "0" : "1"}" title="${closed ? "Bring this topic back" : "Mark this topic done: it leaves the conversation"}">${closed ? "Reopen" : `${I.check} Done`}</button>`}</div>`);
    }
    last = id;
    if (!folded) out.push(render(m, t));
  }
  // Done topics are mostly the old ones, so their switch sits at the top with "earlier topics".
  if (done.length) out.unshift(`<button class="older" data-show-done>${S.showDone ? "Hide" : "Show"} ${done.length} done topic${done.length === 1 ? "" : "s"}</button>`);
  return out.join("");
}

// This agent's open topics in one order everywhere: waiting on you first, then newest.
export function openTopics(): Summary[] {
  const waiting = (t: Summary) => t.to === me && t.status === "waiting";
  return everyThread().filter((t) => peerOf(t) === S.peer && (t.status !== "closed" || t.id === S.cur))
    .sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || b.updated_at.localeCompare(a.updated_at));
}

// Which topic your reply goes on: a quiet label, defaulting to the topic you are on. Clicking it
// opens the menu of open topics, plus "New topic" for a message about something else.
export function topicPicker(): string {
  if (isPair(S.peer)) return "";
  const open = S.convo.filter((t) => t.thread.status !== "closed" || t.thread.id === S.cur);
  const sorted = [...open].sort((a, b) => b.thread.updated_at.localeCompare(a.thread.updated_at));
  const cur = S.convo.find((t) => t.thread.id === S.cur);
  const label = S.newTopic ? "New topic" : cur ? topicLabel(cur) : "";
  return `<div class="replying"><span>${S.newTopic ? "Starting" : "On"}</span><span class="topic-link" title="Change where this goes"><b>${esc(label)}</b>${I.next}
    <select id="topic" aria-label="Topic your reply goes on">${sorted.map((t) =>
      `<option value="${t.thread.id}" ${!S.newTopic && t.thread.id === S.cur ? "selected" : ""}>${esc(topicLabel(t).slice(0, 70))}</option>`).join("")}
      <option value="__new" ${S.newTopic ? "selected" : ""}>New topic…</option></select></span></div>
`;
}
