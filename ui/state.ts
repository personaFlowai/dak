import { api, blobText, boot, local } from "./api";
import { highlightLines } from "./hl";
import { blocks, type Block } from "./md";
import { parseDiff, hunkStart, type DiffFile } from "../src/diff";
import type { Anchor, Attachment, Chapter, Message, Participant, Thread, Verdict } from "../src/types";
import { TOOLS } from "./icons";
import { approvedNow, prKey, prStates, type PrState } from "../src/verdicts";

export type Pr = Extract<Attachment, { type: "pr" }>;
export type Doc = Extract<Attachment, { type: "doc" }>;
export interface Summary extends Thread { unread: number; last_body: string; last_author: string; participants?: string[]; reviewing_since?: string | null }
export interface Draft { id: string; attachment_id: string; anchor: Anchor; body: string; label: string }
export interface Sel { att: string; file: string; side: "old" | "new"; start: number; end: number }
export interface AgentRow { name: string; title?: string | null; kind: "person" | "agent"; reader: boolean; about: string | null; tool: string | null; where: string | null; last_seen: string | null; running: boolean; listening: boolean }
export interface AskTurn { q: string; a?: string; error?: string; context?: string; loading?: boolean; seconds?: number; by?: string }
export type View = "thread" | "compose" | "settings" | "welcome" | "queue" | "team" | "board" | "you" | "work" | "rules";

export const me = boot.me;

/* On a phone (through the phone link, or any narrow screen) Dak is two screens: the list
   (merge queue first, then agents) and whatever you opened from it, with a back button.
   A PR or doc opens full-screen with the reply floating at the bottom. */
export const onPhone = () => !!(window as any).DAK?.phone || matchMedia("(max-width: 760px)").matches;

// Being reworked (skip it; it comes back with its next version) or parked by the person's choice.
export interface Hold { kind: "rework" | "parked"; note: string | null; at: string; by: string | null }

export const S = {
  view: "thread" as View,
  focus: local.get("focus", false), // review fills the window; the reply floats at the bottom
  dockOpen: false,
  paneClosed: false, // you closed the PR or doc beside the chat; a card reopens it
  door: null as any, // the tunnel for agents outside this Mac, and their keys
  team: [] as any[], // everyone who works through Dak (src/team.ts TeamMember)
  board: null as any, // the Board's tickets (ui/board.ts BoardData)
  boardError: "" as string,
  boardFilter: { agents: [] as string[], labels: [] as string[], milestones: [] as string[], q: "", needs: false },
  boardView: "piles" as "piles" | "stages",
  boardMenu: null as null | "agents" | "labels" | "milestones", // the open filter dropdown
  boardClosed: [] as string[], // backlog milestone groups folded away
  backlogFolded: local.get<boolean>("backlogFolded", false), // the whole backlog folded to a strip
  boardOpen: null as string | null, // the ticket whose panel is open
  teamEdit: null as string | null, // whose card is open for editing
  phone: null as any, // the private link to your phone: { open, url, link } or { opening } or { error }
  sideOpen: local.get("sideOpen", true),
  focusSide: false, // focus hides the sidebar; the sidebar button can still bring it back
  unfold: new Set<string>(), // reviewed files opened again, as "attachment:path"
  threads: [] as Summary[], // your threads, newest first
  others: [] as Summary[], // agents writing to each other, which you can read
  counts: { to: 0 },
  peer: null as string | null, // the agent whose conversation is open
  convo: [] as { thread: Thread; messages: Message[]; participants?: Participant[]; reads?: { reader: string; up_to: number; seen_at: string | null }[] }[], // its topics: one thread each
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
  topicFind: "", // the sidebar's topic search
  pins: {} as Record<string, string>, // agents pinned to the top of the list, and when
  moreOpen: false, // the ⋯ menu in a thread's toolbar
  filesOpen: false, // the attachments list from the toolbar
  confirmAll: false, // "Approve all" tapped once: the next tap approves the PRs it named
  sideLevel: "agents" as import("./shell").SideLevel, // the sidebar: agents, one agent's topics, or agents' own threads
  tabs: local.get<string[]>("tabs", []), // threads open as tabs along the top, oldest first
  preview: local.get<string | null>("previewTab", null), // the one tab the next opened topic replaces
  docActive: null as number | null, // the doc paragraph whose comments are lit up
  peek: null as import("./peek").Peek | null, // a definition opened with ⌘-click over the code
  peekBack: [] as import("./peek").Peek[], // where the peek has been, for its Back
  topicsOpen: local.get("topicsOpen", true), // the topics column beside a conversation, on the Mac
  hideTests: local.get("hideTests", false), // test files fold to their header in a PR; Show opens one
  split: local.get("split", false), // diffs side by side: removed on the left, added on the right
  restore: null as null | Record<string, number>,
  find: { open: false, q: "", i: 0, list: false }, // find in the open PR
  archived: {} as Record<string, string>, // conversation (agent, or "a+b") → when you archived it
  showArchived: false,
  phoneList: true,
  phoneFile: null as string | null, // on a phone: the file open in the sheet
  phoneFileChapter: -1, // the chapter that file was opened from, or -1 from the Diff tab
  phoneTab: "guide" as "overview" | "guide", // on a phone: which view of the PR // on a phone: the list is showing, not what was opened from it
  queue: [] as { pr: number; title: string; head: string | null; migration: string | null; state: string; note: string | null; thread_id: string | null; updated_at: string;
    state_since: string; eta_at: string | null; after_pr: number | null; approval: { by: string; at: string } | null; size: PrSize | null;
    tier: string; rank: number | null; why: string | null; rank_by: string | null; pair_id: string | null; waiting_reason: string | null;
    hold: Hold | null; head_moved: { from: string; to: string; change: "rebase only" | "content changed" | null } | null }[],
  reviews: [] as { thread_id: string; subject: string; from: string; pr: number | null; waiting_since: string; reviewing_since: string | null; size: PrSize | null;
    tier: string; rank: number | null; why: string | null; rank_by: string | null; type: string; blocks: string | null; hold: Hold | null }[], // everything waiting on you, in priority order
  heldReviews: [] as { thread_id: string; subject: string; from: string; pr: number | null; type: string; hold: Hold }[], // being reworked or parked: not counted
  search: { open: false, q: "", i: 0, hits: [] as any[] }, // ⌘K across every conversation
  newAtts: [] as { type: "file" | "link"; name: string; mime?: string; base64?: string; url?: string }[], // attached to the message being written
  linkOpen: false,
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
  texts: new Map<string, string>(), // an HTML page or a text file, by blob, for the viewer
};

// Files that open beside the conversation, with a close button, instead of leaving Dak.
export const opensInPane = (mime: string) => /^(image|video)\//.test(mime) || mime.startsWith("application/pdf") || /^text\//.test(mime);

// Mail counts as read only when you can see it: Dak in front and on screen. A conversation
// left open in the background must not mark new messages read, or nothing would notify you.
export const looking = () => !document.hidden && document.hasFocus();

export interface PrSize { files: number; additions: number; deletions: number }
// "+120 −30 · 6 files": how big a PR is, read at a glance. Big is flagged so it stands out.
export function sizeLabel(z: PrSize | null | undefined): string {
  if (!z) return "";
  const lines = z.additions + z.deletions;
  const tier = lines < 80 ? "small" : lines < 400 ? "medium" : "large";
  return `<span class="size ${tier}" title="${lines} lines changed in ${z.files} file${z.files === 1 ? "" : "s"}"><span class="a">+${z.additions}</span> <span class="d">−${z.deletions}</span> · ${z.files} file${z.files === 1 ? "" : "s"}</span>`;
}

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

// How a name reads: You; a session by its own title in Claude Code ("Team engineer (M21)"),
// not the folder-and-code name Dak gave it; anyone else by name. Named readers (such as lead) keep theirs.
export const name = (n: string) => {
  if (n === me) return "You";
  const a = S.agents.find((x) => x.name === n);
  if (a?.title && !a.reader) return a.title;
  return n.length > 18 && /-[0-9a-f]{6}$/.test(n) ? n.replace(/-[0-9a-f]{6}$/, "") : n.charAt(0).toUpperCase() + n.slice(1);
};
export const agentOf = (n: string) => S.agents.find((a) => a.name === n);
const BY_NAME: Record<string, string> = { github: "github", cursor: "cursor", codex: "codex", claude: "claude-code", grok: "grok" };
export const toolOf = (n: string) => agentOf(n)?.tool ?? BY_NAME[n] ?? null;

// One neutral mark for everyone: the tool's logo when known, else the first letter.
export function mark(n: string, size: "sm" | "md" = "md") {
  // You are a person, never a tool, even if a session once sent as your name.
  const t = n === me ? null : toolOf(n);
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
export { approvedNow };

// The PRs on the open thread, each with its own verdict (from the server, by the same rule).
export const prsHere = (): PrState[] => (S.data as any)?.prs ?? [];
// The PR a pane attachment is a version of.
export const prOfAtt = (a: Attachment | null): PrState | null =>
  a?.type === "pr" ? prsHere().find((p) => p.key === prKey(a.meta.number)) ?? null : null;

// One label for where a thread stands, from your side, for the toolbar and the topic dividers.
export function standing(t: Thread, messages: Message[]): { label: string; cls: string } {
  const other = t.to === me ? t.from : t.to;
  if (t.status === "closed") return { label: "Closed", cls: "" };
  // Several PRs: say how many are approved, since approving one does not approve the topic.
  const prs = prStates(messages, [t.to]);
  const ok = prs.filter((p) => p.verdict === "approve").length;
  const some = prs.length > 1 && ok > 0 && ok < prs.length ? ` · ${ok} of ${prs.length} approved` : "";
  if (t.status === "waiting") return t.to === me ? { label: `Waiting on you${some}`, cls: "you" } : { label: `Waiting on ${name(other)}${some}`, cls: "" };
  if (some) return { label: `${ok} of ${prs.length} approved`, cls: "" };
  if (approvedNow(messages, t.to)) return { label: t.to === me ? "Approved" : `${name(other)} approved`, cls: "done" };
  if (t.status === "informed") return { label: "No reply needed", cls: "" };
  if (t.to !== me) return { label: `${name(other)} answered`, cls: "done" };
  return t.status === "picked_up" ? { label: `${name(other)} picked it up`, cls: "done" } : { label: `Sent to ${name(other)}`, cls: "" };
}

export const allAtts = () => S.data ? S.data.messages.flatMap((m) => m.attachments.map((a) => ({ a, m }))) : [];
export const findAtt = (id: string | null) => allAtts().find((x) => x.a.id === id)?.a ?? null;

export function defaultAtt(): string | null {
  const list = [...allAtts()].filter((x) => !x.a.hidden).reverse();
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
  if (a.type === "file" && /^text\//.test(a.meta.mime) && !S.texts.has(a.meta.blob)) S.texts.set(a.meta.blob, await blobText(a.meta.blob));
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

// A test file, by its name: foo.test.ts, foo.spec.tsx, foo.dom.test.tsx, or anything under __tests__.
export const isTestFile = (path: string) => /\.(test|spec)\.[a-z0-9]+$/i.test(path) || /(^|\/)__tests__\//.test(path);
