/* The window's frame on the Mac: a thin rail of places on the left, tabs along the top for what
   you have open, and a sidebar that drills in (agents, then one agent's topics, with Back).
   Three columns, so the review pane keeps its width. The phone keeps its own two screens. */
import { S, esc, name, mark, me, agentOf, onPhone } from "./state";
import { local } from "./api";
import { everyThread, isPair, peerList, archivedList, pairList, peerName, peerOf } from "./convo";
import { topicRows } from "./topics";
import { I } from "./icons";

export type SideLevel = "agents" | "topics" | "pairs";

/* The places. On the Mac, a rail down the left; on the phone, the tab bar along the bottom,
   each with a short name under its icon, as iPhone apps do. */
export function railView(): string {
  const phone = onPhone();
  const queueN = S.queue.filter((r) => r.state !== "deployed" && !r.hold).length;
  const item = (attr: string, icon: string, label: string, short: string, on: boolean, n = 0, you = false) =>
    `<button class="ri ${on ? "on" : ""}" ${attr} title="${label}" aria-label="${label}${n ? `, ${n}` : ""}" ${on ? `aria-current="page"` : ""}>${icon}${n ? `<b class="${you ? "you" : ""}">${n}</b>` : ""}${phone ? `<span class="rl">${short}</span>` : ""}</button>`;
  // The phone's Inbox and Between agents are its list screen; the Mac's are the sidebar beside a thread.
  const listing = phone ? S.phoneList : S.view === "thread";
  const inbox = listing && S.sideLevel !== "pairs" || S.view === "welcome";
  const pairs = phone ? S.phoneList && S.sideLevel === "pairs" : S.sideLevel === "pairs";
  return `${item(`data-rail="agents"`, I.tray, "Inbox", "Inbox", inbox)}
    ${item("data-waiting", I.check, "Waiting on you", "For you", !(phone && S.phoneList) && S.view === "waiting", S.reviews.length, true)}
    ${item("data-queue", I.pr, "Merge queue", "Queue", !(phone && S.phoneList) && S.view === "queue", queueN)}
    ${item(`data-rail="pairs"`, I.chat, "Between agents", "Agents", pairs)}
    ${item("data-search-open", I.search, "Search everything (⌘K)", "Search", false)}
    ${phone ? "" : `${item("data-compose", I.compose, "New message (N)", "New", S.view === "compose")}
    <span class="grow"></span>
    ${(window as any).DAK?.phone ? "" : item("data-settings", I.gear, "Settings", "Settings", S.view === "settings")}`}`;
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

const MAX_TABS = 8;
export function addTab(id: string) {
  if (S.tabs.includes(id)) return;
  S.tabs = [...S.tabs, id];
  // Over the limit, the oldest tab you are not on goes.
  while (S.tabs.length > MAX_TABS) S.tabs.splice(S.tabs.findIndex((t) => t !== S.cur), 1);
  local.set("tabs", S.tabs);
}
export function closeTab(id: string): string | null {
  const i = S.tabs.indexOf(id);
  S.tabs = S.tabs.filter((t) => t !== id);
  local.set("tabs", S.tabs);
  return S.tabs[Math.min(i, S.tabs.length - 1)] ?? null;
}

export function tabsView(): string {
  const all = everyThread();
  const tabs = S.tabs.map((id) => all.find((t) => t.id === id)).filter(Boolean) as ReturnType<typeof everyThread>;
  return tabs.map((t) => {
    const on = S.view === "thread" && S.cur === t.id;
    const yours = t.to === me && t.status === "waiting";
    const who = peerOf(t);
    return `<div class="tab ${on ? "on" : ""}" role="tab" aria-selected="${on}"><button class="tab-go" data-tab="${t.id}" title="${esc(`${isPair(who) ? peerName(who) : name(who)}: ${t.subject}`)}">
      ${yours ? `<span class="dot" title="Waiting on you"></span>` : ""}<span class="tl">${esc(t.subject)}</span></button>
      <button class="tab-x" data-tab-close="${t.id}" aria-label="Close tab">${I.close}</button></div>`;
  }).join("");
}
