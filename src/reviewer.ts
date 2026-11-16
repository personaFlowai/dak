/* Reviewer runners: a reader that is a command, not a session. Send a PR to "codex" and
   Dak runs `codex exec` read-only in the PR's folder, then posts its findings back on the
   thread as line comments, with a verdict, and fills in the chapters or reviewer notes.
   Nobody copies findings between files and messages.

   The server runs them (the Mac app keeps it up), one at a time per runner, and only when
   a message reaches the runner: nothing runs on a timer. Every run is a model call the
   owner pays for, so a runner exists only because someone added it with `dak runner add`. */
import { existsSync } from "node:fs";
import { HELPERS } from "./config";
import { addMessage, getThread, markRead, refreshPr, readBlobText, store, takeUnread, type NewComment } from "./store";
import { lineInDiff, parseDiff } from "./diff";
import { checkChapters, parseChapters } from "./pr";
import { touch } from "./presence";
import { DakError, type Chapter, type Message, type PrMeta, type Verdict } from "./types";

export interface Runner { name: string; command: string[]; timeout_seconds: number }

// The read-only presets: a reviewer reads the code and never edits it.
const PRESETS: Record<string, { tool: string; command: string[] }> = {
  codex: { tool: "codex", command: HELPERS.codex.command },
  cursor: { tool: "cursor", command: HELPERS.cursor.command },
  claude: { tool: "claude-code", command: HELPERS.claude.command },
};

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS runners (name TEXT PRIMARY KEY, command TEXT NOT NULL, timeout_seconds INTEGER NOT NULL)`);
}

export function runners(): Runner[] {
  ensure();
  return (store().query("SELECT * FROM runners ORDER BY name").all() as any[]).map((r) => ({ name: r.name, command: JSON.parse(r.command), timeout_seconds: r.timeout_seconds }));
}

export function addRunner(name: string, opts: { preset?: string; command?: string[]; timeout_seconds?: number } = {}): Runner {
  ensure();
  const n = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(n)) throw new DakError("bad_runner", "A runner's name is letters, digits, - and _.");
  const preset = PRESETS[opts.preset ?? n];
  const command = opts.command?.length ? opts.command : preset?.command;
  if (!command?.length) throw new DakError("bad_runner", `Say what to run: --preset codex|cursor|claude, or --command '["prog","arg"]'.`);
  const timeout = Math.max(30, Math.min(opts.timeout_seconds ?? 1200, 3600));
  store().query("INSERT INTO runners VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET command = excluded.command, timeout_seconds = excluded.timeout_seconds")
    .run(n, JSON.stringify(command), timeout);
  touch(n, { tool: preset?.tool ?? "cli" }); // so it can be sent to
  return { name: n, command, timeout_seconds: timeout };
}

export function removeRunner(name: string) {
  ensure();
  store().query("DELETE FROM runners WHERE name = ?").run(name.toLowerCase());
}

/* ---------- the loop ---------- */

const busy = new Set<string>();

// Called by the server every few seconds: each idle runner takes its next thread.
export function tickRunners(run = runOnce) {
  for (const r of runners()) {
    if (busy.has(r.name)) continue;
    const mail = takeUnread(r.name, { peek: true });
    if (!mail.length) continue;
    const threadId = mail[0].thread_id;
    const last = mail.filter((m) => m.thread_id === threadId).pop()!;
    markRead(r.name, threadId, last.id); // taken: a second tick must not start it again
    busy.add(r.name);
    run(r, threadId).catch((e) => post(r.name, threadId, `I could not finish the review: ${e?.message ?? e}`, true))
      .finally(() => busy.delete(r.name));
  }
}

export async function runOnce(r: Runner, threadId: string) {
  const { thread, messages } = getThread(threadId);
  const pr = messages.flatMap((m) => m.attachments).filter((a) => a.type === "pr").pop();
  const meta = pr?.meta as PrMeta | undefined;
  const cwd = meta?.repo && existsSync(meta.repo) ? meta.repo : process.cwd();
  const out = await spawn(r, prompt(thread.subject, messages, meta), cwd);
  const parsed = parseOutput(out);
  if (!parsed || !meta) return post(r.name, threadId, parsed?.summary ?? out.trim(), false);
  return applyReview(r.name, threadId, meta, parsed);
}

function prompt(subject: string, messages: Message[], meta?: PrMeta): string {
  const convo = messages.slice(-8).map((m) => `- ${m.author}${m.verdict ? ` (${m.verdict})` : ""}: ${m.body.trim().slice(0, 1500) || "(no text)"}`);
  if (!meta) return [`You are asked on a thread titled "${subject}". The conversation:`, ...convo, "", "Answer the latest message. Read files here if it helps. Do not modify anything."].join("\n");
  const chapters = meta.chapters.length
    ? meta.chapters.map((c, i) => `${i + 1}. ${c.title} [${c.risk}]: ${c.summary} (hunks: ${c.hunks.map((h) => `${h.file}:${h.start}`).join(", ") || "none"})`).join("\n")
    : "(none yet: write them)";
  return [
    "You are a code reviewer. Review this pull request read-only: read any file in this folder, run nothing that changes it.",
    `PR${meta.number ? ` #${meta.number}` : ""}: ${meta.title ?? subject}. Head ${meta.head_sha ?? "?"}, base ${meta.base_ref ?? meta.base_sha ?? "?"}.`,
    "Conversation:", ...convo, "",
    "Chapters:", chapters, "",
    "Diff:", "```diff", readBlobText(meta.diff_blob).slice(0, 120_000), "```", "",
    "Reply with ONLY one JSON object, no prose around it:",
    `{"summary": "two or three plain sentences", "verdict": "approve" | "changes" | "question",`,
    ` "findings": [{"file": "path", "line": 12, "side": "new" | "old", "severity": "high" | "medium" | "low", "body": "what is wrong and why it matters"}],`,
    ` "reviewer_notes": [{"chapter": 1, "text": "your read of that chapter"}],`,
    ` "chapters": [ ...only if there are none above: {"title","summary","risk","risk_why","hunks":[{"file","start"}]} covering every hunk ]}`,
    "A finding's line must be a line in the diff (new side, or old side for removed code). Leave out findings you are not sure of.",
  ].join("\n");
}

async function spawn(r: Runner, text: string, cwd: string): Promise<string> {
  // DAK_HELPER keeps Dak's own hooks out of the runner: it is not a session with a mailbox.
  const proc = Bun.spawn([...r.command, text], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, DAK_HELPER: "1" } });
  const timer = setTimeout(() => proc.kill(), r.timeout_seconds * 1000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0 || !stdout.trim()) {
    throw new Error(proc.killed ? `it took longer than ${r.timeout_seconds} seconds` : (stderr.trim().split("\n").pop() || `${r.command[0]} exited with code ${code}`));
  }
  return stdout;
}

interface Review { summary?: string; verdict?: string; findings?: any[]; reviewer_notes?: any[]; chapters?: any }

// The last {...} in the output: tools print a banner or their reasoning before the answer.
export function parseOutput(out: string): Review | null {
  for (let end = out.lastIndexOf("}"); end > 0; end = out.lastIndexOf("}", end - 1)) {
    for (let start = out.lastIndexOf("{", end); start >= 0; start = out.lastIndexOf("{", start - 1)) {
      try { const v = JSON.parse(out.slice(start, end + 1)); if (v && typeof v === "object" && ("summary" in v || "findings" in v)) return v; } catch { /* keep looking */ }
    }
  }
  return null;
}

const SEVERITY: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

export function applyReview(author: string, threadId: string, meta: PrMeta, r: Review) {
  const files = parseDiff(readBlobText(meta.diff_blob));
  const pr = getThread(threadId).messages.flatMap((m) => m.attachments).filter((a) => a.type === "pr").pop()!;
  const comments: NewComment[] = [];
  const loose: string[] = [];
  for (const f of Array.isArray(r.findings) ? r.findings : []) {
    const side = f?.side === "old" ? "old" : "new", line = Number(f?.line), file = String(f?.file ?? "");
    const text = `${SEVERITY[f?.severity] ? `**${SEVERITY[f.severity]}.** ` : ""}${String(f?.body ?? "").trim()}`;
    if (!String(f?.body ?? "").trim()) continue;
    // Anchored when the line is in the diff; otherwise it still reaches the reader, in the text.
    if (file && Number.isFinite(line) && lineInDiff(files, file, side, line)) {
      comments.push({ attachment_id: pr.id, anchor: { kind: "code", file, side, start_line: line, end_line: line }, body: text });
    } else loose.push(`- ${file ? `\`${file}${Number.isFinite(line) ? `:${line}` : ""}\` ` : ""}${text}`);
  }
  // Chapters: written when there were none, notes added where there were.
  let chaptersNote = "";
  try {
    refreshPr(threadId, (old: PrMeta) => {
      let chapters: Chapter[] = old.chapters;
      if (!chapters.length && r.chapters) {
        const written = parseChapters(r.chapters);
        const problems = checkChapters(written, files);
        if (problems.length) { chaptersNote = `\n\nMy chapters did not fit the diff, so I left them out: ${problems[0]}`; return old; }
        chapters = written.map((c) => ({ ...c, reviewer_note: c.reviewer_note ?? undefined }));
        chaptersNote = `\n\nI wrote ${chapters.length} chapter${chapters.length === 1 ? "" : "s"} for this PR.`;
      }
      const notes = Array.isArray(r.reviewer_notes) ? r.reviewer_notes : [];
      chapters = chapters.map((c, i) => {
        const n = notes.find((x: any) => Number(x?.chapter) === i + 1 && String(x?.text ?? "").trim());
        return n ? { ...c, reviewer_note: { by: author, text: String(n.text).trim() } } : c;
      });
      return { ...old, chapters };
    });
  } catch { /* chapters are extra; the findings still post */ }
  const verdict = (["approve", "changes", "question"].includes(String(r.verdict)) ? r.verdict : null) as Verdict | null;
  const body = [String(r.summary ?? "").trim(), loose.length ? `Not tied to a line in the diff:\n${loose.join("\n")}` : ""].filter(Boolean).join("\n\n") + chaptersNote;
  return addMessage(threadId, { author, body: body || "Reviewed.", verdict, comments });
}

function post(author: string, threadId: string, body: string, failed: boolean) {
  return addMessage(threadId, { author, body: body || "(no answer)", ...(failed ? { needs_reply: false } : {}) });
}
