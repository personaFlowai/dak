/* Code hopping: ⌘-click a name in a PR and see where it is defined and who uses it.
   A text search, not a language server: the PR's own files come from their snapshots (the
   truth at the PR's head), the rest of the repository from `git grep` at the PR's head commit
   (or the working tree, when that commit is not here). A name defined twice, or reached through
   a re-export, gives a short list to pick from rather than one sure jump. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getThread, readBlobText } from "./store";
import { DakError, type PrMeta } from "./types";

export interface Spot { file: string; line: number; text: string; in_pr: boolean }
export interface Snippet { file: string; start: number; lines: string[]; at: number; in_pr: boolean }
export interface Lookup { name: string; defs: (Spot & { snippet?: Snippet })[]; refs: Spot[]; refs_total: number; searched: "head" | "worktree" | "pr" }

const MAX_HITS = 600, MAX_REFS = 200, BEFORE = 2, AFTER = 22;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Lines that define a name, across the languages a PR here is likely to carry.
export function definesName(name: string, text: string): boolean {
  const n = reEsc(name);
  return [
    new RegExp(`\\b(function\\*?|class|interface|type|enum|struct|trait|def|func|fn|module|namespace|protocol)\\s+${n}\\b`),
    new RegExp(`\\b(const|let|var)\\s+${n}\\s*[:=]`),
    // A method or an object's function: "  async save(x) {", "save: (x) =>", "save = async () =>".
    new RegExp(`^\\s*(export\\s+)?(default\\s+)?((public|private|protected|static|readonly|async|override|get|set)\\s+)*${n}\\s*(<[^>]*>)?\\s*\\([^)]*\\)?\\s*(:[^=]*)?\\{\\s*$`),
    new RegExp(`^\\s*${n}\\s*[:=]\\s*(async\\s*)?(\\(|function\\b|[A-Za-z_$][\\w$]*\\s*=>)`),
  ].some((r) => r.test(text)) && !/^\s*(\/\/|#|\*)/.test(text) && !/^\s*(return|if|while|for|switch|await)\b/.test(text);
}

async function run(cmd: string[], cwd: string): Promise<string | null> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out : code === 1 && cmd[1] === "grep" ? "" : null; // git grep exits 1 for "no match"
}

function metaOf(threadId: string, attId: string): PrMeta {
  const a = getThread(threadId).messages.flatMap((m) => m.attachments).find((x) => x.id === attId);
  if (!a || a.type !== "pr") throw new DakError("no_pr", "That is not a PR on this thread.", 404);
  return a.meta as PrMeta;
}

const prText = (meta: PrMeta, file: string): string | null => {
  const f = meta.files.find((x) => x.path === file);
  try { return f?.new_blob ? readBlobText(f.new_blob) : null; } catch { return null; }
};

// The commit to read the repository at: the PR's head when this checkout has it, else the working tree.
async function where(meta: PrMeta): Promise<{ repo: string; rev: string | null } | null> {
  if (!meta.repo || !existsSync(meta.repo)) return null;
  const has = meta.head_sha ? await run(["git", "cat-file", "-e", `${meta.head_sha}^{commit}`], meta.repo) : null;
  return { repo: meta.repo, rev: has !== null && meta.head_sha ? meta.head_sha : null };
}

async function fileText(meta: PrMeta, at: { repo: string; rev: string | null } | null, file: string): Promise<string | null> {
  const pr = prText(meta, file);
  if (pr !== null) return pr;
  if (!at || file.includes("..")) return null;
  if (at.rev) return run(["git", "show", `${at.rev}:${file}`], at.repo);
  const p = join(at.repo, file);
  try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; }
}

export async function snippet(threadId: string, attId: string, file: string, line: number): Promise<Snippet> {
  const meta = metaOf(threadId, attId);
  const text = await fileText(meta, await where(meta), file);
  if (text === null) throw new DakError("no_file", `Cannot read ${file} here.`, 404);
  const all = text.split("\n");
  const start = Math.max(1, line - BEFORE);
  return { file, start, lines: all.slice(start - 1, Math.min(all.length, line + AFTER)), at: line, in_pr: prText(meta, file) !== null };
}

export async function lookup(threadId: string, attId: string, name: string): Promise<Lookup> {
  if (!/^[A-Za-z_$][\w$]{0,80}$/.test(name)) throw new DakError("bad_name", "Look up one name: letters, digits, _ and $.");
  const meta = metaOf(threadId, attId);
  const inPr = new Set(meta.files.filter((f) => f.new_blob).map((f) => f.path));
  const hits: Spot[] = [];
  // The PR's files as they are at its head.
  const word = new RegExp(`(^|[^\\w$])${reEsc(name)}([^\\w$]|$)`);
  for (const path of inPr) {
    const text = prText(meta, path);
    if (text === null) continue;
    text.split("\n").forEach((t, i) => { if (word.test(t) && hits.length < MAX_HITS) hits.push({ file: path, line: i + 1, text: t, in_pr: true }); });
  }
  // The rest of the repository.
  const at = await where(meta);
  if (at) {
    const out = await run(["git", "grep", "-n", "-w", "-I", "-F", "--no-color", "-e", name, ...(at.rev ? [at.rev] : []), "--"], at.repo);
    for (const l of (out ?? "").split("\n")) {
      if (!l || hits.length >= MAX_HITS) continue;
      const body = at.rev && l.startsWith(`${at.rev}:`) ? l.slice(at.rev.length + 1) : l;
      const m = body.match(/^(.*?):(\d+):(.*)$/);
      if (!m || inPr.has(m[1])) continue; // the PR's own files came from their snapshots
      hits.push({ file: m[1], line: Number(m[2]), text: m[3], in_pr: false });
    }
  }
  const defs = hits.filter((h) => definesName(name, h.text)).sort((a, b) => Number(b.in_pr) - Number(a.in_pr));
  const refs = hits.filter((h) => !defs.includes(h));
  const withSnips = await Promise.all(defs.slice(0, 8).map(async (d, i) => {
    if (i >= 3) return d;
    try { return { ...d, snippet: await snippet(threadId, attId, d.file, d.line) }; } catch { return d; }
  }));
  return { name, defs: withSnips, refs: refs.slice(0, MAX_REFS).map((r) => ({ ...r, text: r.text.slice(0, 240) })), refs_total: refs.length,
    searched: at ? (at.rev ? "head" : "worktree") : "pr" };
}
