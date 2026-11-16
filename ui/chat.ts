import { esc, S, me, name, drafts, findAtt, when, fullWhen, mark, helperLabel, helperMark, opensInPane } from "./state";
import { render as renderMd } from "./md";
import { anchorLabel, prLink } from "./pr";
import { blobUrl } from "./api";
import type { Attachment, Handoff, Message, Proof, Thread, Verdict } from "../src/types";
import { describeCost } from "../src/handoff";
import { I, linkInfo } from "./icons";
import { timeline, topicPicker, draftKey, topicBar, type Topic } from "./convo";

// The left pane is the conversation with the agent, and beside it a private
// helper for questions: what you ask the helper never reaches the thread.

export function chatPane(t: Thread, review: boolean): string {
  const tabs = review ? `<div class="tabs" role="tablist">
      <button role="tab" aria-selected="${S.pane === "chat"}" data-pane="chat">Conversation</button>
      <button role="tab" aria-selected="${S.pane === "ask"}" data-pane="ask">${helperMark()} Ask ${esc(helperLabel())}</button></div>` : "";
  const split = review ? `<div class="splitter" data-split="chat" title="Drag to resize"></div>` : "";
  if (review && S.pane === "ask") return `<div class="chat">${tabs}${askPane(t)}${split}</div>`;
  return `<div class="chat ${review ? "" : "solo"}">${tabs}
    ${topicBar()}
    <div class="msgs" id="msgs">${timeline((m, topic) => message(m, topic))}</div>
    ${canReply(t) ? composer(t) : `<p class="readonly">Between ${esc(name(t.from))} and ${esc(name(t.to))}. You can read along; only they reply here.</p>`}
    ${split}</div>`;
}

// You can write on a thread you sent, were sent, or were added to.
export const canReply = (t: Thread) => t.to === me || t.from === me
  || !!S.convo.find((x) => x.thread.id === t.id)?.participants?.some((p) => p.name === me);

function message(m: Message, topic: Topic): string {
  const v = m.verdict ? `<span class="verdict ${m.verdict}">${{ approve: "Approved", changes: "Changes requested", question: "Question" }[m.verdict]}</span>` : "";
  const refs = m.comments.map((c) => `<li><code>${esc(anchorLabel(c.anchor))}</code> ${esc(c.body)}</li>`).join("");
  const chips = m.attachments.map((a) => chip(a, topic)).join("");
  const media = m.attachments.filter((a) => a.type === "file" && /^(image|video)\//.test((a.meta as any).mime)).map((a) => {
    const f = a.meta as any;
    return f.mime.startsWith("image/") ? `<img src="${blobUrl(f.blob, f.mime)}" alt="${esc(a.name)}" loading="lazy">` : `<video src="${blobUrl(f.blob, f.mime)}" controls preload="metadata"></video>`;
  }).join("");
  return `<article class="msg ${m.author === me ? "mine" : ""}" data-mid="${m.id}">
    <div class="w">${mark(m.author, "sm")}<b>${esc(name(m.author))}</b>${v}<time title="${esc(fullWhen(m.created_at))}">${when(m.created_at)}</time></div>
    ${m.choice ? `<div class="picked">${I.check}<span>${esc(m.choice)}</span></div>` : ""}
    ${m.body.trim() ? `<div class="prose">${renderMd(m.body)}</div>` : ""}
    ${m.handoff ? handoffCard(m.handoff) : ""}
    ${m.cost ? `<p class="cost">${esc(describeCost(m.cost))}</p>` : ""}
    ${m.options?.length ? options(m, topic) : ""}
    ${refs ? `<ul class="refs">${refs}</ul>` : ""}
    ${chips ? `<div class="chips">${chips}</div>` : ""}
    ${seenLine(m, topic)}
  </article>`;
}

// "Ready for review": the head the proofs ran on, the migration, and each proof's result.
function handoffCard(h: Handoff): string {
  const proof = (p: Proof) => `<li class="${p.result}">${p.result === "pass" ? I.check : I.close}<b>${esc(p.name)}</b>${p.count !== undefined ? `<span>${p.count}</span>` : ""}</li>`;
  return `<div class="handoff"><div class="hh"><b>Ready for review</b><code title="${esc(h.head)}">${esc(h.head.slice(0, 10))}</code>${h.base ? `<span>on <code>${esc(h.base.slice(0, 10))}</code></span>` : ""}</div>
    <div class="hm">Migration: ${h.migration === "none" ? "none" : `<code>${esc(h.migration)}</code>`}</div>
    <ul class="proofs">${h.proofs.map(proof).join("")}</ul>
    ${h.skipped.length ? `<ul class="skipped">${h.skipped.map((s) => `<li>Skipped <b>${esc(s.name)}</b>: ${esc(s.reason)}</li>`).join("")}</ul>` : ""}</div>`;
}

// Under your newest message: whether each other person on the topic has seen it yet.
function seenLine(m: Message, topic: Topic): string {
  if (m.author !== me || topic.messages[topic.messages.length - 1]?.id !== m.id || !topic.reads) return "";
  const t = topic.thread;
  const others = [...new Set([t.to, t.from, ...(topic.participants ?? []).map((p) => p.name)])].filter((w) => w !== me && !w.startsWith("group:"));
  if (!others.length) return "";
  const each = others.map((w) => {
    const r = topic.reads!.find((x) => x.reader === w);
    const who = others.length > 1 ? `${esc(name(w))} ` : "";
    return r && r.up_to >= m.id ? `${who}read${r.seen_at ? ` ${when(r.seen_at)}` : ""}` : `${who}not opened yet`;
  });
  return `<p class="seen">${each.join(" · ")}</p>`;
}

// Buttons an agent offered. Once you pick one (or answer in words), the choice shows and the rest step back.
function options(m: Message, topic: Topic): string {
  const later = topic.messages.filter((x) => x.id > m.id && x.author === me);
  const picked = later.find((x) => x.choice && m.options!.includes(x.choice))?.choice;
  const open = !later.length && canReply(topic.thread) && m.author !== me;
  return `<div class="opts" role="group" aria-label="Answer with">${m.options!.map((o, i) =>
    `<button type="button" class="opt ${picked === o ? "on" : ""}" data-choose="${i}" data-mid="${m.id}" data-in="${topic.thread.id}" ${open ? "" : "disabled"}>${picked === o ? I.check : ""}${esc(o)}</button>`).join("")}</div>`;
}

// Every attachment is a card. A PR, a doc, an image or a video opens beside the
// conversation; a link (an artifact, a page) opens in the browser.
// A card in another topic carries that topic, so opening it also moves your reply there.
function chip(a: Attachment, topic: Topic): string {
  const on = S.att === a.id;
  const inn = `data-in="${topic.thread.id}"`;
  const card = (icon: string, title: string, meta: string, action: string) =>
    `<button class="acard ${on ? "on" : ""}" data-att="${a.id}" ${inn}><span class="aicon">${icon}</span><span class="nm"><b>${esc(title)}</b><span>${meta}</span></span><span class="go">${on ? "Showing" : action}</span></button>`;
  if (a.type === "pr") {
    const add = a.meta.files.reduce((n, f) => n + f.additions, 0), del = a.meta.files.reduce((n, f) => n + f.deletions, 0);
    const v = prVersion(a.id, topic);
    return card(I.pr, a.meta.title ? `${a.name} · ${a.meta.title}` : a.name, `<span class="a">+${add}</span> <span class="d">−${del}</span> · ${a.meta.files.length} file${a.meta.files.length === 1 ? "" : "s"}${v ? ` · version ${v}` : ""}`, "Open");
  }
  if (a.type === "doc") return card(I.doc, a.name, `Document · version ${a.meta.version}`, "Open");
  if (a.type === "link") {
    const l = linkInfo(a.meta.url, a.name);
    return `<a class="acard" href="${esc(a.meta.url)}" target="_blank" rel="noopener" title="${esc(a.meta.url)}"><span class="aicon">${l.mark}</span><span class="nm"><b>${esc(l.title)}</b><span>${esc(l.where)}</span></span><span class="go">Open ↗</span></a>`;
  }
  const f = a.meta;
  if (/^image\//.test(f.mime)) return `<button class="acard thumb ${on ? "on" : ""}" data-att="${a.id}" ${inn}><img src="${blobUrl(f.blob, f.mime)}" alt="${esc(a.name)}" loading="lazy"><span class="nm"><b>${esc(a.name)}</b><span>Image · ${size(f.size)}</span></span></button>`;
  if (/^video\//.test(f.mime)) return card(I.doc, a.name, `Video · ${size(f.size)}`, "Play");
  if (opensInPane(f.mime)) return card(I.doc, a.name, `${f.mime.startsWith("text/html") ? "Page" : f.mime.startsWith("application/pdf") ? "PDF" : "Text"} · ${size(f.size)}`, "Open");
  return `<a class="acard" href="${blobUrl(f.blob, f.mime)}" target="_blank" rel="noopener" download="${esc(a.name)}"><span class="aicon">${I.doc}</span><span class="nm"><b>${esc(a.name)}</b><span>${size(f.size)}</span></span><span class="go">Download</span></a>`;
}

const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// "version 2" when a thread carries more than one PR: the newest is what opens first.
function prVersion(id: string, topic: Topic): number | null {
  const prs = topic.messages.flatMap((m) => m.attachments).filter((x) => x.type === "pr");
  return prs.length > 1 ? prs.findIndex((x) => x.id === id) + 1 : null;
}

export function composer(t: Thread, docked = false): string {
  const review = t.kind !== "note";
  const other = t.to === me ? t.from : t.from === me ? t.to : t.from;
  const v = currentVerdict(t);
  const n = drafts(t.id).length;
  // A new topic is a plain message: no verdict, nothing to post to GitHub.
  const opts: [string, string][] = review && t.to === me && !S.newTopic ? [["", "Comment"], ["changes", "Request changes"], ["question", "Ask a question"]] : [];
  const gh = review && !S.newTopic && !!prLink();
  const key = draftKey();
  const hint = S.newTopic ? `New message to ${name(other)}` : `Reply to ${name(other)}`;
  if (docked && !S.dockOpen) {
    const typed = (S.message[key] ?? "").trim();
    return `<div class="dock-bar">
      <button type="button" class="icon-btn" data-ask-open title="Ask ${esc(helperLabel())} (A)">${helperMark()}</button>
      <button type="button" class="dock-open" data-dock="open">${typed ? esc(typed.split("\n")[0].slice(0, 80)) : `Reply to ${esc(name(other))}`}</button>
      ${n ? `<span class="aside">${n} comment${n === 1 ? "" : "s"}</span>` : ""}
      ${opts.length ? `<label class="popup ${v ? `v-${v}` : ""}"><select id="verdict" aria-label="Verdict">${opts.map(([k, l]) => `<option value="${k}" ${(v ?? "") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
      <button type="button" class="btn primary" id="send" ${S.sending ? "disabled" : ""} title="Send (⌘↩)">${S.sending ? "Sending" : v === "approve" ? "Approve" : v === "changes" ? "Request changes" : "Send"}</button></div>`;
  }
  return `<form class="composer ${docked ? "docked" : ""}" id="composer" onsubmit="return false">
    ${docked ? `<div class="dock-top"><span>Reply to ${esc(name(other))}</span><button type="button" class="link" data-dock="close">Hide</button></div>` : ""}
    ${topicPicker()}
    <textarea id="message" rows="3" aria-label="${esc(hint)}" placeholder="${esc(S.newTopic ? "First line is the subject" : hint)}">${esc(S.message[key] ?? "")}</textarea>
    ${attachBar()}
    <div class="row">
      ${opts.length ? `<label class="popup ${v ? `v-${v}` : ""}" title="What your reply says about the work"><select id="verdict" aria-label="Verdict">${opts.map(([k, l]) => `<option value="${k}" ${(v ?? "") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
      ${gh ? `<label class="check" title="Also post this review and its line comments on GitHub"><input type="checkbox" id="github" ${S.github[t.id] ? "checked" : ""}> GitHub</label>` : ""}
      <span class="aside">${S.sendError ? `<span class="err">${esc(S.sendError)}</span>` : S.sendNote ? esc(S.sendNote) : n ? `${n} comment${n === 1 ? "" : "s"} attached` : ""}</span>
      <button type="button" class="btn primary" id="send" ${S.sending ? "disabled" : ""} title="Send (⌘↩)">${S.sending ? "Sending" : v === "approve" ? "Approve" : v === "changes" ? "Request changes" : "Send"}</button>
    </div></form>`;
}

export function currentVerdict(t: Thread): Verdict | null {
  // Nothing is approved by accident: the verdict starts empty.
  return S.verdict[t.id] ?? null;
}

export function askPane(t: Thread): string {
  const turns = S.ask[t.id] ?? [];
  const a = findAtt(S.att);
  const chips = a?.type === "pr" ? ["Summarise this PR in plain words", "What looks risky here?", S.chapter >= 0 ? "Explain this chapter" : "What should I check first?"]
    : a?.type === "doc" ? ["Summarise this doc", "What is still undecided?", "What would you push back on?"] : ["Summarise this thread"];
  return `<div class="ask">
    <div class="msgs" id="msgs">
      ${turns.length ? "" : `<div class="ask-empty"><p>Ask ${esc(helperLabel())} about this ${a?.type === "doc" ? "document" : "change"}. It can read the code, answers here only, and never posts to the thread.</p>
        <div class="chips">${chips.map((c) => `<button class="chip" data-prompt="${esc(c)}">${esc(c)}</button>`).join("")}</div></div>`}
      ${turns.map((x) => `<article class="msg mine"><div class="w"><b>You</b>${x.context ? `<code class="ctx">${esc(x.context)}</code>` : ""}</div><div class="prose"><p>${esc(x.q)}</p></div></article>
        <article class="msg"><div class="w"><span class="mark sm">${helperMark()}</span><b>${esc(x.by ?? helperLabel())}</b>${x.seconds ? `<time>${x.seconds}s</time>` : ""}</div>
        ${x.loading ? `<div class="thinking"><i></i>Reading the code</div>` : x.error ? `<p class="err">${esc(x.error)}</p>` : `<div class="prose">${renderMd(x.a ?? "")}</div>`}</article>`).join("")}
    </div>
    <form class="composer" onsubmit="return false">
      ${S.askContext ? `<div class="ctxbar"><code>${esc(S.askContext.label)}</code><button type="button" class="link" data-clear-context>Remove</button></div>` : ""}
      <textarea id="askq" rows="2" placeholder="Ask about ${S.askContext ? "the selection" : "this"}"></textarea>
      <div class="row"><span class="aside">Private to you</span><button type="button" class="btn primary" id="askgo" title="Ask (⌘↩)">Ask</button></div>
    </form></div>`;
}

// Attachments on a new message or reply: files and links, each removable before sending.
export function attachBar(): string {
  const list = S.newAtts.map((a, i) => `<span class="att-chip">${esc(a.name)}<button type="button" class="x" data-remove-att="${i}" aria-label="Remove">×</button></span>`).join("");
  return `<div class="attach">${list}
    <label class="chip-f" title="Attach a file">＋ File<input type="file" id="att-file" hidden multiple></label>
    ${S.linkOpen ? `<span class="link-in"><input class="input" id="att-link" placeholder="https://linear.app/…" autocomplete="off"><button type="button" class="btn" data-add-link>Add</button></span>`
      : `<button type="button" class="chip-f" data-open-link>＋ Link</button>`}</div>`;
}

