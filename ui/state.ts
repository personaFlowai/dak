import { api, blobText, boot, local } from "./api";
import { highlightLines } from "./hl";
import { blocks, type Block } from "./md";
import { parseDiff, hunkStart, type DiffFile } from "../src/diff";
import type { Anchor, Attachment, Chapter, Message, Thread, Verdict } from "../src/types";
import { TOOLS } from "./icons";

export type Pr = Extract<Attachment, { type: "pr" }>;
export type Doc = Extract<Attachment, { type: "doc" }>;
export interface Summary extends Thread { unread: number; last_body: string; last_author: string }
export interface Draft { id: string; attachment_id: string; anchor: Anchor; body: string; label: string }
export interface Sel { att: string; file: string; side: "old" | "new"; start: number; end: number }
export interface AgentRow { name: string; kind: "person" | "agent"; reader: boolean; about: string | null; tool: string | null; where: string | null; last_seen: string | null; running: boolean; listening: boolean }
export interface AskTurn { q: string; a?: string; error?: string; context?: string; loading?: boolean; seconds?: number; by?: string }
export type View = "thread" | "compose" | "settings" | "welcome";

export const me = boot.me;

export const S = {
  view: "thread" as View,
  focus: local.get("focus", false), // review fills the window; the reply floats at the bottom
  dockOpen: false,
  paneClosed: false, // you closed the PR or doc beside the chat; a card reopens it
  door: null as any, // the tunnel for a remote agent, when open
  sideOpen: local.get("sideOpen", true),
  focusSide: false, // focus hides the sidebar; the sidebar button can still bring it back
  unfold: new Set<string>(), // reviewed files opened again, as "attachment:path"
  threads: [] as Summary[], // your threads, newest first
  others: [] as Summary[], // agents writing to each other, which you can read
  counts: { to: 0 },
  peer: null as string | null, // the agent whose conversation is open
  convo: [] as { thread: Thread; messages: Message[] }[], // its topics: one thread each
  topicCap: 12, // newest topics loaded; "Show earlier topics" raises it
  olderTopics: 0,
  openTopics: new Set<string>(), // closed topics unfolded by hand
  showDone: false,
  login: "off", // start at login, as macOS reports it (the Mac app only) // done topics are hidden from the conversation unless you ask for them
  scrollTo: null as null | "end" | string, // after the next render: the bottom, or a topic's divider
  agents: [] as AgentRow[],
  cur: null as string | null,
  data: null as { thread: Thread; messages: Message[] } | null,
  att: null as string | null,
  chapter: -1, // -1 is the PR's overview
  split: local.get("split", false), // diffs side by side: removed on the left, added on the right
  restore: null as null | Record<string, number>,
  find: { open: false, q: "", i: 0, list: false }, // find in the open PR
  archived: {} as Record<string, string>, // conversation (agent, or "a+b") → when you archived it
  showArchived: false,
  search: { open: false, q: "", i: 0, hits: [] as any[] }, // ⌘K across every conversation
  newTopic: false, // the reply box is starting a new thread with this agent, not answering one
  newSubject: "", // scroll positions to put back after the next render
  fileMode: {} as Record<string, "diff" | "full">,
  pane: "chat" as "chat" | "ask",
  sel: null as Sel | null,
  editing: null as null | { key: string; anchor: Anchor; label: string; att: string },
  verdict: local.get("verdict", {}) as Record<string, Verdict | null>,
  message: local.get("message", {}) as Record<string, string>,
  github: local.get("github", {}) as Record<string, boolean>,
  sending: false,
  sendNote: "",
  sendError: "",
  ask: {} as Record<string, AskTurn[]>,
  askContext: null as null | { label: string; sel?: Sel; quote?: string },
  compose: null as null | { mode: "message" | "pr"; to: string; subject: string; body: string; filter: string; pr: string; repo: string; error: string; sending: boolean },
  settings: null as any,
  diffs: new Map<string, DiffFile[]>(),
  files: new Map<string, string[]>(),
  docs: new Map<string, Block[]>(),
};

// Mail counts as read only when you can see it: Dak in front and on screen. A conversation
// left open in the background must not mark new messages read, or nothing would notify you.
export const looking = () => !document.hidden && document.hasFocus();

export const keepUnsent = () => { local.set("message", S.message); local.set("verdict", S.verdict); local.set("github", S.github); };
export const drafts = (thread: string): Draft[] => local.get(`drafts:${thread}`, [] as Draft[]);
export const saveDrafts = (thread: string, d: Draft[]) => local.set(`drafts:${thread}`, d);
// Progress is per file, as on GitHub: a chapter counts as read when every file in it is viewed.
export const viewed = (att: string): Set<string> => new Set(local.get(`viewed:${att}`, [] as string[]));
export const setViewed = (att: string, paths: string[], on: boolean) => {
  const v = viewed(att);
  for (const p of paths) on ? v.add(p) : v.delete(p);
  local.set(`viewed:${att}`, [...v]);
};
export const chapterFiles = (c: { hunks: { file: string }[] }) => [...new Set(c.hunks.map((h) => h.file))];
export const reviewed = (att: string, chapters: { hunks: { file: string }[] }[]): number[] => {
  const v = viewed(att);
  return chapters.map((c, i) => (chapterFiles(c).every((f) => v.has(f)) ? i : -1)).filter((i) => i >= 0);
};

export const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
export const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T | null;

export const name = (n: string) => (n === me ? "You" : n.length > 18 && /-[0-9a-f]{6}$/.test(n) ? n.replace(/-[0-9a-f]{6}$/, "") : n.charAt(0).toUpperCase() + n.slice(1));
export const agentOf = (n: string) => S.agents.find((a) => a.name === n);
const BY_NAME: Record<string, string> = { github: "github", cursor: "cursor", codex: "codex", claude: "claude-code", grok: "grok" };
export const toolOf = (n: string) => agentOf(n)?.tool ?? BY_NAME[n] ?? null;

// One neutral mark for everyone: the tool's logo when known, else the first letter.
export function mark(n: string, size: "sm" | "md" = "md") {
  const t = toolOf(n);
  const glyph = t && TOOLS[t]?.mark ? TOOLS[t].mark : `<span>${esc((n === me ? "Y" : n.charAt(0)).toUpperCase())}</span>`;
  return `<span class="mark ${size}" title="${esc(t ? `${name(n)} · ${TOOLS[t]?.label ?? t}` : name(n))}" aria-hidden="true">${glyph}</span>`;
}

export function when(iso: string): string {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}
export const fullWhen = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// Your last verdict on a thread was an approval and nothing new to review came after it.
// Mirrors approvedSince() in the store, which decides whether an update needs an answer.
export function approvedNow(messages: Message[], reader: string): boolean {
  let ok = false;
  for (const m of messages) {
    if (m.author === reader && m.verdict) ok = m.verdict === "approve";
    else if (m.author !== reader && m.attachments.length) ok = false;
  }
  return ok;
}

// One label for where a thread stands, from your side, for the toolbar and the topic dividers.
export function standing(t: Thread, messages: Message[]): { label: string; cls: string } {
  const other = t.to === me ? t.from : t.to;
  if (t.status === "closed") return { label: "Closed", cls: "" };
  if (t.status === "waiting") return t.to === me ? { label: "Waiting on you", cls: "you" } : { label: `Waiting on ${name(other)}`, cls: "" };
  if (approvedNow(messages, t.to)) return { label: t.to === me ? "Approved" : `${name(other)} approved`, cls: "done" };
  if (t.status === "informed") return { label: "No reply needed", cls: "" };
  if (t.to !== me) return { label: `${name(other)} answered`, cls: "done" };
  return t.status === "picked_up" ? { label: `${name(other)} picked it up`, cls: "done" } : { label: `Sent to ${name(other)}`, cls: "" };
}

export const allAtts = () => S.data ? S.data.messages.flatMap((m) => m.attachments.map((a) => ({ a, m }))) : [];
export const findAtt = (id: string | null) => allAtts().find((x) => x.a.id === id)?.a ?? null;

export function defaultAtt(): string | null {
  const list = [...allAtts()].reverse();
  return (list.find((x) => x.a.type === "pr") ?? list.find((x) => x.a.type === "doc"))?.a.id ?? null;
}

// A PR sent without chapters still reads in order: one step per file.
export function chaptersOf(a: Pr): (Chapter & { plain?: boolean })[] {
  if (a.meta.chapters.length) return a.meta.chapters;
  const files = S.diffs.get(a.meta.diff_blob) ?? [];
  return files.map((f) => ({ title: f.path.split("/").pop() ?? f.path, summary: f.path, risk: "low" as const,
    hunks: f.hunks.map((h) => ({ file: f.path, start: hunkStart(f, h) })), key_changes: [], plain: true }));
}

// Load the blobs the current view needs before drawing it, so nothing jumps.
export async function prepare() {
  const a = findAtt(S.att);
  if (!a) return;
  if (a.type === "pr") {
    if (!S.diffs.has(a.meta.diff_blob)) S.diffs.set(a.meta.diff_blob, parseDiff(await blobText(a.meta.diff_blob)));
    const ch = S.chapter >= 0 ? chaptersOf(a)[S.chapter] : null;
    const paths = ch ? [...new Set(ch.hunks.map((h) => h.file))] : [];
    await Promise.all(paths.map(async (path) => {
      const f = a.meta.files.find((x) => x.path === path);
      if (f?.new_blob && !S.files.has(f.new_blob)) S.files.set(f.new_blob, highlightLines(await blobText(f.new_blob), path));
      if (f?.new_blob && /\.md$/i.test(path) && !S.docs.has(f.new_blob)) S.docs.set(f.new_blob, blocks(await blobText(f.new_blob)));
    }));
  }
  if (a.type === "doc" && !S.docs.has(a.meta.blob)) S.docs.set(a.meta.blob, blocks(await blobText(a.meta.blob)));
}

export async function loadAgents(scan = false) {
  try { S.agents = await api(`/agents${scan ? "?scan=1" : ""}`); } catch { /* the list still renders by name */ }
}

// The helper's own logo, so the Ask pane says which tool answers.
export function helperMark(): string {
  const id = S.settings?.helper;
  return TOOLS[id === "claude" ? "claude-code" : id ?? ""]?.mark ?? TOOLS.cli.mark;
}

// What a quote looked like to the reader: no Markdown markers.
export const plain = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]+/g, "").replace(/\s+/g, " ").trim();

export function helperLabel(): string {
  const s = S.settings;
  return s?.helpers?.find((h: any) => h.id === s.helper)?.label ?? "the helper";
}
