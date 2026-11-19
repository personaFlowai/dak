/* The window's frame on the Mac: a thin rail of places on the left, tabs along the top for what
   you have open, and a sidebar that drills in (agents, then one agent's topics, with Back).
   Three columns, so the review pane keeps its width. The phone keeps its own two screens. */
import { S, esc, name, mark, me, agentOf, onPhone } from "./state";
import { local } from "./api";
import { everyThread, isPair, peerList, archivedList, pairList, peerName, peerOf } from "./convo";
import { topicRows } from "./topics";
import { I } from "./icons";
import { P, youCount } from "./places";

export type SideLevel = "agents" | "topics" | "pairs";

/* The places. On the Mac, a rail down the left; on the phone, the tab bar along the bottom,
   each with a short name under its icon, as iPhone apps do. */
export function railView(): string {
  const phone = onPhone();
  const youN = youCount();
  const workN = P.work.filter((w) => w.state !== "done").length;
  // The phone's Inbox and Between agents are its list screen; the Mac's are the sidebar beside a thread.
  const listing = phone ? S.phoneList : S.view === "thread";
  const inbox = listing && S.sideLevel !== "pairs" || S.view === "welcome";
  const pairs = phone ? S.phoneList && S.sideLevel === "pairs" : S.view === "thread" && S.sideLevel === "pairs";
  const off = phone && S.phoneList;
  if (phone) {
    const tab = (attr: string, icon: string, label: string, on: boolean, n = 0, you = false) =>
      `<button class="ri ${on ? "on" : ""}" ${attr} aria-label="${label}${n ? `, ${n}` : ""}" ${on ? `aria-current="page"` : ""}>${icon}${n ? `<b class="${you ? "you" : ""}">${n}</b>` : ""}<span class="rl">${label}</span></button>`;
    return `${tab("data-you", I.check, "You", !off && S.view === "you", youN, true)}${tab("data-work", I.stack, "Work", !off && S.view === "work")}
      ${tab(`data-rail="agents"`, I.tray, "Inbox", inbox, S.counts.to)}${tab("data-search-open", I.search, "Search", false)}`;
  }
  /* The Mac: a labelled list, wide enough to read at a glance. Your three places first, then
     where conversations live, then the rest. */
  const row = (attr: string, icon: string, label: string, on: boolean, n = 0, you = false, hint = "") =>
    `<button class="nav ${on ? "on" : ""}" ${attr} title="${hint || label}" aria-label="${label}${n ? `, ${n}` : ""}" ${on ? `aria-current="page"` : ""}>${icon}<span>${label}</span>${n ? `<b class="${you ? "you" : ""}">${n}</b>` : ""}</button>`;
  return `${row("data-compose", I.compose, "New message", S.view === "compose", 0, false, "New message (N)")}
    ${row("data-search-open", I.search, "Search", false, 0, false, "Search everything (⌘K)")}
    <div class="nav-gap"></div>
    ${row("data-you", I.check, "You", S.view === "you", youN, true, "What waits on you, most blocking first")}
    ${row("data-work", I.stack, "Work", ["work", "queue", "board"].includes(S.view), workN, false, "Every piece of work, and what is shipping")}
    ${row("data-rules", I.shield, "Rules", S.view === "rules", 0, false, "Your rules, and what each agent may do")}
    <div class="nav-head">Conversations</div>
    ${row(`data-rail="agents"`, I.tray, "Inbox", inbox, S.counts.to)}
    ${row(`data-rail="pairs"`, I.chat, "Between agents", pairs)}
    ${row("data-team-open", I.team, "Team", S.view === "team")}
    <span class="grow"></span>
    ${(window as any).DAK?.phone ? "" : row("data-settings", I.gear, "Settings", S.view === "settings")}`;
}

export function phoneListHead(): string {
  if (S.sideLevel === "topics" && S.peer) return "";
  const title = S.sideLevel === "pairs" ? "Between agents" : "Inbox";
  return `<div class="phead"><h1>${title}</h1><button class="icon-btn" data-compose title="New message" aria-label="New message">${I.compose}</button></div>`;
}

export function sideBody(): string {
  if (S.sideLevel === "topics" && S.peer) {
    const peer = S.peer;
    const count = everyThread().filter((t) => peerOf(t) === peer).length;
    const about = isPair(peer) ? "Between agents, read only" : agentOf(peer)?.about ?? "";
    return `<div class="side-head drill"><button class="back" data-side-back title="Back to all agents">${I.prev}<span>${isPair(peer) ? "Between agents" : "Agents"}</span></button></div>
      <div class="crumb">${isPair(peer) ? "" : mark(peer, "md")}<div><b>${esc(isPair(peer) ? peerName(peer) : name(peer))}</b><span>${about ? `${esc(about)} · ` : ""}${count} topic${count === 1 ? "" : "s"}</span></div></div>
      <div class="side-find"><input id="topic-find" type="search" placeholder="Find a topic, PR or ticket" value="${esc(S.topicFind)}" autocomplete="off"></div>
      <div class="list tlist" id="tlist" role="list" aria-label="Topics">${topicRows()}</div>`;
  }
  if (S.sideLevel === "pairs") {
    return `<div class="side-head">Between agents</div><div class="list" role="list">${pairList().replace(/<div class="side-head sub">Between agents<\/div>/, "") || `<p class="empty">No agents have written to each other yet.</p>`}</div>`;
  }
  return `<div class="side-head">Agents${S.counts.to ? `<span class="count">${S.counts.to}</span>` : ""}</div>
    <div class="list" role="list" aria-label="Agents">${peerList()}${archivedList()}</div>`;
}

/* ---------- tabs ---------- */

/* A preview tab, as in Xcode and VS Code: opening a topic puts it in the one preview tab,
   replacing whatever was previewed there, so browsing does not pile up tabs. A tab stays once you
   act on it (reply, comment, approve, "I'm reviewing") or double-click it. */
const MAX_TABS = 8;
export function addTab(id: string) {
  if (S.tabs.includes(id)) return;
  const at = S.preview ? S.tabs.indexOf(S.preview) : -1;
  S.tabs = at >= 0 ? S.tabs.map((t, i) => (i === at ? id : t)) : [...S.tabs, id];
  S.preview = id;
  // Over the limit, the oldest tab you are not on goes.
  while (S.tabs.length > MAX_TABS) S.tabs.splice(S.tabs.findIndex((t) => t !== S.cur && t !== id), 1);
  local.set("tabs", S.tabs); local.set("previewTab", S.preview);
}
export function keepTab(id: string | null) {
  if (!id || S.preview !== id) return;
  S.preview = null; local.set("previewTab", null);
}
export function closeTab(id: string): string | null {
  const i = S.tabs.indexOf(id);
  S.tabs = S.tabs.filter((t) => t !== id);
  if (S.preview === id) { S.preview = null; local.set("previewTab", null); }
  local.set("tabs", S.tabs);
  return S.tabs[Math.min(i, S.tabs.length - 1)] ?? null;
}

export function tabsView(): string {
  const all = everyThread();
  const tabs = S.tabs.map((id) => all.find((t) => t.id === id)).filter(Boolean) as ReturnType<typeof everyThread>;
  return tabs.map((t) => {
    const on = S.view === "thread" && S.cur === t.id;
    const who = peerOf(t);
    const preview = S.preview === t.id;
    return `<div class="tab ${on ? "on" : ""} ${preview ? "preview" : ""}" draggable="true" role="tab" aria-selected="${on}"><button class="tab-go" data-tab="${t.id}" title="${esc(`${isPair(who) ? peerName(who) : name(who)}: ${t.subject}`)}${preview ? " (preview: the next topic you open takes this tab; double-click to keep it)" : ""}">
      ${t.unread ? `<span class="dot" title="New"></span>` : ""}<span class="tl">${esc(t.subject)}</span></button>
      <button class="tab-x" data-tab-close="${t.id}" aria-label="Close tab">${I.close}</button></div>`;
  }).join("");
}
