/* Dak's screens. Layout: a source-list sidebar (one row per agent), and a
   main area with the app's own toolbar. A PR or doc opens as two panes: the
   conversation with the agent on the left, the thing under review on the right. */
import { api, local } from "./api";
import { addTab, closeTab, railView, sideBody, tabsView } from "./shell";
import { closePeek, openPeek, peekBackStep, peekView, showSpot, wordAt } from "./peek";
import { topicRows } from "./topics";
import qrcode from "qrcode-generator";
import {
  S, me, esc, $, name, mark, when, standing, approvedNow, looking, findAtt, defaultAtt, chaptersOf, prepare, loadAgents, drafts, saveDrafts,
  setViewed, viewed, chapterFiles, keepUnsent, helperLabel, agentOf, type Summary, type AgentRow,
  fullWhen, sizeLabel, opensInPane, onPhone,
} from "./state";
import { prView, selKey, selLabel, prLink } from "./pr";
import { docView, markQuotes, readSelection, pending, clearPending, layoutMargin, setDocActive } from "./doc";
import { chatPane, currentVerdict, composer, askPane, canReply, attachBar } from "./chat";
import { I, TOOLS } from "./icons";
import { findHits, findBar, hitKey, type Hit } from "./find";
import { draftKey, forgetConvo } from "./convo";
import { archivedList, isArchived, peers } from "./convo";
import { peerList, pairList, peerOf, peerName, isPair, topicFor, loadConvo, topicMenu, onThread, openTopics } from "./convo";
import type { Message, Participant, Thread, Verdict } from "../src/types";

const native = document.documentElement.classList.contains("native");

/* ================= data ================= */

async function loadList() {
  [S.threads, S.others, S.archived] = await Promise.all([
    api<Summary[]>(`/threads?for=${encodeURIComponent(me)}&box=all`),
    api<Summary[]>(`/threads?for=${encodeURIComponent(me)}&box=others`),
    api<Record<string, string>>("/archives").catch(() => ({})),
  ]);
  const [q, all] = await Promise.all([api<typeof S.queue>("/queue").catch(() => []), api<typeof S.reviews>(`/reviews?for=${encodeURIComponent(me)}`).catch(() => [])]);
  // Held rows (being reworked, parked) are listed apart and never counted as waiting on you.
  S.queue = q; S.reviews = all.filter((r) => !r.hold); S.heldReviews = all.filter((r) => r.hold) as typeof S.heldReviews;
  if (S.view === "queue" || S.view === "waiting") renderMain();
  S.counts = { to: S.threads.filter((t) => t.unread && !isArchived(peerOf(t))).length };
  renderSide();
}

async function openThread(id: string, keep = false) {
  const t = S.threads.find((x) => x.id === id);
  const mine = !t || onThread(t);
  const data = await api<{ thread: Thread; messages: Message[]; participants?: Participant[] }>(`/threads/${id}${mine && looking() ? `?read_as=${encodeURIComponent(me)}` : ""}`);
  const changed = S.cur !== id;
  const peer = peerOf({ ...data.thread, participants: data.participants?.map((p) => p.name) });
  const sameConvo = peer === S.peer && S.view === "thread";
  // Opening a topic shows that topic. With every topic in one timeline, the end is the newest
  // topic, not the one you clicked (from the merge queue, say): go to the one you asked for.
  S.scrollTo = !sameConvo ? (S.allTopics ? id : "end") : changed ? id : S.scrollTo;
  if (peer !== S.peer || changed) { S.newTopic = false; S.newSubject = ""; }
  // Moving between topics of the same conversation keeps the side pane as you left it: closed
  // stays closed. Coming from elsewhere (the queue, a list) opens what you clicked.
  const keepClosed = sameConvo && changed && S.paneClosed;
  // Opening a conversation from anywhere else drills the sidebar into its topics, and the
  // thread becomes a tab.
  if (!sameConvo) S.sideLevel = "topics";
  addTab(id);
  S.cur = id; S.data = data; S.view = "thread"; S.peer = peer; S.phoneList = false;
  if (changed || !keep) {
    S.paneClosed = keepClosed; useAtt(keepClosed ? null : defaultAtt()); S.sel = null; S.editing = null; S.askContext = null; S.sendError = ""; S.sendNote = ""; S.pane = "chat";
    clearPending();
  } else if (!findAtt(S.att) && !S.paneClosed) useAtt(defaultAtt());
  local.set("last", id);
  await Promise.all([prepare(), loadConvo()]);
  render();
  loadList();
}

async function openPeer(peer: string) {
  const id = topicFor(peer);
  if (id) await openThread(id);
}

async function loadSettings() {
  try { S.door = await api("/door"); } catch { /* the door section says closed */ }
  try { S.phone = await api("/phone"); } catch { /* the phone section says closed */ }
  try { S.settings = await api("/settings"); } catch { /* the settings view says so */ }
}

/* ================= find in a PR ================= */

let hitCache: { att: string | null; q: string; hits: Hit[] } = { att: null, q: "", hits: [] };
function hits(): Hit[] {
  const a = findAtt(S.att);
  if (a?.type !== "pr") return [];
  if (hitCache.att !== a.id || hitCache.q !== S.find.q) hitCache = { att: a.id, q: S.find.q, hits: findHits(a, S.find.q) };
  return hitCache.hits;
}

// Scroll the column that holds the code, not every ancestor: in beside mode the page around it must not move.
function scrollToRow(key: string) {
  const r = document.querySelector(`[data-key="${CSS.escape(key)}"]`) as HTMLElement | null;
  if (!r) return;
  const box = r.closest<HTMLElement>("#code-scroll, #reading");
  if (box) box.scrollTo({ top: box.scrollTop + r.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2 });
  document.querySelectorAll<HTMLElement>(`[data-key="${CSS.escape(key)}"]`).forEach((el) => { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); });
}

async function openFind() {
  const a = findAtt(S.att);
  if (a?.type !== "pr") return;
  const picked = window.getSelection()?.toString().trim();
  S.find = { open: true, q: picked && picked.length < 80 && !picked.includes("\n") ? picked : S.find.q, i: 0, list: true };
  renderMain();
  const f = $<HTMLInputElement>("#find"); f?.focus(); f?.select();
}

// Go to a match: its chapter, its file opened (even if marked Reviewed), the diff not the preview.
async function goToHit(i: number) {
  const list = hits();
  if (!list.length) return;
  S.find.i = (i + list.length) % list.length;
  S.find.list = false;
  const h = list[S.find.i];
  if (h.chapter >= 0) S.chapter = h.chapter;
  S.unfold.add(`${S.att}:${h.file}`);
  S.fileMode[`${S.att}:${h.file}`] = "diff";
  await prepare();
  renderMain();
  scrollToRow(hitKey(h));
}

// Matches in what is on screen are tinted; the current one is outlined.
function tintHits() {
  if (!S.find.open) return;
  const list = hits(), cur = list[S.find.i];
  for (const h of list) {
    document.querySelectorAll(`[data-key="${CSS.escape(hitKey(h))}"]`).forEach((r) => {
      r.classList.add("found");
      if (h === cur) r.classList.add("found-on");
    });
  }
}

/* ================= where you were ================= */

// Each PR or doc version remembers its chapter and how far each column was scrolled, on this
// Mac, so closing Dak and coming back opens it where you left off.
const SCROLLERS = ["#reading", "#code-scroll", ".notes-col > header", ".pane-body.review"];
const placeKey = (att: string) => `place:${att}`;

function useAtt(id: string | null) {
  S.att = id; S.docActive = null;
  const p = id ? local.get<{ chapter?: number; scroll?: Record<string, number> } | null>(placeKey(id), null) : null;
  S.chapter = p?.chapter ?? -1;
  S.restore = p?.scroll ?? null;
}

let placeTimer: ReturnType<typeof setTimeout> | undefined;
function writePlace() {
  if (!S.att || S.view !== "thread" || S.restore) return;
  const scroll: Record<string, number> = {};
  for (const sel of SCROLLERS) { const el = $(sel); if (el) scroll[sel] = Math.round(el.scrollTop); }
  local.set(placeKey(S.att), { chapter: S.chapter, scroll });
}
function savePlace() { clearTimeout(placeTimer); placeTimer = setTimeout(writePlace, 250); }
document.addEventListener("scroll", (e) => { if ((e.target as Element).matches?.(SCROLLERS.join(","))) savePlace(); }, true);
// Closing the window or quitting must not lose the last quarter-second of scrolling.
addEventListener("pagehide", writePlace);
document.addEventListener("visibilitychange", () => { if (document.hidden) writePlace(); });

/* ================= shell ================= */

function render() {
  renderSide();
  renderMain();
}

function renderSide() {
  const review = S.view === "thread" && ["pr", "doc"].includes(findAtt(S.att)?.type ?? "");
  $("#app")!.classList.toggle("phone", onPhone());
  $("#app")!.classList.toggle("place", ["waiting", "queue", "settings", "compose"].includes(S.view));
  $("#app")!.classList.toggle("side-closed", onPhone() ? !S.phoneList : S.focus && review ? !S.focusSide : !S.sideOpen);
  if (onPhone()) {
    // The phone keeps its list screen: places at the top, then every conversation.
    $("#side")!.innerHTML = `
    <div class="side-top"><span class="grow"></span><button class="icon-btn" data-search-open title="Search everything (⌘K)" aria-label="Search">${I.search}</button><button class="icon-btn" data-compose title="New message (N)" aria-label="New message">${I.compose}</button></div>
    <button class="row-btn queue-entry" data-waiting aria-current="${S.view === "waiting"}">${I.check}<span class="lbl">Waiting on you</span>${S.reviews.length ? `<span class="count you">${S.reviews.length}</span>` : ""}</button>
    <button class="row-btn queue-entry" data-queue aria-current="${S.view === "queue"}">${I.pr}<span class="lbl">Merge queue</span>${S.queue.some((r) => r.state !== "deployed" && !r.hold) ? `<span class="count">${S.queue.filter((r) => r.state !== "deployed" && !r.hold).length}</span>` : ""}</button>
    <div class="side-head">Inbox${S.counts.to ? `<span class="count">${S.counts.to}</span>` : ""}</div>
    <div class="list" role="list" aria-label="Agents">${peerList()}${pairList()}${archivedList()}</div>`;
  } else {
    $("#rail")!.innerHTML = railView();
    $("#tabs")!.innerHTML = tabsView();
    const keepList = $("#tlist")?.scrollTop ?? $(".side .list")?.scrollTop ?? 0;
    const finding = document.activeElement?.id === "topic-find" ? ($<HTMLInputElement>("#topic-find")!.selectionStart ?? 0) : -1;
    $("#side")!.innerHTML = sideBody() + `<div class="splitter" data-split="side" title="Drag to resize"></div>`;
    const l = $("#tlist") ?? $(".side .list"); if (l) l.scrollTop = keepList;
    if (finding >= 0) { const f = $<HTMLInputElement>("#topic-find"); f?.focus(); f?.setSelectionRange(finding, finding); }
  }
  postControls();
}

function toolbar(title: string, sub = "", right = ""): string {
  return `<header class="toolbar">
    ${onPhone() ? "" : `<button class="icon-btn" data-toggle-side title="${S.sideOpen ? "Hide" : "Show"} sidebar (⌘\\)" aria-label="Toggle sidebar">${I.sidebar}</button>`}
    <span class="navbtns"><button class="icon-btn" data-nav-back title="Back (⌘[)" aria-label="Back" ${nav.idx <= 0 && !onPhone() ? "disabled" : ""}>${I.prev}</button><button class="icon-btn" data-nav-fwd title="Forward (⌘])" aria-label="Forward" ${nav.idx >= nav.max ? "disabled" : ""}>${I.next}</button></span>
    <div class="title"><b>${title}</b>${sub ? `<span>${sub}</span>` : ""}</div>
    <div class="tools">${right}</div></header>`;
}

let listShows: string | null = null; // the topic the topics list last scrolled to
function renderMain() {
  const main = $("#main")!;
  const finding = document.activeElement?.id === "topic-find" ? ($<HTMLInputElement>("#topic-find")!.selectionStart ?? 0) : -1;
  const keep = { topics: $("#tlist")?.scrollTop ?? 0, phonePr: $(".phone-pr")?.scrollTop ?? 0, reading: $("#reading")?.scrollTop ?? 0, msgs: $("#msgs")?.scrollTop, body: $(".pane-body")?.scrollTop ?? 0,
    // Beside mode: each column keeps its place while you stay on the same chapter.
    chapter: $(".chapter.beside")?.dataset.key, code: $("#code-scroll")?.scrollTop ?? 0, notes: $(".notes-col > header")?.scrollTop ?? 0 };
  if (S.view === "compose") main.innerHTML = toolbar("New message") + composeView();
  else if (S.view === "settings") main.innerHTML = toolbar("Settings") + settingsView();
  else if (S.view === "welcome") main.innerHTML = toolbar("Welcome to Dak") + welcomeView();
  else if (S.view === "queue") main.innerHTML = toolbar("Merge queue", queueSummary()) + queueView();
  else if (S.view === "waiting") main.innerHTML = toolbar("Waiting on you", waitingSummary()) + `<div class="pane-body"><div class="queue-page">${reviewGroup()}
    <p class="qfoot">PRs, briefs and decisions waiting on you, in one order. Atlas sets the order and says what each answer releases; drag a row or change its priority, and your order wins.</p></div></div>`;
  else if (!S.data) main.innerHTML = toolbar("Dak") + `<div class="blank"><p>Choose a thread to read it.</p></div>`;
  else main.innerHTML = threadView();
  const r = $("#reading"); if (r) r.scrollTop = keep.reading;
  const tl = $("#tlist"); if (tl) tl.scrollTop = keep.topics;
  // The peek floats over whatever PR is open; it goes when you leave the PR.
  if (S.peek && (S.view !== "thread" || findAtt(S.att)?.type !== "pr" || onPhone())) closePeek();
  if (S.peek) main.insertAdjacentHTML("beforeend", peekView());
  // A topic opened from elsewhere (the queue, search) is scrolled into sight in the list, once.
  if (tl && S.cur !== listShows) { listShows = S.cur; tl.querySelector<HTMLElement>(".trow.on")?.scrollIntoView({ block: "nearest" }); }
  // A re-render while you search the topics leaves the cursor where it was.
  if (finding >= 0) { const f = $<HTMLInputElement>("#topic-find"); f?.focus(); f?.setSelectionRange(finding, finding); }
  const ch = $(".chapter.beside");
  if (ch && ch.dataset.key === keep.chapter) { $("#code-scroll")!.scrollTop = keep.code; $(".notes-col > header")!.scrollTop = keep.notes; }
  const m = $("#msgs");
  if (m) {
    const to = S.scrollTo; S.scrollTo = null;
    const divider = to && to !== "end" ? m.querySelector<HTMLElement>(`[data-topic="${to}"]`) : null;
    if (divider) m.scrollTop = divider.offsetTop - m.offsetTop - 8;
    else m.scrollTop = S.pane === "ask" || to === "end" || keep.msgs === undefined ? m.scrollHeight : keep.msgs;
  }
  const pb = $(".pane-body"); if (pb && !r) pb.scrollTop = keep.body;
  const pp = $(".phone-pr"); if (pp) pp.scrollTop = keep.phonePr; // closing a file sheet leaves the page where it was
  if (S.restore) { for (const [sel, top] of Object.entries(S.restore)) { const el = $(sel); if (el) el.scrollTop = top; } S.restore = null; }
  else savePlace();
  markQuotes();
  layoutMargin();
  tintHits();
  const ed = $<HTMLTextAreaElement>("#edit"); if (ed && document.activeElement !== ed) ed.focus();
  postControls();
  remember();
}

function threadView(): string {
  const t = S.data!.thread;
  const a = findAtt(S.att);
  const media = a?.type === "file" && opensInPane(a.meta.mime);
  const review = a?.type === "pr" || a?.type === "doc" || media;
  const other = t.to === me ? t.from : t.from === me ? t.to : t.from;
  const st = status(t);
  const gh = prLink();
  // Approve belongs to the thread, so it stays when the PR or doc beside the chat is closed.
  // The addressee approves, and so does anyone added as the approver.
  const approver = t.to === me || !!(S.data as any).participants?.some((p: Participant) => p.name === me && p.role === "approver");
  const canApprove = (t.kind === "pr" || t.kind === "doc") && approver && t.status !== "closed";
  const approved = canApprove && approvedNow(S.data!.messages, me);
  // Approved already: the status beside it says so, so the button goes.
  const approveBtn = approved ? "" : canApprove ? `<button class="btn primary" id="approve" ${S.sending ? "disabled" : ""} title="Approve now; anything you have typed or commented goes with it">${I.check} Approve</button>` : "";
  const archived = S.peer ? isArchived(S.peer) : false;
  const archBtn = S.peer ? `<button class="icon-btn" data-${archived ? "unarchive" : "archive"}="${esc(S.peer)}" title="${archived ? "Move back to the Inbox" : "Archive this conversation (E)"}" aria-label="${archived ? "Unarchive" : "Archive"}">${archived ? I.lineUp : I.archive}</button>` : "";
  const doneBtn = S.peer && !isPair(S.peer) && canReply(t)
    ? `<button class="btn" data-done="${t.id}" data-on="${t.status === "closed" ? "0" : "1"}" title="${t.status === "closed" ? "Bring this topic back" : "This topic is finished: take it out of the conversation"}">${t.status === "closed" ? "Reopen" : `${I.check} Done`}</button>` : "";
  // "I'm reviewing": tells the sender you are on it; the PR stays waiting on you until your verdict.
  const onIt = S.threads.find((x) => x.id === t.id)?.reviewing_since;
  // Anything waiting on you with something to read: a PR or a doc, however the thread began.
  const readable = t.kind !== "note" || S.data!.messages.some((m) => m.attachments.some((x) => x.type === "pr" || x.type === "doc"));
  const reviewingBtn = readable && t.to === me && t.status === "waiting"
    ? onIt ? `<span class="status reviewing" title="Since ${esc(fullWhen(onIt))}">You're reviewing</span>`
      : `<button class="btn" data-reviewing="${t.id}" title="Tell ${esc(name(t.from))} you are reviewing this">I'm reviewing</button>` : "";
  // On the Mac the bar keeps only what you act on (I'm reviewing, Approve); where the topic
  // stands goes on the line under the name, and Done, Archive and GitHub go in the ⋯ menu.
  const statusWords = onIt ? { label: "You're reviewing", cls: "reviewing" } : st;
  const menu = [
    S.peer && !isPair(S.peer) && canReply(t) ? `<button class="mi" data-done="${t.id}" data-on="${t.status === "closed" ? "0" : "1"}">${t.status === "closed" ? "Reopen topic" : `${I.check}Mark topic done`}</button>` : "",
    S.peer ? `<button class="mi" data-${archived ? "unarchive" : "archive"}="${esc(S.peer)}">${archived ? `${I.lineUp}Back to the Inbox` : `${I.archive}Archive conversation`}</button>` : "",
    gh ? `<a class="mi" href="${esc(gh)}" target="_blank" rel="noopener">${I.github}Open on GitHub</a>` : "",
  ].filter(Boolean).join("");
  const more = menu ? `<div class="more-wrap"><button class="icon-btn" data-more aria-expanded="${S.moreOpen}" aria-haspopup="menu" title="More" aria-label="More">${I.more}</button>${S.moreOpen ? `<div class="menu" role="menu">${menu}</div>` : ""}</div>` : "";
  const right = onPhone()
    ? `${archBtn}${doneBtn}${reviewingBtn}${st ? `<span class="status ${st.cls}">${esc(st.label)}</span>` : ""}${approveBtn}${gh ? `<a class="icon-btn" href="${esc(gh)}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">${I.github}</a>` : ""}`
    : `${onIt ? "" : reviewingBtn}${approveBtn}${more}`;
  const standing = !onPhone() && statusWords ? ` · <span class="tstand ${statusWords.cls}">${esc(statusWords.label)}</span>` : "";
  const about = agentOf(other)?.about;
  // The window is the conversation with one agent; the line under its name is the topic you are on.
  const head = isPair(S.peer) ? toolbar(esc(peerName(S.peer!)), `Between agents · read only · ${esc(t.subject)}`, right)
    : toolbar(esc(name(other)), `${about ? `${esc(about)} · ` : ""}${onPhone() ? topicMenu(t.subject) : esc(t.subject)}${standing}${roles()}`, right);
  const withTopics = (body: string) => body; // the agent's topics are in the sidebar now
  if (!review) return head + withTopics(`<div class="solo-wrap">${chatPane(t, false)}</div>`);
  // Focus: chapters and code only; the reply floats at the bottom until you open it.
  if (S.focus || onPhone()) return head + `<div class="focus-wrap"><div class="pane-body review">${reviewBody(a!)}</div>
    ${S.pane === "ask" && S.dockOpen ? `<div class="dock open ask-dock"><div class="dock-top"><span>Ask ${esc(helperLabel())}</span><button type="button" class="link" data-pane="chat">Hide</button></div>${askPane(t)}</div>`
      : canReply(t) ? `<div class="dock ${S.dockOpen ? "open" : ""}">${composer(t, true)}</div>` : ""}</div>`;
  return head + withTopics(`<div class="split">${chatPane(t, true)}<div class="pane-body review">${reviewBody(a!)}</div></div>`);
}

// Who else is on the thread: " · Codex reviewing · Atlas watching".
function roles(): string {
  const ps = ((S.data as any)?.participants ?? []) as Participant[];
  const verb: Record<string, string> = { reviewer: "reviewing", approver: "approves", watcher: "watching", author: "author", member: "member" };
  const shown = ps.filter((p) => p.name !== me && p.role !== "member");
  return shown.length ? ` · ${shown.map((p) => `${esc(name(p.name))} ${verb[p.role]}`).join(", ")}` : "";
}

/* The merge queue, in three groups: what waits on your review (from your inbox, nobody has
   to push it), what is moving now, and what is approved and waiting its turn. Every row says
   who approved it, read from the thread, and how long it has been where it is. */
const MOVING = ["testing", "building", "merging", "merged", "migrated"];
const TRAIL: [string, string][] = [["approved", "Approved"], ["testing", "Tests"], ["building", "Build"], ["merging", "Merge"], ["merged", "Merged"], ["migrated", "Migrate"], ["deployed", "Deploy"]];
const STATE_WORD: Record<string, string> = { approved: "Waiting its turn", testing: "Running tests", building: "Building", merging: "Merging", merged: "Merged, migrations next",
  migrated: "Migrated, deploy next", deployed: "Deployed", failed: "Failed", held: "Held" };

function span(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
function left(eta: string | null): string {
  if (!eta) return "";
  const m = Math.round((Date.parse(eta) - Date.now()) / 60000);
  const dur = (n: number) => n < 60 ? `${n} min` : `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ""}`;
  return m >= 1 ? `<span class="eta">about ${dur(m)} left</span>` : m > -1 ? `<span class="eta">finishing now</span>` : `<span class="eta over">${dur(-m)} over</span>`;
}
const prTitle = (pr: number | null, title: string, thread: string | null) =>
  `${pr ? `<span class="qnum">#${pr}</span>` : ""}${thread ? `<button class="link qtitle" data-topic="${esc(thread)}">${esc(title)}</button>` : `<span class="qtitle">${esc(title)}</span>`}`;

type QRow = (typeof S.queue)[number];
const TIER_WORD: Record<string, string> = { urgent: "Urgent", normal: "Normal", later: "Later" };

// The tier menu on a row: the person can move it between urgent, normal and later.
const tierMenu = (kind: "pr" | "review", id: string | number, tier: string) =>
  `<label class="tier-pick ${tier}" title="Priority"><span>${TIER_WORD[tier] ?? tier}</span><select data-tier-${kind}="${esc(String(id))}" aria-label="Priority">${Object.entries(TIER_WORD).map(([k, w]) =>
    `<option value="${k}" ${k === tier ? "selected" : ""}>${w}</option>`).join("")}</select></label>`;

// Who placed the row: Atlas's order, or yours (which Atlas's reordering leaves alone).
const placedBy = (by: string | null) => by === me ? `<span class="placed" title="You placed this; agents' reordering leaves it here">placed by you</span>` : "";

function queueRow(r: QRow, pos?: number): string {
  // A pair is one row: both PRs, tested and merged together.
  const mates = r.pair_id ? S.queue.filter((x) => x.pair_id === r.pair_id) : [r];
  const approved = mates.every((m) => m.approval) ? `Approved by you ${when(r.approval!.at)}` : `<span class="warn">No approval from you on Dak${mates.length > 1 ? " for one of the pair" : ""}</span>`;
  const size = mates.length > 1 && mates.some((m) => m.size) ? sizeLabel(mates.reduce((z, m) => m.size ? { files: z.files + m.size.files, additions: z.additions + m.size.additions, deletions: z.deletions + m.size.deletions } : z, { files: 0, additions: 0, deletions: 0 })) : mates.length > 1 ? "" : sizeLabel(r.size);
  const meta = [approved, size, r.head ? `<code>${esc(r.head.slice(0, 8))}</code>` : "", r.migration ? `migration <code>${esc(r.migration)}</code>` : ""].filter(Boolean).join(" · ");
  const at = TRAIL.findIndex(([k]) => k === r.state);
  const trail = MOVING.includes(r.state) ? `<ol class="trail">${TRAIL.map(([, w], i) => `<li class="${i < at ? "past" : i === at ? "now" : ""}">${w}</li>`).join("")}</ol>` : "";
  const titles = mates.map((m) => `<div class="qhead">${prTitle(m.pr, m.title, m.thread_id)}</div>`).join("");
  const waitingRow = ["approved", "held", "failed"].includes(r.state) && !r.hold;
  return `<li class="qrow ${r.state} ${mates.length > 1 ? "pair" : ""}" ${waitingRow ? `draggable="true" data-drag-pr="${r.pr}" data-tier="${r.tier}"` : ""}>
    ${pos !== undefined ? `<span class="qpos">${pos}</span>` : ""}
    <div class="qmain">${mates.length > 1 ? `<span class="pair-tag">Pair, tested together</span>` : ""}${titles}<div class="qmeta">${meta}</div>
      ${r.why ? `<div class="qwhy">${esc(r.why)}</div>` : ""}${r.hold ? holdLine(r.hold) : ""}${headMoved(r)}${trail}</div>
    <div class="qside"><div class="qtop"><b class="st ${r.state}">${STATE_WORD[r.state] ?? esc(r.state)}</b>${waitingRow ? tierMenu("pr", r.pr, r.tier) : ""}</div>
      <span>${r.state === "deployed" ? when(r.state_since) : `for ${span(r.state_since)}`}</span>${left(r.eta_at)}
      ${r.waiting_reason ? `<span class="qwait">${esc(r.waiting_reason)}</span>` : ""}${r.note ? `<span class="qnote">${esc(r.note)}</span>` : ""}${placedBy(r.rank_by)}</div></li>`;
}

const TYPE_WORD: Record<string, string> = { pr: "PR", brief: "Brief", decision: "Decision", tryit: "Try it" };

// The head moved after the person approved: the merge script stops on that, so say what moved.
function headMoved(r: (typeof S.queue)[number]): string {
  const h = r.head_moved;
  if (!h) return "";
  const what = h.change === "rebase only" ? "a rebase only, the changes are the same" : h.change === "content changed" ? "the changes are different from what you approved" : "not checked whether the changes differ";
  return `<div class="qmoved ${h.change === "content changed" ? "bad" : ""}"><b>Head moved since your approval</b> ${esc(h.from.slice(0, 7))} → ${esc(h.to.slice(0, 7))}: ${what}.</div>`;
}

function reviewRow(r: (typeof S.reviews)[number], pos: number): string {
  // A decision is answered with a tap, not reviewed: no "I'm reviewing" for it.
  const reviewable = r.type !== "decision" && r.type !== "tryit";
  const action = r.reviewing_since ? `<b class="st reviewing">You're reviewing</b>`
    : reviewable ? `<button class="btn" data-reviewing="${esc(r.thread_id)}" title="Tell ${esc(name(r.from))} you are on it">I'm reviewing</button>`
    : `<button class="btn" data-topic="${esc(r.thread_id)}">Answer</button>`;
  return `<li class="qrow review" draggable="true" data-drag-review="${esc(r.thread_id)}" data-tier="${r.tier}"><span class="qpos">${pos}</span>
    <div class="qmain"><div class="qhead"><span class="rtype t-${r.type}">${TYPE_WORD[r.type] ?? esc(r.type)}</span>${prTitle(r.pr, r.subject, r.thread_id)}</div>
      <div class="qmeta">${sizeLabel(r.size)}${r.size ? " · " : ""}From ${esc(name(r.from))} · waiting ${span(r.waiting_since)}</div>
      ${r.blocks ? `<div class="qblocks">Blocks: ${esc(r.blocks)}</div>` : ""}${r.why ? `<div class="qwhy">${esc(r.why)}</div>` : ""}</div>
    <div class="qside"><div class="qtop">${action}${tierMenu("review", r.thread_id, r.tier)}</div>
      ${r.reviewing_since ? `<span>since ${when(r.reviewing_since)}</span>` : ""}${placedBy(r.rank_by)}</div></li>`;
}

/* Everything waiting on you, in one order across types: a brief that holds an engineer can
   come before a PR. The chips filter by type; the order and tiers stay the same. */
function reviewGroup(): string {
  const f = S.reviewFilter;
  const count = (t: string) => S.reviews.filter((r) => r.type === t).length;
  const chips = ["pr", "brief", "decision", "tryit"].filter(count).map((t) =>
    `<button class="chip-f ${f === t ? "on" : ""}" data-review-filter="${t}">${TYPE_WORD[t]}s <span>${count(t)}</span></button>`).join("");
  const shown = f ? S.reviews.filter((r) => r.type === f) : S.reviews;
  const list = shown.length ? `<ol class="qlist" data-drop="review">${tiered(shown, reviewRow).join("")}</ol>` : `<p class="qempty">Nothing is waiting on you.</p>`;
  return `<section class="qgroup">
    ${chips ? `<div class="chips-f"><button class="chip-f ${f ? "" : "on"}" data-review-filter="">All</button>${chips}</div>` : ""}${list}</section>
    ${S.heldReviews.length ? `<section class="qgroup held"><h3>Not to review now <span class="count">${S.heldReviews.length}</span></h3>
      <ol class="qlist">${S.heldReviews.map(heldRow).join("")}</ol></section>` : ""}`;
}

// A row someone said not to act on now: why, and when it comes back.
const HOLD_WORD = { rework: "Being reworked", parked: "Parked" } as const;
function holdLine(h: { kind: "rework" | "parked"; note: string | null; by: string | null }): string {
  const back = h.kind === "rework" ? "Comes back with its next version." : "Stays here until it is unparked.";
  return `<div class="qhold"><b>${HOLD_WORD[h.kind]}</b>${h.note ? `: ${esc(h.note)}` : ""}${h.by ? ` · ${esc(name(h.by))}` : ""}. ${back}</div>`;
}
function heldRow(r: (typeof S.heldReviews)[number]): string {
  return `<li class="qrow review is-held"><div class="qmain"><div class="qhead"><span class="rtype t-${r.type}">${TYPE_WORD[r.type] ?? esc(r.type)}</span>${prTitle(r.pr, r.subject, r.thread_id)}</div>
    <div class="qmeta">From ${esc(name(r.from))}</div>${holdLine(r.hold)}</div></li>`;
}

function waitingSummary(): string {
  const n = (t: string) => S.reviews.filter((r) => r.type === t).length;
  return [`${n("pr")} PRs`, `${n("brief")} briefs`, `${n("decision")} decisions`, ...(n("tryit") ? [`${n("tryit")} to try`] : [])].join(" · ");
}

function queueSummary(): string {
  const n = (k: number, w: string) => `${k} ${w}`;
  return [n(S.queue.filter((r) => MOVING.includes(r.state)).length, "in progress"), n(S.queue.filter((r) => ["approved", "held", "failed"].includes(r.state)).length, "waiting")].join(" · ");
}

// Rows already come in priority order. A tier label opens each run of urgent, normal or later
// rows, so the order and the reason for it read together. Drag a row to change the order.
function tiered<T extends { tier: string }>(rows: T[], draw: (r: T, pos: number) => string): string[] {
  const out: string[] = [];
  const several = new Set(rows.map((r) => r.tier)).size > 1 || rows.some((r) => r.tier !== "normal");
  rows.forEach((r, i) => {
    if (several && (i === 0 || rows[i - 1].tier !== r.tier)) out.push(`<li class="tier-head ${r.tier}">${TIER_WORD[r.tier]}</li>`);
    out.push(draw(r, i + 1));
  });
  return out;
}

function queueView(): string {
  const live = S.queue.filter((r) => !r.hold), held = S.queue.filter((r) => r.hold);
  const moving = live.filter((r) => MOVING.includes(r.state));
  // A pair shows once, at its first member's place.
  const firstOfPair = (r: QRow, list: QRow[]) => !r.pair_id || list.find((x) => x.pair_id === r.pair_id) === r;
  const waitingAll = live.filter((r) => ["approved", "held", "failed"].includes(r.state));
  const waiting = waitingAll.filter((r) => firstOfPair(r, waitingAll));
  const done = live.filter((r) => r.state === "deployed");
  const group = (title: string, hint: string, rows: string[], count: number, kind = "") => `<section class="qgroup"><h3>${title} <span class="count">${count}</span></h3>
    ${rows.length ? `<ol class="qlist" ${kind ? `data-drop="${kind}"` : ""}>${rows.join("")}</ol>` : `<p class="qempty">${hint}</p>`}</section>`;
  return `<div class="pane-body"><div class="queue-page">
    ${group("In progress", "Nothing is merging right now.", moving.filter((r) => firstOfPair(r, moving)).map((r) => queueRow(r)), moving.length)}
    ${group("Approved, waiting their turn", "Nothing approved is waiting.", tiered(waiting, queueRow), waiting.length, "pr")}
    ${held.length ? `<section class="qgroup held"><h3>Parked or being reworked <span class="count">${held.length}</span></h3><ol class="qlist">${held.map((r) => queueRow(r)).join("")}</ol></section>` : ""}
    ${done.length ? group("Deployed today", "", done.map((r) => queueRow(r)), done.length) : ""}
    <p class="qfoot">Drag rows to set the order, or change a row's priority; your order wins over Atlas's. Atlas's merge loop takes the next ready PR with <code>dak queue next</code>. "Approved by you" is read from your verdict on the PR's thread.</p>
  </div></div>`;
}

/* Your phone: one code to scan, then Dak opens on the phone from anywhere. The code carries
   a key; whoever holds it can act as you in Dak, so it shows only here, and "Sign out phone"
   replaces the key. */
function phoneView(): string {
  const p = S.phone ?? { open: false };
  const head = `<section><h2>Your phone</h2><p class="lead">See the merge queue and PRs, approve and reply, from your phone while away from this Mac. Your Mac has to be on, awake and running Dak.</p>`;
  if (p.opening) return head + `<p class="lead">Starting the private link. This takes up to half a minute.</p></section>`;
  if (p.error) return head + `<p class="err">${esc(p.error)}</p><button class="btn primary" data-phone="open">Try again</button></section>`;
  if (!p.open || !p.link) return head + `<div class="conn sub"><span class="nm"><b>Open Dak on your phone</b><span>Starts a private link from this Mac through Cloudflare (no account needed). You scan a code once; only a phone with that code gets in. Nothing else on this Mac is reachable through it.</span></span>
    <button class="btn primary" data-phone="open">Open on phone</button></div></section>`;
  const qr = qrcode(0, "M"); qr.addData(p.link); qr.make();
  return head + `<div class="phone-pair"><div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true })}</div>
    <div class="nm"><b>Scan with your phone's camera</b><span>Then add it to your home screen (Share → Add to Home Screen) to open it like an app. The code works once per phone and is a key: don't share it.</span>
      <span class="muted">Address: ${esc(p.url)}</span>
      <div class="row"><button class="btn" data-phone="close">Close the link</button><button class="btn" data-phone="signout" title="A new key: phones signed in now are signed out">Sign out phone</button></div></div></div></section>`;
}

function reviewBody(a: any): string {
  const body = a.type === "pr" ? prView(a) : a.type === "doc" ? docView(a) : mediaView(a);
  return paneHead(a) + body;
}

// What is open beside the chat, its versions, and a way to close it so the chat takes the room.
function paneHead(a: any): string {
  const same = S.data!.messages.flatMap((m) => m.attachments.map((x) => ({ x, m })))
    .filter(({ x }) => x.type === a.type && (a.type === "pr" || x.name === a.name));
  const i = same.findIndex(({ x }) => x.id === a.id);
  const title = a.type === "pr" ? (a.meta.title ? `${a.name} · ${a.meta.title}` : a.name) : a.name;
  const versions = same.length > 1 ? `<label class="popup"><select id="version" aria-label="Version">${same.map(({ x, m }, n) => `<option value="${x.id}" ${x.id === a.id ? "selected" : ""}>Version ${n + 1} of ${same.length} · ${when(m.created_at)}</option>`).join("")}</select></label>${i < same.length - 1 ? `<button class="link" data-att="${same[same.length - 1].x.id}">Newest</button>` : ""}` : "";
  // Words, not an icon: "Unified" and "Split" say exactly what they do.
  const splitBtn = a.type === "pr" && !onPhone() ? `<div class="seg mini" role="group" aria-label="Diff layout"><button type="button" data-split-view="0" aria-pressed="${!S.split}">Unified</button><button type="button" data-split-view="1" aria-pressed="${S.split}">Split</button></div>` : "";
  const findBtn = a.type === "pr" && !S.find.open ? `<button class="icon-btn" data-find-open title="Find in this PR (⌘F)" aria-label="Find in this PR">${I.search}</button>` : "";
  // Expand and close sit together: both act on this pane, not on the conversation.
  const focusBtn = onPhone() ? "" : `<button class="icon-btn" data-focus title="${S.focus ? "Show the conversation (F)" : "Focus on the review (F)"}" aria-label="${S.focus ? "Leave focus" : "Focus"}">${S.focus ? I.collapse : I.expand}</button>`;
  // Stacked: the PR below this one, which should be approved first.
  const st = a.type === "pr" ? a.meta.stacked_on : null;
  const stack = st ? (st.thread ? `<button class="stack" data-topic="${esc(st.thread)}" title="Open the PR this one is stacked on">Stacked on ${st.number ? `#${st.number}` : esc(st.branch)}</button>`
    : st.url ? `<a class="stack" href="${esc(st.url)}" target="_blank" rel="noopener">Stacked on #${st.number}</a>` : `<span class="stack">Stacked on ${esc(st.branch)}</span>`) : "";
  return `${a.type === "pr" && S.find.open ? findBar(hits()) : ""}<div class="pane-head"><span class="ptitle" title="${esc(title)}">${esc(title)}</span>${stack}${versions}${splitBtn}${findBtn}${focusBtn}
    <button class="icon-btn" data-close-pane title="Close (Esc)" aria-label="Close">${I.close}</button></div>`;
}

function mediaView(a: any): string {
  const f = a.meta;
  const src = `/v1/blobs/${f.blob}?token=${(window as any).DAK.token}&type=${encodeURIComponent(f.mime)}`;
  // An HTML page runs in a sandbox with its own origin, from its text: it never sees Dak's
  // token or address, and it cannot navigate Dak's window away.
  const body = f.mime.startsWith("text/html") ? `<iframe class="page" sandbox="allow-scripts allow-forms allow-popups" srcdoc="${esc(S.texts.get(f.blob) ?? "")}" title="${esc(a.name)}"></iframe>`
    : /^text\//.test(f.mime) ? `<pre class="plain">${esc(S.texts.get(f.blob) ?? "")}</pre>`
    : f.mime.startsWith("application/pdf") ? `<iframe class="page" src="${src}" title="${esc(a.name)}"></iframe>`
    : f.mime.startsWith("video/") ? `<video src="${src}" controls autoplay></video>` : `<img src="${src}" alt="${esc(a.name)}">`;
  return `<div class="viewer ${/^(text|application)\//.test(f.mime) ? "pagefile" : ""}">${body}
    <div class="viewer-bar"><b>${esc(a.name)}</b><a class="link" href="${src}" target="_blank" rel="noopener">Open in browser</a></div></div>`;
}

function status(t: Thread): { label: string; cls: string } | null {
  return canReply(t) ? standing(t, S.data!.messages) : null;
}

/* ================= compose ================= */

/* New message, in two steps. First pick who: your named agents, with what each is waiting on
   you for; any other session shows only when you type its name. Then write: in that agent's
   conversation as a new topic when there is one, or here when there is not. The first line
   is the subject. Pulling in a GitHub PR to read is a link at the foot of the list. */
function composeView(): string {
  const c = S.compose!;
  if (c.mode === "pr") {
    const folders = [...new Set(S.agents.map((a) => a.where).filter(Boolean) as string[])];
    return `<div class="pane-body"><form class="form" onsubmit="return false">
      <p class="lead">Pull a pull request in from GitHub to read it here. It lands in your Inbox; without an agent's chapters it reads one file at a time.</p>
      <div class="field"><label for="c-pr">Pull request</label><input class="input" id="c-pr" value="${esc(c.pr)}" placeholder="github.com/owner/repo/pull/123, or 123"></div>
      <div class="field"><label for="c-repo">Local checkout <span class="opt">optional, for the whole-file view and Ask</span></label>
        <input class="input" id="c-repo" list="c-folders" value="${esc(c.repo)}" placeholder="/Users/you/code/repo"><datalist id="c-folders">${folders.map((f) => `<option value="${esc(f)}">`).join("")}</datalist></div>
      ${c.error ? `<p class="err">${esc(c.error)}</p>` : ""}
      <div class="btns"><button type="button" class="btn" data-cmode="message">Back</button><button type="button" class="btn primary" id="c-send" ${c.sending ? "disabled" : ""}>${c.sending ? "Pulling" : "Pull in"}</button></div>
    </form></div>`;
  }
  if (c.to) {
    // Step 2, for an agent you have no conversation with yet.
    return `<div class="pane-body"><form class="form newmsg" onsubmit="return false">
      <div class="nm-to">${mark(c.to)}<b>${esc(name(c.to))}</b><span class="sub">New topic</span><button type="button" class="link" data-to="">Change</button></div>
      <textarea id="c-body" rows="7" placeholder="First line is the subject">${esc(c.body)}</textarea>
      ${attachBar()}
      ${c.error ? `<p class="err">${esc(c.error)}</p>` : ""}
      <div class="btns"><button type="button" class="btn" data-close-compose>Cancel</button><button type="button" class="btn primary" id="c-send" ${c.sending ? "disabled" : ""}>${c.sending ? "Sending" : "Send"}</button></div>
    </form></div>`;
  }
  const f = c.filter.trim().toLowerCase();
  const waiting = (n: string) => S.threads.filter((t) => t.from === n && t.to === me && t.status === "waiting").length;
  // Who you have been talking to lately, newest first; anyone else turns up when you search.
  const lastWith = (n: string) => S.threads.filter((t) => t.from === n || t.to === n).reduce((m, t) => t.updated_at > m ? t.updated_at : m, "");
  const fortnight = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const named = S.agents.filter((a) => a.name !== me && a.kind !== "person" && lastWith(a.name) > fortnight)
    .sort((x, y) => lastWith(y.name).localeCompare(lastWith(x.name))).slice(0, 8);
  const match = (a: AgentRow) => !f || `${a.name} ${a.title ?? ""} ${a.about ?? ""} ${a.where ?? ""}`.toLowerCase().includes(f);
  const others = f ? S.agents.filter((a) => a.name !== me && !named.includes(a) && match(a)).slice(0, 20) : [];
  const row = (a: AgentRow) => {
    const w = waiting(a.name);
    // Your agents read by role; another session by its folder, so two of them can be told apart.
    const what = a.about ?? (named.includes(a) ? TOOLS[a.tool ?? ""]?.label ?? "" : a.where ? a.where.split("/").slice(-2).join("/") : TOOLS[a.tool ?? ""]?.label ?? "");
    const sub = [what, w ? `${w} waiting on you` : ""].filter(Boolean).join(" · ");
    return `<button type="button" class="pick" data-to="${esc(a.name)}">${mark(a.name)}<span class="nm"><b>${esc(name(a.name))}</b><span>${esc(sub)}</span></span></button>`;
  };
  const mine = named.filter(match);
  return `<div class="pane-body"><form class="form newmsg" onsubmit="return false">
    <div class="search big">${I.search}<input id="c-filter" value="${esc(c.filter)}" placeholder="Who is it for?" aria-label="Who is it for" autocomplete="off"></div>
    <div class="picks">${mine.length ? `<div class="group">Recent</div>${mine.map(row).join("")}` : ""}
      ${others.length ? `<div class="group">Other sessions</div>${others.map(row).join("")}` : ""}
      ${!mine.length && !others.length ? `<p class="empty">No one matches “${esc(c.filter)}”.</p>` : ""}</div>
    ${f ? "" : `<p class="note-line">Anyone else shows when you type their name.</p>`}
    <p class="note-line"><button type="button" class="link" data-cmode="pr">Pull in a GitHub PR to read</button></p>
  </form></div>`;
}

async function openCompose(mode: "message" | "pr" = "message") {
  S.compose = { mode, to: "", subject: "", body: "", filter: "", pr: "", repo: "", error: "", sending: false, ...local.get("compose", {}) };
  S.compose.mode = mode; S.compose.error = ""; S.compose.sending = false;
  S.view = "compose";
  render();
  await loadAgents(true);
  if (S.view === "compose") renderMain();
}

async function sendCompose() {
  const c = S.compose;
  if (!c || c.sending) return;
  c.error = "";
  if (c.mode === "pr" && !c.pr.trim()) { c.error = "Paste the PR link or number."; return renderMain(); }
  if (c.mode === "message" && !c.to) { c.error = "Choose who it is for."; return renderMain(); }
  if (c.mode === "message" && !c.body.trim()) { c.error = "Write something first."; return renderMain(); }
  c.sending = true; renderMain();
  try {
    const r = c.mode === "pr"
      ? await api<{ thread: Thread }>("/prs", { method: "POST", body: { pr: c.pr.trim(), repo: c.repo.trim() } })
      : await api<{ thread: Thread }>("/threads", { method: "POST", body: { to: c.to, from: me, subject: firstLine(c.body), body: c.body, attachments: S.newAtts } });
    S.newAtts = [];
    local.set("compose", {});
    S.compose = null;
    await loadList();
    await openThread(r.thread.id);
  } catch (e: any) { c.sending = false; c.error = e.message; renderMain(); }
}

/* ================= search everything ================= */

// ⌘K: every conversation, agents' threads with each other included. A hit opens its
// conversation at the message that matched.
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function renderPalette() {
  let el = $("#palette");
  if (!S.search.open) { el?.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "palette"; document.body.appendChild(el); el.innerHTML = `<div class="pal" role="dialog" aria-label="Search"><div class="pal-in">${I.search}<input id="pal-q" placeholder="Search messages, PRs, docs and agents" autocomplete="off" spellcheck="false"></div><div class="pal-list" role="listbox"></div></div>`; }
  const q = S.search.q.trim().toLowerCase();
  const mark = (t: string) => { const i = t.toLowerCase().indexOf(q); return i < 0 || !q ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`; };
  const groups = new Map<string, any[]>();
  S.search.hits.forEach((h, i) => { const p = peerOf(h); groups.set(p, [...(groups.get(p) ?? []), { ...h, i }]); });
  el.querySelector(".pal-list")!.innerHTML = !q || q.length < 2 ? `<p class="pal-empty">Type at least two letters.</p>`
    : !S.search.hits.length ? `<p class="pal-empty">Nothing matches “${esc(S.search.q)}”.</p>`
    : [...groups].map(([p, hs]) => `<div class="pal-group">${isPair(p) ? esc(peerName(p)) : esc(name(p))}</div>${hs.map((h) =>
      `<button class="pal-hit ${h.i === S.search.i ? "on" : ""}" data-hit-thread="${h.thread_id}" data-hit-mid="${h.message_id}"><span class="t"><b>${esc(h.subject)}</b><time>${when(h.created_at)}</time></span><span class="s">${esc(name(h.author))}: ${mark(h.text)}</span></button>`).join("")}`).join("");
  el.querySelector(".pal-hit.on")?.scrollIntoView({ block: "nearest" });
}

function openSearch() { S.search.open = true; renderPalette(); const i = $<HTMLInputElement>("#pal-q"); if (i) { i.value = S.search.q; i.focus(); i.select(); } }
function closeSearch() { S.search.open = false; renderPalette(); }

async function openSearchHit(thread: string, mid: number) {
  closeSearch();
  await loadList();
  await openThread(thread);
  const m = document.querySelector<HTMLElement>(`article.msg[data-mid="${mid}"]`);
  if (m) { m.scrollIntoView({ block: "center" }); m.classList.remove("found-msg"); void m.offsetWidth; m.classList.add("found-msg"); }
}

/* ================= first run ================= */

// A Dak with no conversations yet: who you are, connect your agents, and one test message
// that shows a conversation, its buttons and the notification working end to end.
function welcomeView(): string {
  const s = S.settings;
  if (!s) return `<div class="blank"><p>Loading</p></div>`;
  const tool = (id: string, label: string, on: boolean, mark: string, what: string) =>
    `<div class="conn"><span class="mark md">${mark}</span><span class="nm"><b>${label}</b><span>${on ? "Connected." : what}</span></span>
      <button class="btn ${on ? "" : "primary"}" data-connect="${on ? "off" : "on"}" data-tool="${id}" ${on ? "disabled" : ""}>${on ? `${I.check} Connected` : "Connect"}</button></div>`;
  return `<div class="pane-body"><div class="settings welcome">
    <section><h2>1 · Who you are</h2><p class="lead">Agents send to you as <code>${esc(me)}</code>, for example <code>dak send --to ${esc(me)} --from atlas --pr 12</code>. Everything stays on this Mac.</p></section>
    <section><h2>2 · Connect your agents</h2><p class="lead">Connecting delivers your replies into their sessions and teaches them how to use Dak.</p>
      ${tool("claude", "Claude Code", s.claude_connected, TOOLS["claude-code"].mark, "Replies reach every session, even an idle one.")}
      ${tool("codex", "Codex", s.codex_connected, TOOLS.codex.mark, "Replies reach a session at its next turn. Codex asks once to trust Dak's hook.")}
      ${tool("cursor", "Cursor", s.cursor_connected, TOOLS.cursor.mark, "Replies reach an agent when its turn ends.")}</section>
    <section><h2>3 · Try it</h2><p class="lead">Send yourself a message the way an agent would: with buttons to answer in one click.</p>
      <div class="btns"><button class="btn" data-welcome-test>Send a test message</button><button class="btn primary" data-welcome-done>Done</button></div></section>
  </div></div>`;
}

async function welcomeTest() {
  const r = await api<{ thread: Thread }>("/threads", { method: "POST", body: { to: me, from: "dak", subject: "Welcome to Dak",
    body: "This is how an agent's message looks. A PR arrives with chapters, a doc arrives ready for comments, and a question can come with buttons.\n\nPick one to see your answer travel back:",
    options: ["Looks good", "Show me more"] } });
  local.set("welcomed", true);
  await loadList();
  await openThread(r.thread.id);
}

/* ================= settings ================= */

function settingsView(): string {
  const s = S.settings;
  if (!s) return `<div class="blank"><p>Loading settings</p></div>`;
  const helperMark = (id: string) => TOOLS[id === "claude" ? "claude-code" : id]?.mark ?? "";
  return `<div class="pane-body"><div class="settings">
    <section><h2>Reviewing</h2>
      <label class="option toggle-row"><input type="checkbox" data-hide-tests ${S.hideTests ? "checked" : ""}><span class="nm"><b>Fold test files</b><span>Files named like <code>.test.ts</code>, <code>.spec.ts</code> or under <code>__tests__</code> open folded to their header in every PR. Show opens one.</span></span></label></section>
    <section><h2>Helper</h2><p class="lead">Answers your questions about code and documents in the Ask pane. It reads and never edits, and nothing it says is posted to a thread.</p>
      <div class="options">${s.helpers.map((h: any) => `<label class="option ${h.installed ? "" : "off"}"><input type="radio" name="helper" value="${h.id}" ${s.helper === h.id ? "checked" : ""} ${h.installed ? "" : "disabled"}>
        <span class="mark md">${helperMark(h.id)}</span><span class="nm"><b>${esc(h.label)}</b><span>${h.installed ? (h.id === "claude" ? "claude -p with read-only tools" : h.id === "codex" ? "codex exec in a read-only sandbox" : "cursor-agent -p") : "Not installed"}</span></span>${h.installed ? modelControl(h.id, s.models?.[h.id] ?? "") : ""}</label>`).join("")}</div></section>

    <section><h2>Connect agents</h2><p class="lead">A connected session gets your reply at its next turn, without polling.</p>
      <div class="conn"><span class="mark md">${TOOLS["claude-code"].mark}</span><span class="nm"><b>Claude Code</b><span>${s.claude_connected ? "Connected. Sessions get Dak mail at each turn, an idle session wakes when mail arrives, and the Dak skill teaches them to send, reply and wait." : "Adds Dak's hooks to ~/.claude/settings.json (a copy of the old file is kept) and the Dak skill to ~/.claude/skills, for every Claude Code session on this Mac."}</span></span>
        <button class="btn ${s.claude_connected ? "" : "primary"}" data-connect="${s.claude_connected ? "off" : "on"}" data-tool="claude">${s.claude_connected ? "Disconnect" : "Connect"}</button></div>
      ${s.claude_connected ? `<div class="conn sub"><span class="nm"><b>Wake closed sessions</b><span>The desktop app closes an idle session's process, and then nothing can wake it. With this on, when mail waits for a closed session, Dak runs one turn on it in the background with the mail, and tells you. Don't type into that session until the turn ends.</span></span>
        <label class="check"><input type="checkbox" data-wake-closed ${s.wake_closed ? "checked" : ""}> ${s.wake_closed ? "On" : "Off"}</label></div>` : ""}
      <div class="conn"><span class="mark md">${TOOLS.codex.mark}</span><span class="nm"><b>Codex</b><span>${s.codex_connected ? "Connected. Sessions read their Dak mail each turn, and a Dak section in ~/.codex/AGENTS.md tells them how to use it. Codex asks once to trust the hook." : "Adds Dak's hook to ~/.codex/hooks.json (a copy is kept) and a Dak section to ~/.codex/AGENTS.md. Codex asks you to trust the hook the first time a session runs it."}</span></span>
        <button class="btn ${s.codex_connected ? "" : "primary"}" data-connect="${s.codex_connected ? "off" : "on"}" data-tool="codex">${s.codex_connected ? "Disconnect" : "Connect"}</button></div>
      ${s.codex_connected ? `<div class="conn sub"><span class="nm"><b>Keep Codex listening between turns</b><span>Codex cannot be woken once idle. With this on, a Codex session waits up to an hour after each turn and picks up Dak mail the moment it arrives. It looks busy while it waits; type to it or press Esc to stop waiting. Turning it on the first time, Codex asks you to approve Dak's hook again.</span></span>
        <label class="check"><input type="checkbox" data-codex-listen ${s.codex_listen ? "checked" : ""}> ${s.codex_listen ? "On" : "Off"}</label></div>` : ""}
      <div class="conn"><span class="mark md">${TOOLS.cursor.mark}</span><span class="nm"><b>Cursor</b><span>${s.cursor_connected ? "Connected. A Cursor agent gets your reply as a follow-up when it finishes a turn." : "Adds Dak to ~/.cursor/hooks.json and keeps a copy. Your reply reaches a Cursor agent when it finishes its turn."}</span></span>
        <button class="btn ${s.cursor_connected ? "" : "primary"}" data-connect="${s.cursor_connected ? "off" : "on"}" data-tool="cursor">${s.cursor_connected ? "Disconnect" : "Connect"}</button></div>
      <div class="conn sub"><span class="nm"><b>Teach Cursor to use Dak</b><span>Cursor keeps its global rules in Settings → Rules → User Rules. Copy the instructions and paste them there. For any other agent, the same text comes from <code>dak skill --plain</code>.</span></span>
        <button class="btn" data-copy-instructions>Copy instructions</button></div>
      ${doorView()}</section>

    ${phoneView()}

    ${native ? `<section><h2>Start at login</h2><div class="conn"><span class="mark md">${I.check}</span><span class="nm"><b>Open Dak when you log in</b><span>${S.login === "approve" ? "macOS needs your OK: System Settings → General → Login Items → allow Dak." : "Keeps Dak running from the moment you log in, so new mail always shows a banner."}</span></span>
      <label class="check"><input type="checkbox" data-login ${S.login === "on" || S.login === "approve" ? "checked" : ""}> ${S.login === "on" ? "On" : S.login === "approve" ? "Waiting for macOS" : "Off"}</label></div></section>` : ""}
    <section><h2>GitHub</h2><div class="conn"><span class="mark md">${I.github}</span><span class="nm"><b>${s.github_login ? `Signed in as ${esc(s.github_login)}` : "Not signed in"}</b><span>${s.github_login ? "Pull PRs in from New message. Tick GitHub when you send a review to post it there as well." : "Run gh auth login in a terminal to pull PRs in and post reviews."}</span></span></div></section>
  </div></div>`;
}

// Claude Code takes stable aliases, so it gets a menu; the others name models that
// change often, so they get a field with the tool's default when left empty.
function modelControl(helper: string, value: string): string {
  if (helper === "claude") {
    const opts = [["", "Default model"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
    return `<span class="popup"><select data-model="claude" aria-label="Claude Code model">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${l}</option>`).join("")}</select></span>`;
  }
  const def = S.settings?.default_models?.[helper];
  const known = [...new Set([def, value].filter(Boolean))] as string[];
  return `<input class="input model" data-model="${helper}" list="models-${helper}" value="${esc(value)}" placeholder="${esc(def ? `Default (${def})` : "Default model")}" aria-label="${helper} model" spellcheck="false"><datalist id="models-${helper}">${known.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>`;
}

// Grok Bot's agent runs in a remote sandbox, so it reaches Dak through a tunnel,
// with a key that only lets it send to you and read its own replies.
function doorView(): string {
  const d = S.door;
  const head = `<span class="mark md"><span>G</span></span><span class="nm"><b>Grok Bot</b><span>${d?.open && d.url ? `Door open at <code>${esc(d.url)}</code>. Paste the instructions below into Grok once.` : d?.error ? esc(d.error) : "Runs in a remote sandbox. Open a door: a tunnel to Dak, with a key that only lets Grok send to you and read its own replies."}</span></span>`;
  const btn = d?.open ? `<button class="btn" data-door="close">Close door</button>` : `<button class="btn primary" data-door="open">${d?.opening ? "Opening" : "Open door"}</button>`;
  const steps = d?.open && d.instructions ? `<div class="door"><pre id="door-text">${esc(d.instructions)}</pre><div class="btns"><button class="btn" data-copy-door>Copy instructions</button><button class="link" data-door="rotate" title="Make a new key; the old one stops working">New key</button></div></div>` : "";
  return `<div class="conn">${head}${btn}</div>${steps}`;
}

/* ================= sending and asking ================= */

// Done takes a topic out of the conversation. If it was the one you were replying on, the
// reply moves to the next open topic with this agent.
async function markDone(id: string, on: boolean) {
  await api(`/threads/${id}/done`, { method: "POST", body: { done: on } });
  await loadList();
  if (on && id === S.cur && S.peer) { const next = topicFor(S.peer); if (next && next !== id) return openThread(next); }
  await openThread(S.cur!, true);
}

// Archive puts a conversation away until someone writes in it again; the next one opens in its place.
async function archive(peer: string, on: boolean) {
  const order = peers().map((p) => p.name);
  S.archived = await api<Record<string, string>>("/archives", { method: on ? "PUT" : "DELETE", body: { peer } });
  if (on && S.peer === peer) {
    const next = order[order.indexOf(peer) + 1] ?? order.find((n) => n !== peer);
    if (next) return openPeer(next);
    S.cur = null; S.data = null; S.peer = null;
  }
  S.counts = { to: S.threads.filter((t) => t.unread && !isArchived(peerOf(t))).length };
  render();
}

// A new topic from the reply box: a fresh thread with the agent you are talking to.
// The subject of a new topic: its first line, without Markdown marks, kept short.
const firstLine = (body: string) => body.trim().split("\n")[0].replace(/^#+\s*|[*_`]/g, "").trim().slice(0, 90);

function addLink() {
  const v = $<HTMLInputElement>("#att-link")?.value.trim() ?? "";
  if (!/^https?:\/\/\S+$/.test(v)) { toast("That is not a link: start it with https://", S.cur ?? ""); return; }
  S.newAtts.push({ type: "link", name: v.replace(/^https?:\/\//, "").slice(0, 60), url: v }); S.linkOpen = false; renderMain();
}

async function sendNewTopic() {
  const key = draftKey(), body = (S.message[key] ?? "").trim();
  const subject = firstLine(body);
  if (!body) { S.sendError = "Write something first."; return renderMain(); }
  S.sending = true; S.sendError = ""; renderMain();
  try {
    const r = await api<{ thread: Thread }>("/threads", { method: "POST", body: { to: S.peer, from: me, subject, body, attachments: S.newAtts } });
    delete S.message[key]; keepUnsent(); S.newAtts = [];
    S.newTopic = false; S.newSubject = ""; S.sending = false;
    await loadList();
    await openThread(r.thread.id);
  } catch (e: any) { S.sending = false; S.sendError = e.message ?? "Could not send."; renderMain(); }
}

async function send(force?: Verdict) {
  if (!S.data || S.sending) return;
  if (S.newTopic && !force) return sendNewTopic();
  const t = S.data.thread;
  const v = force ?? currentVerdict(t);
  const ds = drafts(t.id);
  const body = (S.message[t.id] ?? "").trim();
  if (!body && !ds.length && !v) { S.sendError = "Write a reply or add a comment first."; return renderMain(); }
  S.sending = true; S.sendError = ""; S.sendNote = ""; renderMain();
  try {
    const r = await api<any>(`/threads/${t.id}/messages`, { method: "POST", body: {
      author: me, body, verdict: v, github: !!S.github[t.id] && !!prLink(),
      comments: ds.map((d) => ({ attachment_id: d.attachment_id, anchor: d.anchor, body: d.body })), attachments: S.newAtts } });
    saveDrafts(t.id, []); delete S.message[t.id]; delete S.verdict[t.id]; keepUnsent(); S.newAtts = [];
    S.sel = null; S.editing = null; S.sending = false;
    await openThread(t.id, true);
    S.sendNote = r.github?.url ? `Posted on GitHub too${r.github.note ? `. ${r.github.note}` : ""}` : "";
    S.sendError = r.github?.error ? `Sent here. GitHub: ${r.github.error}` : "";
    renderMain();
  } catch (e: any) { S.sending = false; S.sendError = e.message ?? "Could not send."; renderMain(); }
}

// A button under an agent's message answers it in one click, on that message's topic.
async function choose(topic: string, mid: number, i: number) {
  const m = S.convo.find((t) => t.thread.id === topic)?.messages.find((x) => x.id === mid);
  const choice = m?.options?.[i];
  if (!choice || S.sending) return;
  S.sending = true; renderMain();
  try { await api(`/threads/${topic}/messages`, { method: "POST", body: { author: me, body: "", choice } }); }
  catch (e: any) { S.sendError = e.message; }
  S.sending = false;
  await openThread(topic, topic === S.cur);
}

// Open Ask with the selection attached and the cursor in the question box.
function openAsk() {
  S.pane = "ask";
  if (S.focus || onPhone()) S.dockOpen = true;
  renderMain();
  $<HTMLTextAreaElement>("#askq")?.focus();
}

async function ask(question: string) {
  if (!S.data) return;
  const t = S.data.thread.id;
  const a = findAtt(S.att);
  const ctx = S.askContext;
  const turns = (S.ask[t] ??= []);
  const turn: any = { q: question || (ctx ? "What does this do, and why is it here?" : "Summarise this in plain words."), context: ctx?.label, loading: true };
  turns.push(turn);
  S.pane = "ask"; S.askContext = null; renderMain();
  const chapter = a?.type === "pr" && S.chapter >= 0 ? chaptersOf(a)[S.chapter] : null;
  try {
    const r = await api<{ answer: string; seconds: number; command: string }>("/ask", { method: "POST", body: {
      thread_id: t, attachment_id: a?.id, question: chapter && /this chapter/i.test(turn.q) ? `${turn.q}: "${chapter.title}"` : turn.q,
      ...(ctx?.sel ? { file: ctx.sel.file, side: ctx.sel.side, start_line: ctx.sel.start, end_line: ctx.sel.end } : {}),
      ...(ctx?.quote ? { quote: ctx.quote } : {}),
      history: turns.filter((x) => x.a).map((x) => ({ q: x.q, a: x.a! })) } });
    Object.assign(turn, { loading: false, a: r.answer, seconds: r.seconds, by: r.command });
  } catch (e: any) { Object.assign(turn, { loading: false, error: e.message }); }
  if (S.cur === t) renderMain();
}

/* ================= events ================= */

document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "message" && S.cur) { S.message[draftKey()] = el.value; keepUnsent(); }
  if (el.id === "new-subject") S.newSubject = el.value;
  if (el.id === "topic-find") { S.topicFind = el.value; const l = $("#tlist"); if (l) l.innerHTML = topicRows(); }
  if (el.id === "pal-q") {
    S.search.q = el.value; S.search.i = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => { S.search.hits = await api<any[]>(`/search?q=${encodeURIComponent(S.search.q)}`).catch(() => []); renderPalette(); }, 120);
    return;
  }
  if (el.id === "find") {
    S.find.q = el.value; S.find.i = 0; S.find.list = true;
    const pos = el.selectionStart; renderMain();
    const f = $<HTMLInputElement>("#find"); f?.focus(); f?.setSelectionRange(pos, pos);
  }
  if (S.compose && el.id.startsWith("c-")) {
    const c = S.compose;
    if (el.id === "c-filter") { c.filter = el.value; const pos = el.selectionStart; renderMain(); const f = $<HTMLInputElement>("#c-filter"); f?.focus(); f?.setSelectionRange(pos, pos); }
    if (el.id === "c-subject") c.subject = el.value;
    if (el.id === "c-body") c.body = el.value;
    if (el.id === "c-pr") c.pr = el.value;
    if (el.id === "c-repo") c.repo = el.value;
    local.set("compose", { to: c.to, subject: c.subject, body: c.body, pr: c.pr, repo: c.repo });
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "topic-jump") return openThread(el.value);
  if (el.dataset.hideTests !== undefined) { S.hideTests = el.checked; local.set("hideTests", S.hideTests); return; }
  if (el.id === "att-file") return addFiles([...((el as HTMLInputElement).files ?? [])]);
  // A row's priority, set by you: it wins over the order an agent set.
  if (el.dataset.tierPr || el.dataset.tierReview) {
    const path = el.dataset.tierPr ? `/queue/${el.dataset.tierPr}/priority` : `/reviews/${el.dataset.tierReview}/priority`;
    await api(path, { method: "PUT", body: { tier: el.value, by: me } });
    await loadList(); return renderMain();
  }
  if (el.id === "topic") {
    // Moving the reply to another topic, or to a new one, takes what you typed with it.
    const from = draftKey(), to = el.value === "__new" ? `new:${S.peer}` : el.value;
    const typed = S.message[from] ?? "";
    if (typed.trim() && !(S.message[to] ?? "").trim()) { S.message[to] = typed; delete S.message[from]; keepUnsent(); }
    if (el.value === "__new") { S.newTopic = true; renderMain(); $<HTMLInputElement>("#new-subject")?.focus(); return; }
    S.newTopic = false;
    return openThread(el.value);
  }
  if (el.id === "chapter-pick") { S.chapter = Number(el.value); S.phoneFile = null; S.sel = null; S.editing = null; await prepare(); return renderMain(); }
  if (el.id === "version") { useAtt(el.value); await prepare(); return renderMain(); }
  if (el.dataset.wakeClosed !== undefined) { S.settings = await api("/settings", { method: "PUT", body: { wake_closed: el.checked } }); return renderMain(); }
  if (el.dataset.codexListen !== undefined) { S.settings = await api("/settings", { method: "PUT", body: { codex_listen: el.checked } }); return renderMain(); }
  if (el.dataset.login !== undefined) { (window as any).webkit?.messageHandlers?.dak?.postMessage({ login: el.checked }); return; }
  if (el.dataset.chapterReviewed !== undefined) return toggleRead(el.dataset.chapterReviewed ? Number(el.dataset.chapterReviewed) : S.chapter);
  if (el.dataset.check && S.att) {
    const [ch, i] = el.dataset.check.split("|").map(Number);
    const key = `checks:${S.att}:${ch}`, done = new Set(local.get(key, [] as number[]));
    el.checked ? done.add(i) : done.delete(i);
    local.set(key, [...done]);
    return renderMain();
  }
  if (el.dataset.viewed !== undefined && S.att) { setViewed(S.att, [el.dataset.viewed], el.checked); return renderMain(); }
  if (el.id === "github" && S.cur) { S.github[S.cur] = el.checked; keepUnsent(); }
  if (el.id === "verdict" && S.cur) { S.verdict[S.cur] = (el.value || null) as Verdict | null; keepUnsent(); renderMain(); }
  if (el.dataset.model) { S.settings = await api("/settings", { method: "PUT", body: { model: { helper: el.dataset.model, value: el.value } } }); return renderMain(); }
  if (el.name === "helper") { S.settings = await api("/settings", { method: "PUT", body: { helper: el.value } }); renderMain(); }
  const reader = el.closest<HTMLElement>("[data-reader]")?.dataset.reader;
  if (reader && el.dataset.field) {
    S.settings = await api("/settings", { method: "PUT", body: { reader: { name: reader, [el.dataset.field]: el.value } } });
    await loadAgents(); render();
  }
});

document.addEventListener("mousedown", (e) => { if (S.search.open && !(e.target as HTMLElement).closest(".pal")) closeSearch(); });

// ⌘-click a name in a PR's code (or in the peek) to see where it is defined and used.
document.addEventListener("click", (e) => {
  if (!(e.metaKey || e.ctrlKey) || onPhone()) return;
  const cell = (e.target as HTMLElement).closest(".diff td.tx, .peek-code td.tx");
  if (!cell || findAtt(S.att)?.type !== "pr") return;
  const w = wordAt(e.clientX, e.clientY);
  if (!w) return;
  e.preventDefault(); e.stopPropagation(); getSelection()?.removeAllRanges();
  openPeek(w, renderMain);
}, true);
// A doc: clicking commented words, or a comment's card, lights the two up together.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("button, a, textarea, input") || !getSelection()?.isCollapsed) return;
  const hl = t.closest<HTMLElement>(".docbody mark.hl, .docbody .blk.has");
  const card = t.closest<HTMLElement>(".margin .tcard");
  if (hl) setDocActive(Number(hl.dataset.docActive ?? hl.dataset.i));
  else if (card) setDocActive(Number(card.dataset.docCard));
});
// Files ride along as base64; the server stores them as blobs like any other attachment.
async function addFiles(files: File[]) {
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`, S.cur ?? ""); continue; }
    const b64 = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.readAsDataURL(f); });
    // A pasted screenshot arrives as "image.png": give it a name that tells two apart.
    const nm = /^image\.(png|jpe?g|gif|webp|heic)$/i.test(f.name) ? `Screenshot ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.${f.name.split(".").pop()}` : f.name;
    S.newAtts.push({ type: "file", name: nm, mime: f.type || "application/octet-stream", base64: b64 });
  }
  renderMain();
  $<HTMLTextAreaElement>("#message")?.focus();
}
// Paste a photo or a file into the reply (or a new message) and it is attached; pasted text stays text.
document.addEventListener("paste", (e) => {
  const where = (e.target as HTMLElement).closest?.("#composer, .composer, .newmsg, .dock");
  const files = [...(e.clipboardData?.files ?? [])];
  if (!where || !files.length) return;
  e.preventDefault();
  addFiles(files);
});
// Or drop it on the reply box.
document.addEventListener("dragover", (e) => { if ((e.target as HTMLElement).closest?.("#composer, .composer, .newmsg") && e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!(e.target as HTMLElement).closest?.("#composer, .composer, .newmsg") || !e.dataTransfer?.files.length) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
window.addEventListener("resize", () => layoutMargin());
// The ⋯ menu closes on a click anywhere else.
document.addEventListener("click", (e) => { if (S.moreOpen && !(e.target as HTMLElement).closest(".more-wrap")) { S.moreOpen = false; renderMain(); } }, true);
document.addEventListener("load", (e) => { if ((e.target as HTMLElement).closest?.(".docbody")) layoutMargin(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Meta" || e.key === "Control") document.body.classList.add("cmd"); });
document.addEventListener("keyup", (e) => { if (e.key === "Meta" || e.key === "Control") document.body.classList.remove("cmd"); });
window.addEventListener("blur", () => document.body.classList.remove("cmd"));

document.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button, [data-thread]");
  if (!b) return;
  const d = b.dataset;
  if (d.more !== undefined) { S.moreOpen = !S.moreOpen; return renderMain(); }
  if (S.moreOpen) S.moreOpen = false; // any other click closes the ⋯ menu (and still does what it does)
  if (d.docActive !== undefined) return setDocActive(Number(d.docActive));
  // The rail: Inbox shows the agents (or, already there, nothing changes); Between agents lists their threads.
  if (d.rail) {
    S.sideLevel = d.rail === "pairs" ? "pairs" : "agents";
    if (!S.sideOpen) { S.sideOpen = true; local.set("sideOpen", true); }
    const level = S.sideLevel;
    if (S.view !== "thread" && S.cur) { await openThread(S.cur); S.sideLevel = level; }
    return render();
  }
  if (d.sideBack !== undefined) { S.sideLevel = S.peer && isPair(S.peer) ? "pairs" : "agents"; return renderSide(); }
  if (d.tab) { S.sideLevel = "topics"; return openThread(d.tab); }
  if (d.tabClose) {
    const next = closeTab(d.tabClose);
    if (d.tabClose === S.cur && S.view === "thread") { if (next) return openThread(next); S.view = "waiting"; return render(); }
    return renderSide();
  }
  if (d.peekClose !== undefined) { closePeek(); return renderMain(); }
  if (d.peekBack !== undefined) { peekBackStep(); return renderMain(); }
  if (d.peekDef !== undefined && S.peek) { S.peek = { ...S.peek, def: Number(d.peekDef) }; return renderMain(); }
  if (d.peekRefs !== undefined && S.peek) { S.peek = { ...S.peek, refsOpen: !S.peek.refsOpen }; return renderMain(); }
  if (d.peekAt) {
    // A place in this PR's diff, if it is on screen, scrolls the PR there; anything else opens in the peek.
    const [file, line, inPr] = d.peekAt.split("|");
    const key = `${file}|new|${line}`;
    if (inPr === "1" && document.querySelector(`.code-col [data-key="${CSS.escape(key)}"]`)) return scrollToRow(key);
    return showSpot(file, Number(line), renderMain);
  }
  if (d.focus !== undefined) { S.focus = !S.focus; S.dockOpen = false; local.set("focus", S.focus); return render(); }
  if (d.askOpen !== undefined) return openAsk();
  if (d.dock) { S.dockOpen = d.dock === "open"; renderMain(); if (S.dockOpen) $<HTMLTextAreaElement>("#message")?.focus(); return; }
  if (d.toggleSide !== undefined) return toggleSide();
  if (d.phoneBack !== undefined) { S.phoneList = true; return render(); }
  // Back: the last place; on a phone with nowhere to go back to, the list.
  if (d.navBack !== undefined) { if (nav.idx > 0) history.back(); else if (onPhone()) { S.phoneList = true; render(); } return; }
  if (d.navFwd !== undefined) { if (nav.idx < nav.max) history.forward(); return; }
  if (d.unfold) { const k = `${S.att}:${d.unfold}`; S.unfold.has(k) ? S.unfold.delete(k) : S.unfold.add(k); return renderMain(); }
  if (d.finish === "approve") return send("approve");
  if (d.finish === "changes") { S.verdict[S.cur!] = "changes"; keepUnsent(); return writeReview(); }
  if (d.finish === "reply") return writeReview();
  if (d.compose !== undefined) return openCompose();
  if (d.cmode && S.compose) { S.compose.mode = d.cmode as any; S.compose.error = ""; return renderMain(); }
  if (d.closeCompose !== undefined) { S.compose = null; S.view = "thread"; return render(); }
  if (d.to !== undefined && S.compose) {
    // Someone you already talk to: write the new topic in their conversation, like a reply.
    const existing = d.to ? topicFor(d.to) : null;
    if (existing) {
      const typed = S.compose.body;
      S.compose = null; await openThread(existing);
      S.newTopic = true; if (typed.trim()) S.message[draftKey()] = typed;
      renderMain(); $<HTMLTextAreaElement>("#message")?.focus(); return;
    }
    S.compose.to = d.to; S.compose.error = ""; local.set("compose", { ...S.compose }); renderMain();
    $<HTMLTextAreaElement>("#c-body")?.focus(); return;
  }
  if (d.openLink !== undefined) { S.linkOpen = true; renderMain(); $<HTMLInputElement>("#att-link")?.focus(); return; }
  if (d.addLink !== undefined) { addLink(); return; }
  if (d.removeAtt !== undefined) { S.newAtts.splice(Number(d.removeAtt), 1); return renderMain(); }
  if (b.id === "c-send") return sendCompose();
  if (d.queue !== undefined) { S.view = "queue"; S.phoneList = false; return render(); }
  if (d.waiting !== undefined) { S.view = "waiting"; S.phoneList = false; return render(); }
  if (d.reviewFilter !== undefined) { S.reviewFilter = d.reviewFilter; local.set("reviewFilter", S.reviewFilter); return renderMain(); }
  if (d.allTopics !== undefined) { S.allTopics = !S.allTopics; local.set("allTopics", S.allTopics); S.scrollTo = "end"; return renderMain(); }
  if (d.reviewing) {
    // "I'm on it": the sender hears through Dak, and the PR stays waiting on you.
    await api(`/threads/${d.reviewing}/reviewing`, { method: "POST", body: { author: me } });
    await loadList(); return render();
  }
  if (d.settings !== undefined) { S.view = "settings"; askLogin(); render(); await Promise.all([loadSettings(), loadAgents(true)]); return render(); }
  if (d.phone) {
    if (d.phone === "open") {
      S.phone = { opening: true }; renderMain();
      try { S.phone = await api("/phone", { method: "POST" }); } catch (err: any) { S.phone = { error: err.message }; }
    } else S.phone = await api(`/phone${d.phone === "signout" ? "?signout=1" : ""}`, { method: "DELETE" });
    return renderMain();
  }
  if (d.door) {
    if (d.door === "close") { await api("/door?revoke=", { method: "DELETE" }); S.door = { open: false }; return renderMain(); }
    S.door = { ...(S.door ?? {}), opening: true }; renderMain();
    try { S.door = await api("/door", { method: "POST", body: { agent: "grok", rotate: d.door === "rotate" } }); }
    catch (err: any) { S.door = { open: false, error: err.message }; }
    return renderMain();
  }
  if (d.welcomeTest !== undefined) return welcomeTest();
  if (d.welcomeDone !== undefined) { local.set("welcomed", true); S.view = "thread"; return render(); }
  if (d.copyInstructions !== undefined) {
    try { await navigator.clipboard.writeText(S.settings?.instructions ?? ""); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy instructions"; }, 1500); } catch { b.textContent = "Could not copy"; }
    return;
  }
  if (d.copyDoor !== undefined) {
    const text = $("#door-text")?.textContent ?? "";
    try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { getSelection()?.selectAllChildren($("#door-text")!); }
    return;
  }
  if (d.connect) { S.settings = await api(`/connect/${d.tool ?? "claude"}`, { method: d.connect === "on" ? "POST" : "DELETE" }); return renderMain(); }
  if (d.choose !== undefined && d.mid) return choose(d.in!, Number(d.mid), Number(d.choose));
  if (d.done) return markDone(d.done, d.on !== "0");
  if (d.showDone !== undefined) { S.showDone = !S.showDone; return renderMain(); }
  if (d.archive) return archive(d.archive, true);
  if (d.unarchive) return archive(d.unarchive, false);
  if (d.showArchived !== undefined) { S.showArchived = !S.showArchived; return renderSide(); }
  if (d.phoneFile !== undefined) {
    // An open file replaces the page; closing it puts the page back where it was.
    if (!S.phoneFile) phonePageTop = $(".phone-pr")?.scrollTop ?? 0;
    S.phoneFile = d.phoneFile || null; S.phoneFileChapter = Number(d.ch ?? -1);
    renderMain();
    if (S.phoneFile) $(".psheet-body")?.scrollTo({ top: 0 });
    else { const pp = $(".phone-pr"); if (pp) pp.scrollTop = phonePageTop; }
    return;
  }
  // The file's Reviewed on a phone: a big button in the sheet's bar, not a tiny box in a pinned header.
  if (d.toggleViewed && S.att) {
    const top = $(".psheet-body")?.scrollTop ?? 0;
    setViewed(S.att, [d.toggleViewed], !viewed(S.att).has(d.toggleViewed)); renderMain();
    const sb = $(".psheet-body"); if (sb) sb.scrollTop = top;
    return;
  }
  if (d.phoneTab) { S.phoneTab = d.phoneTab as any; S.phoneFile = null; renderMain(); $(".phone-pr")?.scrollTo({ top: 0 }); return; }
  if (d.gotoFile) {
    // Bring the file to the top of the code column, under any pinned header.
    const card = document.querySelector<HTMLElement>(`.fcard[data-file="${CSS.escape(d.gotoFile)}"]`);
    const box = card?.closest<HTMLElement>("#code-scroll, #reading");
    if (card && box) box.scrollTo({ top: box.scrollTop + card.getBoundingClientRect().top - box.getBoundingClientRect().top - 12 });
    return;
  }
  if (d.splitView !== undefined) { S.split = d.splitView === "1"; local.set("split", S.split); return renderMain(); }
  if (d.searchOpen !== undefined) return openSearch();
  if (d.hitThread) return openSearchHit(d.hitThread, Number(d.hitMid));
  if (d.findOpen !== undefined) return openFind();
  if (d.findClose !== undefined) { S.find.open = false; return renderMain(); }
  if (d.findStep) return goToHit(S.find.i + Number(d.findStep));
  if (d.hit !== undefined) return goToHit(Number(d.hit));
  if (d.peer) { S.sideLevel = "topics"; return openPeer(d.peer); }
  if (d.thread) return openThread(d.thread);
  if (d.topic) {
    // A folded topic opens in place; any other divider moves your reply to that topic.
    const t = S.convo.find((x) => x.thread.id === d.topic);
    if (t?.thread.status === "closed" && d.topic !== S.cur && !S.openTopics.has(d.topic)) { S.openTopics.add(d.topic); return renderMain(); }
    return openThread(d.topic);
  }
  if (d.moreTopics !== undefined) { S.topicCap += 20; await loadConvo(); return renderMain(); }
  if (d.att && d.in && d.in !== S.cur) { const att = d.att; await openThread(d.in); useAtt(att); await prepare(); return renderMain(); }
  if (d.pane) { S.pane = d.pane as any; if (S.focus || onPhone()) S.dockOpen = d.pane === "ask"; return renderMain(); }
  if (d.closePane !== undefined) { S.att = null; S.paneClosed = true; S.focus = false; S.dockOpen = false; local.set("focus", false); S.sel = null; S.editing = null; return render(); }
  if (d.att) { S.paneClosed = false; }
  if (d.att) { useAtt(d.att); S.sel = null; S.editing = null; await prepare(); return renderMain(); }
  // On a phone every chapter is on one page: go there and bring the chapter into view.
  if (d.chapter !== undefined && onPhone()) {
    S.phoneTab = "guide"; S.phoneFile = null; renderMain();
    const i = Math.max(0, Number(d.chapter));
    const pp = $(".phone-pr"), sec = $(`#pch-${i}`);
    if (pp && sec) pp.scrollTop = sec.offsetTop - ($(".ptabs")?.offsetHeight ?? 0);
    return;
  }
  if (d.chapter !== undefined) { S.chapter = Number(d.chapter); S.phoneFile = null; S.sel = null; S.editing = null; await prepare(); renderMain(); $("#reading")?.scrollTo({ top: 0 }); return; }
  if (d.mode) { const [path, mode] = d.mode.split("|"); S.fileMode[`${S.att}:${path}`] = mode as any; return renderMain(); }
  if (d.reviewed !== undefined) return toggleRead();
  if (d.jump) {
    const [file, side, line] = d.jump.split("|");
    if (side === "old") S.fileMode[`${S.att}:${file}`] = "diff";
    renderMain();
    return scrollToRow(`${file}|${side}|${line}`);
  }
  if (d.line && dragged) { dragged = false; return; }
  if (d.line) {
    const [file, side, n] = d.line.split("|"); const line = Number(n);
    const s = S.sel;
    S.sel = (e as MouseEvent).shiftKey && s && s.file === file && s.side === side && s.att === S.att
      ? { ...s, start: Math.min(s.start, line), end: Math.max(s.end, line) }
      : { att: S.att!, file, side: side as "old" | "new", start: line, end: line };
    S.editing = null;
    return renderMain();
  }
  if (d.comment !== undefined && S.sel) {
    const s = S.sel;
    S.editing = { key: selKey(s), att: s.att, label: selLabel(s), anchor: { kind: "code", file: s.file, side: s.side, start_line: s.start, end_line: s.end } };
    return renderMain();
  }
  if (d.askSel !== undefined && S.sel) { S.askContext = { label: selLabel(S.sel), sel: { ...S.sel } }; S.sel = null; return openAsk(); }
  if (d.clear !== undefined) { S.sel = null; S.editing = null; return renderMain(); }
  if (d.block) {
    const a = findAtt(S.att); if (a?.type !== "doc") return;
    const blk = S.docs.get(a.meta.blob)![Number(d.block)];
    S.docActive = blk.index;
    S.editing = { key: `${a.id}|b${blk.index}`, att: a.id, label: blk.text.slice(0, 90) || `Paragraph ${blk.index + 1}`,
      anchor: { kind: "doc", version: a.meta.version, block_index: blk.index, block_hash: blk.hash, quote: blk.text.slice(0, 160) } };
    return renderMain();
  }
  if (d.selcomment !== undefined) return commentOnSelection();
  if (d.selask !== undefined && pending) { S.askContext = { label: `“${pending.text.slice(0, 60)}”`, quote: pending.text }; clearPending(); window.getSelection()?.removeAllRanges(); return openAsk(); }
  if (d.cancel !== undefined) { S.editing = null; return renderMain(); }
  if (d.save !== undefined) return saveComment();
  if (d.del) { saveDrafts(S.cur!, drafts(S.cur!).filter((x) => x.id !== d.del)); return renderMain(); }
  if (d.v !== undefined) { S.verdict[S.cur!] = (d.v || null) as Verdict | null; keepUnsent(); return renderMain(); }
  if (d.prompt) return ask(d.prompt);
  if (d.clearContext !== undefined) { S.askContext = null; return renderMain(); }
  if (b.id === "send") return send();
  if (b.id === "approve") return send("approve");
  if (b.id === "askgo") { const q = $<HTMLTextAreaElement>("#askq")?.value.trim() ?? ""; if (q || S.askContext) return ask(q); }
});

// In focus the sidebar is hidden for the review; the button shows it without leaving focus.
function toggleSide() {
  const review = S.view === "thread" && ["pr", "doc"].includes(findAtt(S.att)?.type ?? "");
  if (S.focus && review) S.focusSide = !S.focusSide;
  else { S.sideOpen = !S.sideOpen; local.set("sideOpen", S.sideOpen); }
  render();
}

// The end of the last chapter: put the cursor in the reply, wherever the reply is.
function writeReview() {
  S.pane = "chat";
  if (S.focus || onPhone()) S.dockOpen = true;
  renderMain();
  const m = $<HTMLTextAreaElement>("#message");
  if (m) { m.focus(); m.closest("form")?.classList.add("flash"); setTimeout(() => m.closest("form")?.classList.remove("flash"), 900); }
}

function commentOnSelection() {
  if (!pending) return;
  const a = findAtt(pending.att);
  if (a?.type !== "doc") return;
  const blk = S.docs.get(a.meta.blob)![pending.block];
  S.docActive = blk.index;
  S.editing = { key: `${a.id}|b${blk.index}|${pending.text}`, att: a.id, label: pending.text,
    anchor: { kind: "doc", version: a.meta.version, block_index: blk.index, block_hash: blk.hash, quote: pending.text, exact: true } };
  clearPending();
  window.getSelection()?.removeAllRanges();
  renderMain();
}

function saveComment() {
  const text = $<HTMLTextAreaElement>("#edit")?.value.trim();
  if (!S.editing || !S.cur) return;
  if (!text) { $<HTMLTextAreaElement>("#edit")?.focus(); return; }
  saveDrafts(S.cur, [...drafts(S.cur), { id: Math.random().toString(36).slice(2), attachment_id: S.editing.att, anchor: S.editing.anchor, body: text, label: S.editing.label }]);
  S.editing = null; S.sel = null;
  renderMain();
}

function toggleRead(i = S.chapter) {
  const a = findAtt(S.att); if (!a || a.type !== "pr" || i < 0) return;
  const files = chapterFiles(chaptersOf(a)[i]);
  const v = viewed(a.id);
  setViewed(a.id, files, !files.every((f) => v.has(f)));
  renderMain();
}

document.addEventListener("mouseup", (e) => {
  if ((e.target as HTMLElement).closest("#selpop")) return;
  if (lineDrag) { finishLineDrag(e); return; }
  setTimeout(() => { readSelection(); readCodeSelection(); }, 0);
});

// Dragging down the line numbers selects a range, as shift-click does.
let lineDrag: { file: string; side: string; from: number } | null = null;
let dragged = false;
document.addEventListener("mousedown", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-line]");
  if (!b || e.shiftKey) return;
  const [file, side, n] = b.dataset.line!.split("|");
  lineDrag = { file, side, from: Number(n) };
  dragged = false;
});
document.addEventListener("mouseover", (e) => {
  if (!lineDrag) return;
  const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-line]");
  if (!b) return;
  const [file, side, n] = b.dataset.line!.split("|");
  if (file !== lineDrag.file || side !== lineDrag.side) return;
  const lo = Math.min(lineDrag.from, Number(n)), hi = Math.max(lineDrag.from, Number(n));
  if (hi > lo) dragged = true;
  document.querySelectorAll(".drag").forEach((r) => r.classList.remove("drag"));
  for (let i = lo; i <= hi; i++) document.querySelectorAll(`[data-key="${CSS.escape(`${file}|${side}|${i}`)}"]`).forEach((r) => r.classList.add("drag"));
});
function finishLineDrag(e: MouseEvent) {
  const d = lineDrag!; lineDrag = null;
  const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-line]");
  if (!dragged || !b) return;
  const [, , n] = b.dataset.line!.split("|");
  S.sel = { att: S.att!, file: d.file, side: d.side as "old" | "new", start: Math.min(d.from, Number(n)), end: Math.max(d.from, Number(n)) };
  S.editing = null;
  renderMain();
}

// Selecting the code itself selects those lines: the bar with Comment and Ask appears under them.
function readCodeSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const rowOf = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement)?.closest<HTMLElement>("[data-key]");
  const a = rowOf(range.startContainer), z = rowOf(range.endContainer);
  if (!a || !z || a === z && sel.toString().trim().length < 2) return;
  // Side by side: the selection runs down one column, so its two ends name the range.
  if (a.tagName === "TD") {
    const [fa, sa, la] = a.dataset.key!.split("|"), [fz, sz, lz] = z.dataset.key!.split("|");
    if (fa !== fz || sa !== sz) return;
    S.sel = { att: S.att!, file: fa, side: sa as "old" | "new", start: Math.min(+la, +lz), end: Math.max(+la, +lz) };
    S.editing = null; sel.removeAllRanges(); renderMain(); return;
  }
  const rows: HTMLElement[] = [];
  for (let r: Element | null = a; r; r = r.nextElementSibling) { if ((r as HTMLElement).dataset.key) rows.push(r as HTMLElement); if (r === z) break; }
  const keys = rows.map((r) => r.dataset.key!.split("|"));
  const file = keys[0][0];
  if (keys.some((k) => k[0] !== file)) return;
  // A range that mixes removed and added lines anchors to the added (new) side.
  const side = keys.every((k) => k[1] === "old") ? "old" : "new";
  const lines = keys.filter((k) => k[1] === side).map((k) => Number(k[2]));
  if (!lines.length) return;
  S.sel = { att: S.att!, file, side, start: Math.min(...lines), end: Math.max(...lines) };
  S.editing = null;
  sel.removeAllRanges();
  renderMain();
}
document.addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).closest("#selpop")) e.preventDefault(); });
document.addEventListener("scroll", () => { if (pending) readSelection(); }, true);

document.addEventListener("keydown", (e) => {
  if (S.moreOpen && e.key === "Escape") { e.preventDefault(); S.moreOpen = false; return renderMain(); }
  if (S.peek && e.key === "Escape") { e.preventDefault(); closePeek(); return renderMain(); }
  if (S.peek && (e.metaKey || e.ctrlKey) && e.key === "[" && S.peekBack.length) { e.preventDefault(); peekBackStep(); return renderMain(); }
  if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "]")) { e.preventDefault(); return e.key === "[" ? (nav.idx > 0 && history.back()) : (nav.idx < nav.max && history.forward()); }
  if (e.key === "Enter" && (e.target as HTMLElement)?.id === "att-link") { e.preventDefault(); return addLink(); }
  const id = document.activeElement?.id ?? "";
  const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (id === "edit") saveComment();
    else if (id === "askq") { const q = $<HTMLTextAreaElement>("#askq")!.value.trim(); if (q || S.askContext) ask(q); }
    else if (S.view === "compose") sendCompose();
    else send();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return S.search.open ? closeSearch() : openSearch(); }
  if (id === "pal-q") {
    const n = S.search.hits.length;
    if (e.key === "Escape") { e.preventDefault(); return closeSearch(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (n) { S.search.i = (S.search.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n; renderPalette(); } return; }
    if (e.key === "Enter") { e.preventDefault(); const h = S.search.hits[S.search.i]; if (h) openSearchHit(h.thread_id, h.message_id); return; }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && findAtt(S.att)?.type === "pr" && S.view === "thread") { e.preventDefault(); return openFind(); }
  if (id === "find") {
    // While the list is open, Return goes to the highlighted match; after that it steps.
    if (e.key === "Enter") { e.preventDefault(); return goToHit(S.find.list ? S.find.i : S.find.i + (e.shiftKey ? -1 : 1)); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); S.find.i = Math.max(0, Math.min(hits().length - 1, S.find.i + (e.key === "ArrowDown" ? 1 : -1))); renderMain(); $<HTMLInputElement>("#find")?.focus(); return; }
    if (e.key === "Escape") { e.preventDefault(); S.find.open = false; return renderMain(); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); return toggleSide(); }
  if (e.key === "Escape") {
    if (pending) { clearPending(); return; }
    if (S.find.open) { S.find.open = false; return renderMain(); }
    if (S.dockOpen) { S.dockOpen = false; return renderMain(); }
    if (S.editing || S.sel) { S.editing = null; S.sel = null; return renderMain(); }
    if (S.view === "thread" && S.att && !S.focus) { S.att = null; S.paneClosed = true; return render(); }
    if (S.view !== "thread") { S.view = "thread"; S.compose = null; return render(); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "c" && pending) { e.preventDefault(); return commentOnSelection(); }
  if (k === "n") { e.preventDefault(); openCompose(); return; }
  if (k === "e" && S.view === "thread" && S.peer) { e.preventDefault(); return archive(S.peer, !isArchived(S.peer)); }
  // [ and ]: the previous and next topic with this agent, in the topic bar's order.
  if ((k === "[" || k === "]") && S.view === "thread" && S.cur) {
    const open = openTopics(); const i = open.findIndex((t) => t.id === S.cur); const t = open[i + (k === "[" ? -1 : 1)];
    if (t) { e.preventDefault(); return openThread(t.id); }
  }
  if (k === "f" && S.view === "thread" && ["pr", "doc"].includes(findAtt(S.att)?.type ?? "")) { e.preventDefault(); S.focus = !S.focus; S.dockOpen = false; local.set("focus", S.focus); return render(); }
  if (k === "a" && S.view === "thread") { e.preventDefault(); return openAsk(); }
  if (k === "r" && S.focus) { e.preventDefault(); S.dockOpen = true; renderMain(); $<HTMLTextAreaElement>("#message")?.focus(); return; }
  const a = findAtt(S.att);
  if (S.view !== "thread" || !a || a.type !== "pr") return;
  const n = chaptersOf(a).length;
  if (k === "j" && S.chapter < n - 1) { S.chapter++; S.sel = null; prepare().then(() => { renderMain(); $("#reading")?.scrollTo({ top: 0 }); }); }
  if (k === "k" && S.chapter > -1) { S.chapter--; S.sel = null; prepare().then(() => { renderMain(); $("#reading")?.scrollTo({ top: 0 }); }); }
  if (k === "v") toggleRead();
});

/* ================= resizable panes ================= */

const WIDTHS: Record<string, { min: number; max: number; def: number; invert?: boolean }> = {
  side: { min: 200, max: 420, def: 264 }, chat: { min: 280, max: 620, def: 340 },
  rail: { min: 170, max: 380, def: 232 }, notes: { min: 260, max: 600, def: 380 }, margin: { min: 220, max: 460, def: 280, invert: true },
};
const setWidth = (k: string, px: number) => document.documentElement.style.setProperty(`--${k}-w`, `${px}px`);
for (const [k, v] of Object.entries(local.get("widths", {} as Record<string, number>))) if (WIDTHS[k]) setWidth(k, v);

document.addEventListener("pointerdown", (e) => {
  const sp = (e.target as HTMLElement).closest<HTMLElement>(".splitter");
  if (!sp || e.button !== 0) return;
  e.preventDefault();
  const k = sp.dataset.split!, cfg = WIDTHS[k];
  const start = e.clientX, startW = sp.parentElement!.getBoundingClientRect().width;
  sp.setPointerCapture(e.pointerId);
  sp.classList.add("active"); document.body.classList.add("resizing");
  let w = startW;
  const move = (ev: PointerEvent) => {
    w = Math.round(Math.min(cfg.max, Math.max(cfg.min, startW + (cfg.invert ? start - ev.clientX : ev.clientX - start))));
    setWidth(k, w);
  };
  const up = () => {
    sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up);
    sp.classList.remove("active"); document.body.classList.remove("resizing");
    local.set("widths", { ...local.get("widths", {}), [k]: w });
    postControls();
  };
  sp.addEventListener("pointermove", move); sp.addEventListener("pointerup", up);
});
document.addEventListener("dblclick", (e) => {
  const sp = (e.target as HTMLElement).closest<HTMLElement>(".splitter");
  if (!sp) return;
  const k = sp.dataset.split!;
  setWidth(k, WIDTHS[k].def);
  const saved = local.get("widths", {} as Record<string, number>); delete saved[k]; local.set("widths", saved);
});

/* ================= native bridge and live updates ================= */

const askLogin = () => (window as any).webkit?.messageHandlers?.dak?.postMessage({ loginState: true });

// The Mac shell drags the window from the empty parts of the tab row along the top.
// It needs to know where the controls are, so clicks on them still land.
function postControls() {
  const h = (window as any).webkit?.messageHandlers?.dak;
  if (!h) return;
  const rects = [...document.querySelectorAll(".toolbar button, .toolbar a, .side-top button, #tabs button")].map((el) => {
    const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height];
  });
  h.postMessage({ controls: rects, unread: S.counts.to });
}
addEventListener("resize", postControls);

// The Mac menu bar (Settings, New Message) calls in here.
(window as any).dak = {
  settings: async () => { S.view = "settings"; askLogin(); render(); await Promise.all([loadSettings(), loadAgents(true)]); render(); },
  compose: () => openCompose(),
  find: () => openFind(),
  loginState: (state: string) => { S.login = state; if (S.view === "settings") renderMain(); },
};

function toast(text: string, thread: string) {
  // In the Mac app the system banner covers Dak in the background; in front, the banner is
  // held back so it does not pop over Dak itself, and this toast shows instead.
  if (native && !document.hasFocus()) return;
  const el = $("#toast")!;
  el.innerHTML = `<b>${esc(text)}</b>`;
  el.hidden = false;
  el.onclick = () => { el.hidden = true; loadList().then(() => openThread(thread)); };
  clearTimeout((toast as any).t);
  (toast as any).t = setTimeout(() => { el.hidden = true; }, 6000);
}

let seen = new Set<string>();
async function refresh() {
  await loadList();
  // A sender Dak has not seen yet (a new Codex or Cursor session) gets its tool's logo.
  const known = new Set(S.agents.map((a) => a.name));
  if ([...S.threads, ...S.others].some((t) => !known.has(t.from) || !known.has(t.to))) { await loadAgents(); renderSide(); }
  const mine = S.threads;
  for (const t of mine) {
    const key = `${t.id}:${t.updated_at}`;
    if (t.unread && !seen.has(key) && peerOf(t) !== S.peer && t.last_author !== me) toast(`${name(t.last_author || t.from)}: ${t.subject}`, t.id);
    seen.add(key);
  }
  const typing = document.activeElement?.matches("textarea, input");
  // Anything new with the agent on screen redraws its conversation, whichever topic it is on.
  const changed = mine.some((t) => peerOf(t) === S.peer && onThread(t)
    && S.convo.find((c) => c.thread.id === t.id)?.thread.updated_at !== t.updated_at);
  if (S.view === "thread" && S.cur && !typing && changed) openThread(S.cur, true);
}

// Back in front: what is on screen is now read, so the badge and the notifier agree.
addEventListener("focus", () => { if (S.view === "thread" && S.cur) { forgetConvo(); openThread(S.cur, true); } });

/* Back and forward. Every place you go (a conversation, a PR's chapter or tab, a file, the
   queues, settings) is a history entry, so the ‹ › buttons, ⌘[ ⌘] and the browser's own back
   (or a swipe on a phone) walk the same list. Restoring a place never adds a new one. */
type Place = { view: string; cur: string | null; att: string | null; chapter: number; phoneList: boolean; phoneTab: string; phoneFile: string | null; phoneFileChapter: number };
let phonePageTop = 0; // where the phone PR page was when a file opened over it
const place = (): Place => ({ view: S.view, cur: S.cur, att: S.att, chapter: S.chapter, phoneList: S.phoneList, phoneTab: S.phoneTab, phoneFile: S.phoneFile, phoneFileChapter: S.phoneFileChapter });
const navKey = (p: Place | null) => p ? [p.view, p.view === "thread" ? `${p.cur}|${p.att}|${p.chapter}|${p.phoneTab}|${p.phoneFile}` : "", p.phoneList].join("~") : "";
let restoring = false;
const nav = { idx: 0, max: 0 };
function remember() {
  if (restoring || S.view === "compose" && !S.compose) return;
  const p = place(), cur = history.state as (Place & { idx?: number }) | null;
  if (navKey(cur) === navKey(p)) return;
  const url = S.view === "thread" && S.cur ? `#${S.cur}` : location.pathname + location.search;
  try {
    if (!cur) { history.replaceState({ ...p, idx: 0 }, "", url); return; }
    nav.idx = (cur.idx ?? nav.idx) + 1; nav.max = nav.idx;
    history.pushState({ ...p, idx: nav.idx }, "", url);
  } catch { /* history is a convenience */ }
  updateNavButtons();
}
addEventListener("popstate", async (e: PopStateEvent) => {
  const p = e.state as (Place & { idx?: number }) | null;
  if (!p) return;
  nav.idx = p.idx ?? 0;
  restoring = true;
  try {
    if (p.view === "thread" && p.cur && p.cur !== S.cur) await openThread(p.cur, true);
    Object.assign(S, { view: p.view, att: p.att, chapter: p.chapter, phoneList: p.phoneList, phoneTab: p.phoneTab, phoneFile: p.phoneFile, phoneFileChapter: p.phoneFileChapter });
    if (p.view !== "thread") S.compose = null;
    await prepare(); render();
  } finally { restoring = false; updateNavButtons(); }
});
function updateNavButtons() {
  $<HTMLButtonElement>("[data-nav-back]")?.toggleAttribute("disabled", nav.idx <= 0);
  $<HTMLButtonElement>("[data-nav-fwd]")?.toggleAttribute("disabled", nav.idx >= nav.max);
}

/* Drag to reorder the queue's waiting rows or your review list. The new order is saved as
   yours, so an agent's reordering leaves it alone. */
let dragging: HTMLElement | null = null;
document.addEventListener("dragstart", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-drag-pr], [data-drag-review]");
  if (!row) return;
  dragging = row; row.classList.add("dragging");
  e.dataTransfer?.setData("text/plain", row.dataset.dragPr ?? row.dataset.dragReview ?? "");
});
document.addEventListener("dragover", (e) => {
  if (!dragging) return;
  const list = (e.target as HTMLElement).closest<HTMLElement>("[data-drop]");
  if (!list || !list.contains(dragging)) return;
  e.preventDefault();
  const over = (e.target as HTMLElement).closest<HTMLElement>(".qrow");
  if (!over || over === dragging) return;
  const box = over.getBoundingClientRect();
  list.insertBefore(dragging, e.clientY < box.top + box.height / 2 ? over : over.nextSibling);
});
document.addEventListener("dragend", async () => {
  const row = dragging; dragging = null;
  if (!row) return;
  row.classList.remove("dragging");
  const list = row.closest<HTMLElement>("[data-drop]")!;
  // Dropped among another tier's rows, it joins that tier: the place you put it is where it goes.
  const rows = [...list.querySelectorAll<HTMLElement>("[data-tier]")];
  const i = rows.indexOf(row);
  const near = rows[i - 1] ?? rows[i + 1]; // the row above it, or below when it is now first
  const tier = near && near.dataset.tier !== row.dataset.tier ? near.dataset.tier : undefined;
  try {
    if (list.dataset.drop === "pr") {
      const prs = [...list.querySelectorAll<HTMLElement>("[data-drag-pr]")].map((x) => Number(x.dataset.dragPr));
      // A pair moves as one: its other half follows its first.
      const withMates = prs.flatMap((p) => { const r = S.queue.find((x) => x.pr === p); return r?.pair_id ? S.queue.filter((x) => x.pair_id === r.pair_id).map((x) => x.pr) : [p]; });
      if (tier) await api(`/queue/${row.dataset.dragPr}/priority`, { method: "PUT", body: { tier, by: me } });
      await api("/queue/order", { method: "PUT", body: { prs: withMates, by: me } });
    } else {
      if (tier) await api(`/reviews/${row.dataset.dragReview}/priority`, { method: "PUT", body: { tier, by: me } });
      await api("/reviews/order", { method: "PUT", body: { threads: [...list.querySelectorAll<HTMLElement>("[data-drag-review]")].map((x) => x.dataset.dragReview), by: me } });
    }
  } catch (err: any) { toast(err.message ?? "Could not save that order.", S.cur ?? ""); }
  await loadList(); renderMain();
});

// The queue's "for 6 min" and "about 4 min left" move with the clock.
setInterval(() => { if ((S.view === "queue" || S.view === "waiting") && !document.hidden) renderMain(); }, 30_000);

function listen() {
  const es = new EventSource(`/v1/events?token=${(window as any).DAK.token}`);
  es.addEventListener("message", () => refresh());
  es.onerror = () => { es.close(); setTimeout(listen, 3000); };
}

(async function start() {
  await Promise.all([loadAgents(), loadSettings()]);
  await loadList();
  const mine = S.threads;
  seen = new Set(mine.map((t) => `${t.id}:${t.updated_at}`));
  const fromHash = location.hash.slice(1);
  // The app opens on a fresh page, so the last conversation comes from this Mac's memory, not the URL.
  const target = mine.find((t) => t.id === fromHash) ?? [...mine, ...S.others].find((t) => t.id === local.get("last", ""));
  const first = target?.id ?? (S.threads[0] ? topicFor(peerOf(S.threads[0])) : null);
  if (first) await openThread(first);
  else { if (!local.get("welcomed", false)) S.view = "welcome"; render(); }
  // A phone opens on the list, merge queue first, unless the link named a thread.
  if (onPhone() && !mine.some((t) => t.id === fromHash)) { S.view = "waiting"; S.phoneList = true; render(); }
  listen();
})();
