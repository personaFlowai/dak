import { esc, S, me, name, drafts, findAtt, when, mark, plain, $, type Doc } from "./state";
import type { Anchor } from "../src/types";
import { I } from "./icons";

/* A doc reads as a document, with its comments beside the words they are about, as in Notion:
   commented words are highlighted, each paragraph's comments are one card level with it, and a
   bubble on the paragraph counts them. Click a highlight, a bubble or a card and the two light up
   together, with the card moved level with its words. Select words to comment on them. */

type Entry = { html: string; exact: boolean };
export function docView(a: Doc): string {
  const bl = S.docs.get(a.meta.blob) ?? [];
  const mine = drafts(S.cur!).filter((d) => d.attachment_id === a.id);
  const sent = S.data!.messages.flatMap((m) => m.comments.filter((c) => c.anchor?.kind === "doc").map((c) => ({ c, m })))
    .filter(({ c }) => { const d = findAtt(c.attachment_id); return d?.type === "doc" && d.name === a.name; });
  const place = (an: Extract<Anchor, { kind: "doc" }>) =>
    bl.find((b) => b.hash === an.block_hash)?.index ?? (an.quote ? bl.find((b) => b.text.includes(an.quote.slice(0, 40)))?.index : undefined) ?? -1;
  const quote = (an: any, label?: string) => an.exact ? `<div class="q exact">${esc(`“${plain(label ?? an.quote)}”`)}</div>` : "";

  // One thread per paragraph; comments from an earlier version that no longer match sit under -1.
  const threads = new Map<number, Entry[]>();
  const add = (i: number, e: Entry) => threads.set(i, [...(threads.get(i) ?? []), e]);
  for (const { c, m } of sent) {
    const i = place(c.anchor as any);
    add(i, { exact: !!(c.anchor as any).exact, html: `<div class="entry"><div class="who">${mark(c.author, "sm")}<b>${esc(name(c.author))}</b><span>${when(m.created_at)}${i < 0 ? " · earlier version" : ""}</span></div>${quote(c.anchor)}<div class="body">${esc(c.body)}</div></div>` });
  }
  for (const d of mine) add((d.anchor as any).block_index, { exact: !!(d.anchor as any).exact, html: `<div class="entry draft"><div class="who">${mark(me, "sm")}<b>You</b><span>not sent yet</span><button class="link" data-del="${d.id}">Delete</button></div>${quote(d.anchor, d.label)}<div class="body">${esc(d.body)}</div></div>` });
  const editing = S.editing?.att === a.id && S.editing.anchor.kind === "doc" ? (S.editing.anchor as any).block_index as number : null;
  if (editing !== null && !threads.has(editing)) threads.set(editing, []);
  const active = editing ?? S.docActive;

  const body = bl.map((b) => {
    const n = (threads.get(b.index) ?? []).length;
    const tool = n ? `<button class="cnt" data-doc-active="${b.index}" aria-label="${n} comment${n === 1 ? "" : "s"}" title="${n} comment${n === 1 ? "" : "s"}">${I.chat}<span>${n}</span></button>`
      : `<button class="add" data-block="${b.index}" aria-label="Comment on this paragraph" title="Comment on this paragraph">${I.chat}</button>`;
    return `<div class="blk ${n ? "has" : ""} ${b.index === active ? "active" : ""} ${S.editing?.key.startsWith(`${a.id}|b${b.index}`) ? "on" : ""}" data-i="${b.index}">${b.html}${tool}</div>`;
  }).join("");

  const cards = [...threads.entries()].sort((x, y) => x[0] - y[0]).map(([i, entries]) => {
    const ed = i === editing ? `<div class="entry editing">${quote(S.editing!.anchor, S.editing!.label)}<textarea id="edit" rows="3" aria-label="Comment" placeholder="${entries.length ? "Reply" : "Your comment"}"></textarea>
      <div class="btns"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save title="⌘↩">${entries.length ? "Reply" : "Add comment"}</button></div></div>`
      : i >= 0 ? `<button class="link reply-here" data-block="${i}">Reply</button>` : "";
    return `<div class="tcard ${i === active ? "active" : ""} ${i < 0 ? "earlier" : ""}" data-doc-card="${i}">${i < 0 ? `<div class="earlier-h">From an earlier version</div>` : ""}${entries.map((e) => e.html).join("")}${ed}</div>`;
  });
  return `<div class="doc"><article class="docbody">${body || "<p>This document is empty.</p>"}</article>
    <aside class="margin" aria-label="Comments"><div class="splitter left" data-split="margin" title="Drag to resize"></div>${cards.join("") || `<p class="hint">Select words to comment on them, or use the bubble beside a paragraph. Comments stay with their words when a new version arrives.</p>`}</aside></div>`;
}

/* Each card level with its paragraph, as in Notion. Cards never overlap: one that would is
   pushed down. The active card is put exactly level with its words, and the cards above it
   move up to make room. Runs after every render and when the window changes size. */
export function layoutMargin() {
  const margin = document.querySelector<HTMLElement>(".doc .margin");
  if (!margin) return;
  const cards = [...margin.querySelectorAll<HTMLElement>(".tcard")];
  if (!cards.length) return;
  const top0 = margin.getBoundingClientRect().top;
  const want = cards.map((c) => {
    const i = Number(c.dataset.docCard);
    const blk = i >= 0 ? document.querySelector<HTMLElement>(`.docbody .blk[data-i="${i}"]`) : null;
    return blk ? blk.getBoundingClientRect().top - top0 : 24;
  });
  const h = cards.map((c) => c.offsetHeight), gap = 10, tops: number[] = [];
  want.forEach((w, k) => { tops[k] = Math.max(w, k ? tops[k - 1] + h[k - 1] + gap : 0); });
  const ai = cards.findIndex((c) => c.classList.contains("active"));
  if (ai >= 0 && tops[ai] > want[ai]) {
    tops[ai] = want[ai];
    for (let k = ai - 1; k >= 0; k--) tops[k] = Math.min(tops[k], tops[k + 1] - h[k] - gap);
    for (let k = ai + 1; k < cards.length; k++) tops[k] = Math.max(want[k], tops[k - 1] + h[k - 1] + gap);
    const shift = Math.min(0, tops[0]); // never above the top of the page
    if (shift) for (let k = 0; k < tops.length; k++) tops[k] -= shift;
  }
  cards.forEach((c, k) => { c.style.top = `${tops[k]}px`; });
  margin.style.minHeight = `${tops[tops.length - 1] + h[h.length - 1] + 40}px`;
}

// Light up one paragraph and its card together, without a full redraw.
export function setDocActive(i: number | null) {
  S.docActive = i;
  document.querySelectorAll(".docbody .blk.active, .margin .tcard.active").forEach((e) => e.classList.remove("active"));
  if (i !== null) {
    document.querySelector(`.docbody .blk[data-i="${i}"]`)?.classList.add("active");
    document.querySelector(`.margin .tcard[data-doc-card="${i}"]`)?.classList.add("active");
  }
  layoutMargin();
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
      const m = document.createElement("mark"); m.className = "hl"; m.dataset.docActive = String(i);
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
