/* The topics column: every topic with this agent as a list, like a chat history. One click shows
   that topic alone; the list shows which one you are on and which are new. It replaces
   the old prev/next arrows and the "All topics" timeline, where it was easy to lose your place. */
import { S, me, esc, name, when, agentOf } from "./state";
import { everyThread, isPair, peerName, peerOf, type Topic } from "./convo";
import type { Summary } from "./state";
import { I } from "./icons";

// The PR number, when the topic is loaded (its attachments carry it), else from the subject.
function prNumber(t: Summary): string {
  const loaded = S.convo.find((x: Topic) => x.thread.id === t.id);
  const pr = loaded?.messages.flatMap((m) => m.attachments).find((a) => a.type === "pr") as any;
  const n = pr?.meta?.number ?? null;
  return n && !t.subject.includes(`#${n}`) ? `#${n}` : "";
}

// Where a topic stands, in the words the rest of Dak uses, from the list row alone.
function standingOf(t: Summary): { label: string; cls: string } {
  const other = t.to === me ? t.from : t.to;
  if (t.status === "closed") return { label: "Done", cls: "" };
  // A topic for you needs no label here: what needs your answer lives on the You page.
  if (t.to === me && t.status === "waiting") return { label: t.reviewing_since ? "You're reviewing" : "", cls: "" };
  if (t.status === "waiting") return { label: `Waiting on ${name(other)}`, cls: "" };
  if (t.status === "picked_up") return { label: `${name(other)} picked it up`, cls: "done" };
  if (t.status === "answered") return { label: t.to === me ? "You answered" : `${name(other)} answered`, cls: "done" };
  return { label: "No reply needed", cls: "" };
}

const matches = (t: Summary, q: string) => !q || `${t.subject} ${prNumber(t)} ${t.id}`.toLowerCase().includes(q.toLowerCase());

export function topicRows(): string {
  const all = everyThread().filter((t) => peerOf(t) === S.peer && matches(t, S.topicFind))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const groups: [string, Summary[], boolean][] = [
    ["Open", all.filter((t) => t.status !== "closed"), false],
    ["Done", all.filter((t) => t.status === "closed"), true],
  ];
  const row = (t: Summary) => {
    const st = standingOf(t), n = prNumber(t);
    return `<button class="trow ${t.id === S.cur ? "on" : ""} ${t.unread ? "unread" : ""}" data-topic="${t.id}" aria-current="${t.id === S.cur}" title="${esc(t.subject)}">
      <span class="l1">${n ? `<span class="n">${n}</span>` : ""}<span class="s">${esc(t.subject)}</span></span>
      <span class="l2"><span class="st ${st.cls}">${esc(st.label)}</span><time>${when(t.updated_at)}</time></span></button>`;
  };
  const out = groups.filter(([, rows]) => rows.length).map(([label, rows, foldable]) => {
    // Done folds unless you asked for it, or are searching, or are on one of them.
    const open = !foldable || S.showDone || !!S.topicFind || rows.some((t) => t.id === S.cur);
    return `<div class="tgroup">${foldable
      ? `<button class="tg fold" data-show-done aria-expanded="${open}">${I.next}<span>${label} · ${rows.length}</span></button>`
      : `<div class="tg"><span>${label} · ${rows.length}</span></div>`}${open ? rows.map(row).join("") : ""}</div>`;
  }).join("");
  return out || `<p class="tnone">${S.topicFind ? "No topic matches." : "No topics yet."}</p>`;
}

export function topicsColumn(): string {
  const peer = S.peer!;
  const count = everyThread().filter((t) => peerOf(t) === peer).length;
  const title = isPair(peer) ? peerName(peer) : name(peer);
  const about = isPair(peer) ? "Between agents, read only" : agentOf(peer)?.about ?? "";
  return `<aside class="topics-col" aria-label="Topics">
    <div class="thead"><b>${esc(title)}</b><span>${about ? `${esc(about)} · ` : ""}${count} topic${count === 1 ? "" : "s"}</span>
      <input id="topic-find" type="search" placeholder="Find a topic, PR or ticket" value="${esc(S.topicFind)}" autocomplete="off"></div>
    <div class="tlist" id="tlist">${topicRows()}</div></aside>`;
}
