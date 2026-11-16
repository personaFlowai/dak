import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDiff, hunkStart, lineInDiff, type DiffFile } from "./diff";
import { putBlob } from "./store";
import type { Chapter, PrMeta, Prologue } from "./types";
import { DakError } from "./types";

function run(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new DakError("command_failed", `${cmd.join(" ")} failed: ${p.stderr.toString().trim() || "exit " + p.exitCode}`);
  }
  return p.stdout.toString();
}

function tryRun(cmd: string[], cwd: string): string | null {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString() : null;
}

// Everything the review screen needs, copied now: the diff, and each changed
// file at head. Later pushes, rebases or a deleted branch cannot break the review.
export function snapshotPr(opts: {
  repo?: string; pr?: string; base?: string; diffFile?: string; chaptersFile?: string; url?: string; title?: string;
}): { meta: PrMeta; files: DiffFile[] } {
  const repo = resolve(opts.repo ?? ".");
  let diff = "", url = opts.url ?? null, number: number | null = null, title = opts.title ?? null;
  let base: string | null = null, head: string | null = null;

  if (opts.diffFile) {
    diff = readFileSync(opts.diffFile, "utf8");
    head = tryRun(["git", "rev-parse", "HEAD"], repo)?.trim() ?? null;
  } else if (opts.pr) {
    const info = JSON.parse(run(["gh", "pr", "view", opts.pr, "--json", "number,title,url,headRefOid,baseRefOid"], repo));
    number = info.number; title ??= info.title; url ??= info.url; head = info.headRefOid; base = info.baseRefOid;
    diff = run(["gh", "pr", "diff", opts.pr], repo);
  } else {
    const baseRef = opts.base ?? "main";
    base = run(["git", "merge-base", baseRef, "HEAD"], repo).trim();
    head = run(["git", "rev-parse", "HEAD"], repo).trim();
    diff = run(["git", "diff", "--no-color", "--find-renames", `${base}...${head}`], repo);
  }
  if (!diff.trim()) throw new DakError("empty_diff", "That diff is empty: there is nothing to review.");

  const files = parseDiff(diff);
  const chapters: Chapter[] = opts.chaptersFile ? loadChapters(opts.chaptersFile) : [];
  const prologue = opts.chaptersFile ? loadPrologue(opts.chaptersFile) : undefined;
  if (chapters.length) {
    const problems = checkChapters(chapters, files);
    if (problems.length) throw new DakError("bad_chapters", "Chapters do not match the diff:\n  " + problems.join("\n  "));
  }

  const meta: PrMeta = {
    url, number, title, repo: existsSync(repo) ? repo : null, base_sha: base, head_sha: head,
    diff_blob: putBlob(diff),
    files: files.map((f) => ({
      path: f.path, old_path: f.old_path, status: f.status, additions: f.additions, deletions: f.deletions,
      new_blob: f.status === "deleted" || f.binary ? null : snapshotFile(repo, head, f.path),
    })),
    chapters,
    ...(prologue ? { prologue } : {}),
  };
  return { meta, files };
}

function snapshotFile(repo: string, head: string | null, path: string): string | null {
  const fromGit = head ? tryRun(["git", "show", `${head}:${path}`], repo) : null;
  if (fromGit !== null) return putBlob(fromGit);
  const onDisk = resolve(repo, path);
  return existsSync(onDisk) ? putBlob(readFileSync(onDisk)) : null;
}

export function loadPrologue(path: string): Prologue | undefined {
  try {
    const p = JSON.parse(readFileSync(path, "utf8"))?.prologue;
    if (!p || typeof p !== "object") return undefined;
    return { ...(p.why ? { why: String(p.why) } : {}), ...(p.what ? { what: String(p.what) } : {}),
      ...(Array.isArray(p.focus) ? { focus: p.focus.map(String).slice(0, 6) } : {}) };
  } catch { return undefined; }
}

export function loadChapters(path: string): Chapter[] {
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (e: any) { throw new DakError("bad_chapters", `Could not read ${path} as JSON: ${e.message}`); }
  const list = Array.isArray(raw) ? raw : raw?.chapters;
  if (!Array.isArray(list)) throw new DakError("bad_chapters", "Chapters must be a JSON array, or an object with a chapters array.");
  return list.map((c: any, i: number) => {
    if (!c?.title || !Array.isArray(c.hunks)) throw new DakError("bad_chapters", `Chapter ${i + 1} needs a title and a hunks array.`);
    const risk = ["low", "medium", "high"].includes(c.risk) ? c.risk : "low";
    const str = (v: any) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const note = c.reviewer_note && str(c.reviewer_note.text) ? { by: str(c.reviewer_note.by) ?? "reviewer", text: str(c.reviewer_note.text)! } : undefined;
    return { title: String(c.title), summary: String(c.summary ?? ""), risk, risk_why: c.risk_why ? String(c.risk_why) : undefined,
      why: str(c.why), proof: str(c.proof), noticed: str(c.noticed), reviewer_note: note,
      check: Array.isArray(c.check) ? c.check.map(String).filter((x: string) => x.trim()).slice(0, 6) : undefined,
      hunks: c.hunks.map((h: any) => ({ file: String(h.file), start: Number(h.start) })),
      key_changes: Array.isArray(c.key_changes) ? c.key_changes.map((k: any) => ({
        text: String(k.text), file: String(k.file), side: k.side === "old" ? "old" : "new", line: Number(k.line) })) : [] };
  });
}

// Every hunk in exactly one chapter, and every reference pointing at a real place.
// The errors name what is wrong, so an agent can fix its file in one pass.
export function checkChapters(chapters: Chapter[], files: DiffFile[]): string[] {
  const problems: string[] = [];
  const all = new Map<string, string>();
  for (const f of files) for (const h of f.hunks) all.set(`${f.path}:${hunkStart(f, h)}`, `${f.path} hunk at line ${hunkStart(f, h)}`);
  const seen = new Map<string, number>();
  chapters.forEach((c, i) => {
    // A risk level with no reason teaches the reader nothing.
    if (c.risk !== "low" && !c.risk_why?.trim()) problems.push(`Chapter ${i + 1} ("${c.title}") is ${c.risk} risk but has no risk_why: say in one sentence what could go wrong.`);
    // A high risk the reader has to take on trust is a risk they cannot sign off.
    if (c.risk === "high" && !c.proof?.trim()) problems.push(`Chapter ${i + 1} ("${c.title}") is high risk but has no proof: name the test, run or number that shows it is safe.`);
    for (const h of c.hunks) {
      const key = `${h.file}:${h.start}`;
      if (!all.has(key)) problems.push(`Chapter ${i + 1} ("${c.title}") points at ${h.file} line ${h.start}, which is not the start of a hunk.`);
      else if (seen.has(key)) problems.push(`${all.get(key)} is in chapter ${seen.get(key)} and chapter ${i + 1}; put it in one.`);
      else seen.set(key, i + 1);
    }
    for (const k of c.key_changes ?? []) {
      if (!lineInDiff(files, k.file, k.side ?? "new", k.line)) {
        problems.push(`Chapter ${i + 1} key change "${k.text}" points at ${k.file} ${k.side ?? "new"} line ${k.line}, which is not in the diff.`);
      }
    }
  });
  for (const [key, label] of all) if (!seen.has(key)) problems.push(`${label} is in no chapter.`);
  return problems;
}

export function diffForChapters(opts: { repo?: string; pr?: string; base?: string; diffFile?: string }): DiffFile[] {
  const repo = resolve(opts.repo ?? ".");
  if (opts.diffFile) return parseDiff(readFileSync(opts.diffFile, "utf8"));
  if (opts.pr) return parseDiff(run(["gh", "pr", "diff", opts.pr], repo));
  const base = run(["git", "merge-base", opts.base ?? "main", "HEAD"], repo).trim();
  return parseDiff(run(["git", "diff", "--no-color", "--find-renames", `${base}...HEAD`], repo));
}
