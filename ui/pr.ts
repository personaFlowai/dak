import { local } from "./api";
import { esc, S, me, name, chaptersOf, reviewed, viewed, chapterFiles, drafts, findAtt, when, mark, helperMark, plain, onPhone, type Pr, type Sel } from "./state";
import { phoneGuide, phoneSheet, phoneTabs } from "./pr-phone";
import { hunkStart, type DiffFile, type Hunk } from "../src/diff";
import type { Anchor, Chapter } from "../src/types";
import { highlightLine } from "./hl";
import { render as renderMd } from "./md";
import { I, fileIcon } from "./icons";

// A PR reads as a guided tour: an overview (why, what, where to look, risk with
// its reason), then the agent's chapters in order, each with what to review first.

const RISK: Record<string, string> = { low: "Low risk", medium: "Needs care", high: "High risk" };
const size = (c: Chapter, files: DiffFile[]) => {
  let add = 0, del = 0;
  for (const h of c.hunks) {
    const f = files.find((x) => x.path === h.file);
    const hunk = f?.hunks.find((x) => hunkStart(f, x) === h.start);
    for (const l of hunk?.lines ?? []) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
  }
  return `<span class="n"><span class="a">+${add}</span> <span class="d">−${del}</span></span>`;
};

export function prView(a: Pr): string {
  const files = S.diffs.get(a.meta.diff_blob) ?? [];
  const chapters = chaptersOf(a);
  const done = new Set(reviewed(a.id, chapters));
  const plain = !a.meta.chapters.length;
  S.chapter = Math.min(S.chapter, chapters.length - 1);

  if (onPhone()) {
    const body = S.phoneTab === "overview" ? overview(a, chapters, files, done) : phoneGuide(a, files, done);
    return `<div class="pr phone-pr">${phoneTabs(a, plain)}${body}${S.phoneFile ? phoneSheet(a, files, done, fileSection) : ""}</div>`;
  }
  const rail = `<nav class="rail" aria-label="Reading order">
    <button class="step ${S.chapter === -1 ? "on" : ""}" data-chapter="-1"><span class="num">${I.doc}</span><span class="t">Overview</span></button>
    <div class="rail-label">${plain ? "Files" : "Chapters"} <span>${done.size}/${chapters.length} read</span></div>
    ${chapters.map((c, i) => `<button class="step ${S.chapter === i ? "on" : ""} ${done.has(i) ? "ok" : ""}" data-chapter="${i}">
      <span class="num">${done.has(i) ? I.check : i + 1}</span>
      <span class="t">${esc(c.title)}<span class="s">${plain ? "" : `<span class="risk ${c.risk}">${RISK[c.risk]}</span>`}${size(c, files)}</span></span></button>`).join("")}
    <div class="splitter" data-split="rail" title="Drag to resize"></div>
  </nav>`;
  // A chapter takes the whole width: its notes in one column and its files in the other,
  // each scrolling on its own. The overview keeps the chapter list.
  if (S.chapter >= 0) return `<div class="pr beside"><section class="reading">${chapterView(a, chapters, files, done)}</section></div>`;
  return `<div class="pr">${rail}<section class="reading" id="reading">${S.chapter === -1 ? overview(a, chapters, files, done) : chapterView(a, chapters, files, done)}</section></div>`;
}

function overview(a: Pr, chapters: (Chapter & { plain?: boolean })[], files: DiffFile[], done: Set<number>): string {
  const p = a.meta.prologue ?? {};
  const note = S.data!.messages.find((m) => m.attachments.some((x) => x.id === a.id));
  const risky = chapters.map((c, i) => ({ c, i })).filter(({ c }) => c.risk !== "low").sort((x, y) => (y.c.risk === "high" ? 1 : 0) - (x.c.risk === "high" ? 1 : 0));
  const add = a.meta.files.reduce((n, f) => n + f.additions, 0), del = a.meta.files.reduce((n, f) => n + f.deletions, 0);
  const plain = !a.meta.chapters.length;
  return `<div class="overview">
    <header><h2>${esc(a.meta.title ?? S.data!.thread.subject)}</h2>
      <p class="meta">${a.meta.files.length} file${a.meta.files.length === 1 ? "" : "s"} · <span class="a">+${add}</span> <span class="d">−${del}</span>${note ? ` · sent by ${esc(name(note.author))} ${when(note.created_at)}` : ""}</p></header>
    ${p.why ? `<section><h3>Why</h3><p>${esc(p.why)}</p></section>` : ""}
    ${p.what ? `<section><h3>What it does</h3><p>${esc(p.what)}</p></section>` : !p.why && note?.body.trim() ? `<section><h3>From ${esc(name(note.author))}</h3><div class="prose big">${renderMd(note.body.trim())}</div></section>` : ""}
    ${p.focus?.length ? `<section><h3>Where to look</h3><ul>${p.focus.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>` : ""}
    ${risky.length ? `<section><h3>Risk</h3>${risky.map(({ c, i }) => `<button class="riskrow" data-chapter="${i}"><span class="risk ${c.risk}">${RISK[c.risk]}</span><span><b>${esc(c.title)}.</b> ${esc(c.risk_why ?? "")}</span></button>`).join("")}</section>` : plain ? "" : `<section><h3>Risk</h3><p>Every chapter is low risk.</p></section>`}
    ${plain ? `<p class="hint">${esc(name(note?.author ?? "The sender"))} sent this without chapters, so it reads one file at a time. Agents add chapters with <code>--chapters</code>.</p>` : ""}
    <div class="go"><button class="btn primary" data-chapter="0">Start reading: ${esc(chapters[0]?.title ?? "")} ${I.next}</button></div>
  </div>`;
}

function chapterView(a: Pr, chapters: (Chapter & { plain?: boolean })[], files: DiffFile[], done: Set<number>): string {
  const ch = chapters[S.chapter];
  const byFile = new Map<string, number[]>();
  for (const h of ch.hunks) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h.start]);
  // A concept chapter has no hunks of its own: show the hunks its key changes point into.
  if (!ch.hunks.length) for (const k of ch.key_changes ?? []) {
    const f = files.find((x) => x.path === k.file);
    const side = k.side ?? "new";
    const h = f?.hunks.find((x) => side === "old" ? k.line >= x.old_start && k.line < x.old_start + Math.max(x.old_lines, 1) : k.line >= x.new_start && k.line < x.new_start + Math.max(x.new_lines, 1));
    if (f && h && !(byFile.get(f.path) ?? []).includes(hunkStart(f, h))) byFile.set(f.path, [...(byFile.get(f.path) ?? []), hunkStart(f, h)]);
  }
  const keys = (ch.key_changes ?? []).map((k) => `<li><button data-jump="${esc(k.file)}|${k.side ?? "new"}|${k.line}"><span>${esc(k.text)}</span><code>${esc(k.file.split("/").pop()!)}:${k.line}${k.side === "old" ? " removed" : ""}</code></button></li>`).join("");
  const last = S.chapter === chapters.length - 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const nav = `<div class="ch-nav">
      <button class="icon-btn" data-chapter="${S.chapter - 1}" title="Previous (K)" aria-label="Previous chapter">${I.prev}</button>
      <label class="popup"><select id="chapter-pick" aria-label="Chapter"><option value="-1">Overview</option>${chapters.map((c, i) =>
        `<option value="${i}" ${i === S.chapter ? "selected" : ""}>${pad(i + 1)} ${esc(c.title)}${done.has(i) ? " ✓" : ""}</option>`).join("")}</select></label>
      ${last ? "" : `<button class="icon-btn" data-chapter="${S.chapter + 1}" title="Next (J)" aria-label="Next chapter">${I.next}</button>`}</div>`;
  const notes = `<header>${nav}
      <div class="ch-meta"><span>${pad(S.chapter + 1)} / ${pad(chapters.length)}</span>
        <label class="viewed-box" title="Mark every file in this chapter reviewed (V)"><input type="checkbox" data-chapter-reviewed ${done.has(S.chapter) ? "checked" : ""}> Reviewed</label></div>
      <h2>${esc(ch.plain ? ch.summary : ch.title)}</h2>${!ch.plain && ch.summary ? `<p>${esc(ch.summary)}</p>` : ""}
      ${ch.why ? `<dl class="ctx"><dt>Why</dt><dd>${esc(ch.why)}</dd></dl>` : ""}
      ${ch.risk !== "low" || ch.proof ? `<dl class="ctx"><dt><span class="risk ${ch.risk}">${RISK[ch.risk]}</span></dt><dd>${esc(ch.risk_why ?? "")}${ch.proof ? `<span class="proof"><b>Proof</b> ${esc(ch.proof)}</span>` : ""}</dd></dl>` : ""}
      ${ch.noticed ? `<dl class="ctx"><dt>People notice</dt><dd>${esc(ch.noticed)}</dd></dl>` : ""}
      ${ch.check?.length ? checks(a.id, S.chapter, ch.check) : ""}
      ${keys ? `<div class="keys"><h3>What to review</h3><ul>${keys}</ul></div>` : ""}
      ${ch.reviewer_note ? `<aside class="rnote"><div class="w">${mark(ch.reviewer_note.by, "sm")}<b>${esc(name(ch.reviewer_note.by))}</b><span>read the code</span></div><p>${esc(ch.reviewer_note.text)}</p></aside>` : ""}
      <p class="hint">To comment, click a line number or select some code. Shift-click or drag for several lines.</p>
      ${fileList(a, files, byFile)}
    </header>`;
  const code = `<div class="fcards">${[...byFile].map(([path, starts]) => fileSection(a, files.find((f) => f.path === path), path, starts)).join("")}</div>
    <footer class="chapter-end">
      ${last ? finish() : `<button class="btn primary" data-chapter="${S.chapter + 1}" title="Next chapter (J)">Next: ${esc(chapters[S.chapter + 1].title)} ${I.next}</button>`}
    </footer>`;
  return `<article class="chapter beside" data-key="${a.id}:${S.chapter}">
    <div class="notes-col">${notes}<div class="splitter" data-split="notes" title="Drag to resize"></div></div>
    <div class="code-col" id="code-scroll">${code}</div></article>`;
}

// Questions the sender wants answered while you read this chapter. Ticking one is a note
// to yourself, kept on this Mac; nothing is sent.
function checks(att: string, chapter: number, list: string[]): string {
  const done = new Set(local.get(`checks:${att}:${chapter}`, [] as number[]));
  return `<div class="keys"><h3>Questions to answer as you read <span>${done.size}/${list.length}</span></h3><ul class="checks">${list.map((x, i) =>
    `<li><label><input type="checkbox" data-check="${chapter}|${i}" ${done.has(i) ? "checked" : ""}><span>${esc(x)}</span></label></li>`).join("")}</ul></div>`;
}

// The end of the last chapter is where the review is decided: approve, ask for changes, or reply,
// with whatever comments you left on the way going along.
function finish(): string {
  const t = S.data!.thread;
  if (t.to !== me || t.status === "closed") return "";
  const n = drafts(t.id).length;
  return `<div class="finish"><p>${n ? `${n} comment${n === 1 ? "" : "s"} ready to send with your verdict.` : "That is the whole change. No comments yet."}</p>
    <div class="btns"><button class="btn" data-finish="reply">Reply</button><button class="btn" data-finish="changes">Request changes</button><button class="btn primary" data-finish="approve">${I.check} Approve</button></div></div>`;
}

// The chapter's files, each with the lines this chapter adds and removes in it. A click
// brings that file to the top of the code column.
function fileList(a: Pr, files: DiffFile[], byFile: Map<string, number[]>): string {
  const seen = viewed(a.id);
  const rows = [...byFile].map(([path, starts]) => {
    const f = files.find((x) => x.path === path);
    let add = 0, del = 0;
    for (const h of f?.hunks ?? []) if (starts.includes(hunkStart(f!, h))) for (const l of h.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
    const slash = path.lastIndexOf("/");
    return `<li><button data-goto-file="${esc(path)}" title="${esc(path)}">${fileIcon(path)}<span class="fl-name"><b>${esc(path.slice(slash + 1))}</b><span>${esc(slash >= 0 ? path.slice(0, slash + 1) : "")}</span></span>
      <span class="n"><span class="a">+${add}</span> <span class="d">−${del}</span></span>${seen.has(path) ? `<span class="fl-ok" title="Reviewed">${I.check}</span>` : ""}</button></li>`;
  }).join("");
  return `<div class="keys"><h3>Files <span>${byFile.size}</span></h3><ul class="files-list">${rows}</ul></div>`;
}

// One file as a card: name first, folder after, its comments, size and a Reviewed box.
// A reviewed file folds to its header, so what is left open is what is left to read.
function fileSection(a: Pr, df: DiffFile | undefined, path: string, starts: number[]) {
  const pf = a.meta.files.find((f) => f.path === path);
  const full = pf?.new_blob ? S.files.get(pf.new_blob) : undefined;
  const mode = full && S.fileMode[`${a.id}:${path}`] === "full" ? "full" : "diff";
  const hunks = df ? df.hunks.filter((h) => starts.includes(hunkStart(df, h))) : [];
  const seen = viewed(a.id).has(path);
  // A reviewed file folds to its header; Show opens it again, to read or comment, without unticking it.
  const foldable = seen;
  const folded = foldable && !S.unfold.has(`${a.id}:${path}`);
  const slash = path.lastIndexOf("/");
  const file = path.slice(slash + 1), dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const talk = S.data!.messages.reduce((n, m) => n + m.comments.filter((c) => c.attachment_id === a.id && c.anchor?.kind === "code" && c.anchor.file === path).length, 0)
    + drafts(S.cur!).filter((d) => d.attachment_id === a.id && d.anchor.kind === "code" && d.anchor.file === path).length;
  // A Markdown file reads as a document by default; its changed paragraphs are marked.
  const isMd = /\.md$/i.test(path) && !!pf?.new_blob && S.docs.has(pf.new_blob);
  const preview = isMd && S.fileMode[`${a.id}:${path}`] !== "diff" && S.fileMode[`${a.id}:${path}`] !== "full";
  // Side by side applies to the changes; the whole file is one column by nature.
  const split = S.split && mode !== "full" && !onPhone(); // a phone is too narrow for two columns
  cols = split ? 6 : 3;
  const rows = folded || preview ? "" : mode === "full" ? fullRows(a, df, path, full!) : split ? splitRows(a, path, hunks, full) : diffRows(a, path, hunks, full);
  return `<section class="fcard ${seen ? "viewed" : ""}" data-file="${esc(path)}">
    <header class="fhead">${fileIcon(path)}<span class="fname" title="${esc(path)}"><b>${esc(file)}</b><span class="dir">${esc(dir)}</span></span>
      ${talk ? `<span class="talk" title="${talk} comment${talk === 1 ? "" : "s"}">${I.chat}${talk}</span>` : ""}
      ${pf ? `<span class="n"><span class="a">+${pf.additions}</span> <span class="d">−${pf.deletions}</span></span>` : ""}
      ${foldable ? `<button class="link" data-unfold="${esc(path)}">${folded ? "Show" : "Hide"}</button>` : ""}
      ${isMd && !folded ? `<button class="link" data-mode="${esc(path)}|${preview ? "diff" : "preview"}">${preview ? "Show diff" : "Preview"}</button>` : ""}
      <label class="viewed-box"><input type="checkbox" data-viewed="${esc(path)}" ${seen ? "checked" : ""}> Reviewed</label></header>
    ${folded ? "" : preview ? mdPreview(df, pf!.new_blob!) : `<div class="diffwrap"><table class="diff ${split ? "sbs" : ""}"><colgroup>${split ? `<col class="c-ln"><col class="c-sg"><col class="c-tx"><col class="c-ln"><col class="c-sg"><col class="c-tx">` : `<col class="c-ln"><col class="c-sg"><col>`}</colgroup><tbody>${rows || `<tr class="gap"><td colspan="${cols}">${df?.binary ? "Binary file" : "No changes to show"}</td></tr>`}</tbody></table></div>`}
  </section>`;
}

function mdPreview(df: DiffFile | undefined, blob: string): string {
  const added = new Set<number>();
  for (const h of df?.hunks ?? []) { let n = h.new_start; for (const l of h.lines) { if (l[0] === "+") added.add(n); if (l[0] !== "-" && l[0] !== "\\") n++; } }
  const bl = S.docs.get(blob) ?? [];
  const changed = (b: { from: number; to: number }) => { for (let i = b.from; i <= b.to; i++) if (added.has(i)) return true; return false; };
  return `<div class="mdpreview docbody">${bl.map((b) => `<div class="mdblk ${changed(b) ? "changed" : ""}">${b.html}</div>`).join("")}</div>`;
}

// The lines between changes stay folded; each fold says how many lines it hides and opens the whole file.
function gap(path: string, lines: number, context: string, canOpen: boolean) {
  if (lines <= 0 && !context) return "";
  const open = canOpen && lines > 0 ? `<button class="unfold" data-mode="${esc(path)}|full" title="Show the whole file">${I.lineUp}${lines.toLocaleString()} unchanged line${lines === 1 ? "" : "s"}</button>` : "";
  return `<tr class="gap"><td colspan="${cols}"><span class="ctx">${esc(context)}</span>${open}</td></tr>`;
}

function diffRows(a: Pr, path: string, hunks: Hunk[], full?: string[]) {
  let rows = "";
  let shownTo = 0; // last new-side line already on screen
  for (const h of hunks) {
    rows += gap(path, h.new_start - 1 - shownTo, h.header, !!full);
    let o = h.old_start, n = h.new_start;
    for (const l of h.lines) {
      if (l[0] === "\\") continue;
      const s = l[0];
      let cls = "", ol = 0, nl = 0;
      if (s === "+") { cls = "add"; nl = n++; } else if (s === "-") { cls = "del"; ol = o++; } else { ol = o++; nl = n++; }
      const html = nl && full?.[nl - 1] !== undefined ? full[nl - 1] : highlightLine(l.slice(1), path);
      rows += row(a, path, nl ? "new" : "old", nl || ol, cls, s === "+" ? "+" : s === "-" ? "−" : "", html);
    }
    shownTo = h.new_start + Math.max(h.new_lines, 0) - 1;
  }
  if (full && hunks.length) rows += gap(path, full.length - shownTo - (full[full.length - 1] === "" ? 1 : 0), "", true);
  return rows;
}

// Side by side: removed lines on the left, added on the right, a run of removals paired with
// the run of additions that follows it. Each half keeps its own line address (file|side|line),
// so comments, selection, jumps and find work exactly as in one column.
function splitRows(a: Pr, path: string, hunks: Hunk[], full?: string[]) {
  const s = S.sel;
  const half = (side: "old" | "new", line: number, cls: string, sign: string, html: string) => {
    if (!line) return `<td class="ln empty"></td><td class="sg empty"></td><td class="tx empty"></td>`;
    const key = esc(`${path}|${side}|${line}`);
    const sel = s && s.att === a.id && s.file === path && s.side === side && line >= s.start && line <= s.end ? " sel" : "";
    const c = `${cls}${sel}`;
    return `<td class="ln ${c}" data-key="${key}"><button data-line="${esc(path)}|${side}|${line}" aria-label="Select ${side === "old" ? "removed " : ""}line ${line}">${line}</button></td><td class="sg ${c}" data-key="${key}">${sign}</td><td class="tx ${c}" data-key="${key}">${html || " "}</td>`;
  };
  const code = (side: "old" | "new", line: number, text: string) => side === "new" && full?.[line - 1] !== undefined ? full[line - 1] : highlightLine(text, path);
  let rows = "", shownTo = 0;
  for (const h of hunks) {
    rows += gap(path, h.new_start - 1 - shownTo, h.header, !!full);
    let o = h.old_start, n = h.new_start;
    const lines = h.lines.filter((l) => l[0] !== "\\");
    for (let i = 0; i < lines.length;) {
      if (lines[i][0] === " ") {
        const t = lines[i].slice(1);
        rows += `<tr>${half("old", o, "", "", highlightLine(t, path))}${half("new", n, "", "", code("new", n, t))}</tr>` + notesAt(a, path, "old", o) + notesAt(a, path, "new", n);
        o++; n++; i++; continue;
      }
      const del: string[] = [], add: string[] = [];
      while (i < lines.length && lines[i][0] === "-") del.push(lines[i++].slice(1));
      while (i < lines.length && lines[i][0] === "+") add.push(lines[i++].slice(1));
      for (let k = 0; k < Math.max(del.length, add.length); k++) {
        const ol = k < del.length ? o + k : 0, nl = k < add.length ? n + k : 0;
        rows += `<tr>${half("old", ol, "del", "−", ol ? highlightLine(del[k], path) : "")}${half("new", nl, "add", "+", nl ? code("new", nl, add[k]) : "")}</tr>`
          + (ol ? notesAt(a, path, "old", ol) : "") + (nl ? notesAt(a, path, "new", nl) : "");
      }
      o += del.length; n += add.length;
    }
    shownTo = h.new_start + Math.max(h.new_lines, 0) - 1;
  }
  if (full && hunks.length) rows += gap(path, full.length - shownTo - (full[full.length - 1] === "" ? 1 : 0), "", true);
  return rows;
}

function fullRows(a: Pr, df: DiffFile | undefined, path: string, full: string[]) {
  const added = new Set<number>();
  for (const h of df?.hunks ?? []) { let n = h.new_start; for (const l of h.lines) { if (l[0] === "+") added.add(n); if (l[0] !== "-" && l[0] !== "\\") n++; } }
  const back = `<tr class="gap"><td colspan="3"><span class="ctx">Whole file</span><button class="unfold" data-mode="${esc(path)}|diff">Show changes only</button></td></tr>`;
  return back + full.map((html, i) => row(a, path, "new", i + 1, added.has(i + 1) ? "add" : "", added.has(i + 1) ? "+" : "", html)).join("");
}

// One number per line: the new line, or the old one for a removed line, which is what a comment anchors to.
function row(a: Pr, path: string, side: "old" | "new", line: number, cls: string, sign: string, html: string) {
  const s = S.sel;
  const sel = s && s.att === a.id && s.file === path && s.side === side && line >= s.start && line <= s.end;
  return `<tr class="${cls} ${sel ? "sel" : ""}" data-key="${esc(`${path}|${side}|${line}`)}"><td class="ln"><button data-line="${esc(path)}|${side}|${line}" aria-label="Select ${side === "old" ? "removed " : ""}line ${line}">${line}</button></td><td class="sg">${sign}</td><td class="tx">${html || " "}</td></tr>` + notesAt(a, path, side, line);
}

// Sent comments, unsent drafts and the selection's actions sit under the last line they cover.
function notesAt(a: Pr, path: string, side: "old" | "new", line: number) {
  const hits = (an: Anchor | null) => an?.kind === "code" && an.file === path && an.side === side && an.end_line === line;
  let out = "";
  for (const m of S.data!.messages) for (const c of m.comments) {
    if (c.attachment_id !== a.id || !hits(c.anchor)) continue;
    out += note(`<div class="card"><div class="who">${mark(c.author, "sm")}<b>${esc(name(c.author))}</b><span>${esc(lineLabel(c.anchor as any))} · ${when(m.created_at)}</span></div><div class="body">${esc(c.body)}</div></div>`);
  }
  for (const d of drafts(S.cur!).filter((d) => d.attachment_id === a.id && hits(d.anchor))) {
    out += note(`<div class="card draft"><div class="who">${mark(me, "sm")}<b>You</b><span>${esc(d.label)} · not sent yet</span><button class="link" data-del="${d.id}">Delete</button></div><div class="body">${esc(d.body)}</div></div>`);
  }
  const s = S.sel;
  if (s && s.att === a.id && s.file === path && s.side === side && s.end === line) {
    if (S.editing?.key === selKey(s)) {
      const other = S.data!.thread.from === me ? S.data!.thread.to : S.data!.thread.from;
      out += note(`<div class="card editing"><div class="who"><b>Comment</b><span>${esc(selLabel(s))}</span></div>
        <textarea id="edit" rows="3" aria-label="Comment on ${esc(selLabel(s))}" placeholder="What should ${esc(name(other))} know about this?"></textarea>
        <div class="btns"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save title="⌘↩">Add comment</button></div></div>`);
    } else {
      out += note(`<div class="selbar"><span>${esc(selLabel(s))}</span><button class="btn" data-comment>${I.chat} Comment</button><button class="btn" data-ask-sel>${helperMark()} Ask</button><button class="link" data-clear>Clear</button></div>`);
    }
  }
  return out;
}

// Columns in the table being drawn: 3 unified (number, sign, code), 6 side by side.
let cols = 3;
const note = (html: string) => `<tr class="note"><td colspan="${cols}">${html}</td></tr>`;
export const selKey = (s: Sel) => `${s.att}|${s.file}|${s.side}|${s.start}|${s.end}`;
export const selLabel = (s: Sel) => `${s.file.split("/").pop()} ${s.side === "old" ? "removed " : ""}line${s.end > s.start ? `s ${s.start}–${s.end}` : ` ${s.start}`}`;
const lineLabel = (an: { file: string; start_line: number; end_line: number; side: string }) =>
  `${an.file.split("/").pop()}:${an.start_line}${an.end_line !== an.start_line ? `–${an.end_line}` : ""}${an.side === "old" ? " (removed)" : ""}`;

export function anchorLabel(an: Anchor | null): string {
  if (!an) return "";
  if (an.kind === "code") return lineLabel(an);
  const q = plain(an.quote);
  return `“${q.slice(0, 60)}${q.length > 60 ? "…" : ""}”`;
}

export function prLink(): string {
  const a = findAtt(S.att);
  return a?.type === "pr" && a.meta.url ? a.meta.url : "";
}
