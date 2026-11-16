import { esc, S, me, name, drafts, findAtt, when, mark, plain, $, type Doc } from "./state";
import type { Anchor } from "../src/types";
import { I } from "./icons";

// A doc reads as a document: one column of text, comments in the margin beside
// the words they are about. Select words to comment on them or ask about them.

export function docView(a: Doc): string {
  const bl = S.docs.get(a.meta.blob) ?? [];
  const mine = drafts(S.cur!).filter((d) => d.attachment_id === a.id);
  const sent = S.data!.messages.flatMap((m) => m.comments.filter((c) => c.anchor?.kind === "doc").map((c) => ({ c, m })))
    .filter(({ c }) => { const d = findAtt(c.attachment_id); return d?.type === "doc" && d.name === a.name; });
  const place = (an: Extract<Anchor, { kind: "doc" }>) =>
    bl.find((b) => b.hash === an.block_hash)?.index ?? (an.quote ? bl.find((b) => b.text.includes(an.quote.slice(0, 40)))?.index : undefined) ?? -1;
  const marked = new Set<number>([...mine.map((d) => (d.anchor as any).block_index), ...sent.map(({ c }) => place(c.anchor as any)).filter((i) => i >= 0)]);

  const body = bl.map((b) => `<div class="blk ${marked.has(b.index) ? "has" : ""} ${S.editing?.key.startsWith(`${a.id}|b${b.index}`) ? "on" : ""}" data-i="${b.index}">${b.html}
    <button class="add" data-block="${b.index}" aria-label="Comment on this paragraph" title="Comment on this paragraph">${I.chat}</button></div>`).join("");

  const quote = (an: any, label?: string) => { const q = plain(label ?? an.quote); return `<div class="q ${an.exact ? "exact" : ""}">${esc(an.exact ? `“${q}”` : q)}</div>`; };
  const cards: string[] = [];
  if (S.editing?.att === a.id && S.editing.anchor.kind === "doc") {
    cards.push(`<div class="card editing">${quote(S.editing.anchor, S.editing.label)}<textarea id="edit" rows="3" aria-label="Comment" placeholder="Your comment"></textarea>
      <div class="btns"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save title="⌘↩">Add comment</button></div></div>`);
  }
  for (const d of mine) cards.push(`<div class="card draft"><div class="who">${mark(me, "sm")}<b>You</b><span>not sent yet</span><button class="link" data-del="${d.id}">Delete</button></div>${quote(d.anchor, d.label)}<div class="body">${esc(d.body)}</div></div>`);
  for (const { c, m } of sent) {
    cards.push(`<div class="card"><div class="who">${mark(c.author, "sm")}<b>${esc(name(c.author))}</b><span>${when(m.created_at)}${place(c.anchor as any) < 0 ? " · earlier version" : ""}</span></div>${quote(c.anchor)}<div class="body">${esc(c.body)}</div></div>`);
  }
  return `<div class="doc"><article class="docbody">${body || "<p>This document is empty.</p>"}</article>
    <aside class="margin" aria-label="Comments"><div class="splitter left" data-split="margin" title="Drag to resize"></div>${cards.join("") || `<p class="hint">Select words to comment on them or ask about them. Comments stay with their words when a new version arrives.</p>`}</aside></div>`;
}

// Wrap the first place each selected-words comment's quote appears in its block.
export function markQuotes() {
  const a = findAtt(S.att);
  if (!a || a.type !== "doc" || !S.data) return;
  const bl = S.docs.get(a.meta.blob) ?? [];
  const exact: { i: number; quote: string }[] = [];
  const add = (an: any) => {
    if (an?.kind !== "doc" || !an.exact) return;
    const i = bl.find((b) => b.hash === an.block_hash)?.index ?? bl.find((b) => b.text.includes(an.quote))?.index;
    if (i !== undefined) exact.push({ i, quote: an.quote });
  };
  drafts(S.cur!).filter((d) => d.attachment_id === a.id).forEach((d) => add(d.anchor));
  S.data.messages.forEach((m) => m.comments.forEach((c) => { const d = findAtt(c.attachment_id); if (d?.type === "doc" && d.name === a.name) add(c.anchor); }));
  if (S.editing?.att === a.id) add(S.editing.anchor);
  for (const { i, quote } of exact) {
    const blk = document.querySelector(`.blk[data-i="${i}"]`);
    if (!blk) continue;
    const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (n.parentElement?.closest("mark.hl, button")) continue;
      const at = n.data.indexOf(quote);
      if (at < 0) continue;
      const hit = n.splitText(at); hit.splitText(quote.length);
      const m = document.createElement("mark"); m.className = "hl";
      hit.replaceWith(m); m.appendChild(hit);
      break;
    }
  }
}

export let pending: { att: string; block: number; text: string } | null = null;
export const clearPending = () => { pending = null; const p = $("#selpop"); if (p) p.hidden = true; };

// Words in one paragraph only: that is what a comment can find again in the next version.
export function readSelection() {
  const pop = $("#selpop")!;
  const sel = window.getSelection();
  const a = findAtt(S.att);
  pending = null;
  pop.hidden = true;
  if (!sel || sel.isCollapsed || !sel.rangeCount || !a || a.type !== "doc") return;
  const range = sel.getRangeAt(0);
  const el = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement);
  const from = el(range.startContainer)?.closest(".blk"), to = el(range.endContainer)?.closest(".blk");
  if (!from || from !== to || !from.closest(".docbody")) return;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return;
  pending = { att: a.id, block: Number((from as HTMLElement).dataset.i), text: text.slice(0, 300) };
  const r = range.getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(r.left + r.width / 2, 90), innerWidth - 90)}px`;
  pop.style.top = `${Math.max(r.top - 8, 60)}px`;
  pop.hidden = false;
}
