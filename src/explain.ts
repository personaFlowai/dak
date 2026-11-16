import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HELPERS, MODEL_FLAG, loadConfig } from "./config";
import { getThread, readBlobText } from "./store";
import { parseDiff } from "./diff";
import { agents } from "./presence";
import type { Attachment, PrMeta } from "./types";
import { DakError } from "./types";

// The helper is a read-only agent (claude -p by default, or Codex or Cursor, chosen
// in Settings) that answers the reader's questions about what they are reviewing.
// It never posts to the thread: answers are for the person reading, and only they
// decide whether any of it becomes a comment.

export interface AskInput {
  thread_id: string;
  question?: string;
  attachment_id?: string;
  // a code selection
  file?: string; side?: "old" | "new"; start_line?: number; end_line?: number;
  // or words selected in a doc
  quote?: string;
  history?: { q: string; a: string }[];
}

let running = 0;
const MAX = 60_000; // characters of context: plenty for a brief or a mid-sized PR

export async function ask(input: AskInput): Promise<{ answer: string; command: string; seconds: number }> {
  const { thread, messages } = getThread(input.thread_id);
  const att = input.attachment_id ? messages.flatMap((m) => m.attachments).find((a) => a.id === input.attachment_id) : undefined;
  if (input.attachment_id && !att) throw new DakError("no_attachment", "That attachment is not on this thread.", 404);
  if (running >= 2) throw new DakError("busy", "Two answers are already being written. Try again in a moment.", 429);

  const parts: string[] = [
    "You are a read-only helper for a founder reviewing work an AI agent sent him. Explain in plain words, for someone who knows the product but not every library.",
    "Be short: a few sentences, then a short list only if it helps. Do not suggest edits unless asked. You may read files in this folder. Do not modify anything.",
    "",
    `Thread: "${thread.subject}", from ${thread.from} to ${thread.to}.`,
    "Conversation so far:",
    ...messages.slice(-10).map((m) => `- ${m.author}${m.verdict ? ` (${m.verdict})` : ""}: ${m.body.trim().slice(0, 1200) || "(no text)"}`),
  ];

  let cwd = "";
  let files: Record<string, string> = {};
  if (att?.type === "pr") {
    const meta = att.meta as PrMeta;
    cwd = meta.repo && existsSync(meta.repo) ? meta.repo : "";
    for (const f of meta.files) if (f.new_blob) files[f.path] = readBlobText(f.new_blob);
    parts.push("", `Pull request${meta.title ? `: ${meta.title}` : ""}${meta.url ? ` (${meta.url})` : ""}`);
    if (meta.chapters.length) parts.push("Chapters:", ...meta.chapters.map((c, i) => [`${i + 1}. ${c.title} [${c.risk}] ${c.summary}`,
      c.why && `   Why: ${c.why}`, c.risk_why && `   Risk: ${c.risk_why}`, c.proof && `   Proof: ${c.proof}`, c.noticed && `   Noticed: ${c.noticed}`,
      c.check?.length && `   Check: ${c.check.join("; ")}`, c.reviewer_note && `   Reviewer (${c.reviewer_note.by}): ${c.reviewer_note.text}`].filter(Boolean).join("\n")));
    parts.push("Diff:", "```diff", readBlobText(meta.diff_blob).slice(0, MAX), "```");
    if (input.file && input.start_line) parts.push(...codeSelection(meta, input, files));
  } else if (att?.type === "doc") {
    const text = readBlobText(att.meta.blob);
    files[att.name] = text;
    // A brief usually talks about the sender's code: read from the sender's own folder when Dak knows it.
    const sender = agents().find((a) => a.name === thread.from && a.where && existsSync(a.where));
    cwd = sender?.where ?? "";
    parts.push("", `Document ${att.name} (version ${att.meta.version}):`, "```markdown", text.slice(0, MAX), "```");
    if (input.quote) parts.push("", `The reader selected these words: "${input.quote}"`);
  }
  for (const h of input.history ?? []) parts.push("", `Earlier question: ${h.q}`, `Your answer: ${h.a}`);
  parts.push("", `Question: ${input.question?.trim() || (input.file ? "What does this do, and why is it here?" : input.quote ? "What does this mean here, and why does it matter?" : "Summarise this in plain words: what changes, and what should I look at closely?")}`);

  return run(parts.join("\n"), cwd, files);
}

function codeSelection(meta: PrMeta, input: AskInput, files: Record<string, string>): string[] {
  const lines = (files[input.file!] ?? "").split("\n");
  const s = input.start_line!, e = input.end_line ?? s;
  const where = `${input.file} ${input.side === "old" ? "removed " : ""}line${e > s ? `s ${s}-${e}` : ` ${s}`}`;
  if (input.side === "old") {
    const df = parseDiff(readBlobText(meta.diff_blob)).find((f) => f.path === input.file);
    const removed: string[] = [];
    for (const h of df?.hunks ?? []) { let o = h.old_start; for (const l of h.lines) { if (l[0] === "+" || l[0] === "\\") continue; if (o >= s && o <= e) removed.push(l.slice(1)); o++; } }
    return ["", `Selected: ${where} (this code was removed by the PR)`, "```", removed.join("\n"), "```"];
  }
  const from = Math.max(1, s - 30), to = Math.min(lines.length, e + 30);
  const around = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}${from + i >= s && from + i <= e ? " >" : "  "} ${l}`).join("\n");
  return ["", `Selected: ${where}`, "Around it, at the PR's head (> marks the selection):", "```", around, "```"];
}

// Kept for the code-selection endpoint the screens already use.
export const explain = (input: Required<Pick<AskInput, "thread_id" | "attachment_id" | "file" | "start_line">> & AskInput) => ask(input);

async function run(prompt: string, cwd: string, files: Record<string, string>) {
  let temp = "";
  if (!cwd) {
    temp = mkdtempSync(join(tmpdir(), "dak-ask-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(temp, path)), { recursive: true });
      writeFileSync(join(temp, path), text);
    }
    cwd = temp;
  }
  const cfg = loadConfig();
  const { timeout_seconds } = cfg.explain;
  const model = cfg.helper !== "custom" ? cfg.models[cfg.helper] : undefined;
  const command = model && cfg.helper !== "custom" ? [...cfg.explain.command, MODEL_FLAG[cfg.helper], model] : cfg.explain.command;
  const started = Date.now();
  running++;
  try {
    // DAK_HELPER tells Dak's own hooks to stay out: the helper is not an agent, and its
    // temporary folder must not show up as one that others can write to.
    const proc = Bun.spawn([...command, prompt], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, DAK_HELPER: "1" } });
    const timer = setTimeout(() => proc.kill(), timeout_seconds * 1000);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (code !== 0 || !stdout.trim()) {
      const why = proc.killed ? `it took longer than ${timeout_seconds} seconds` : (stderr.trim().split("\n").pop() || `it exited with code ${code}`);
      throw new DakError("explain_failed", `The helper (${command[0]}) could not answer: ${why}.`, 502);
    }
    return { answer: stdout.trim(), command: labelFor(command[0]) + (model ? ` (${model})` : ""), seconds };
  } catch (e: any) {
    if (e instanceof DakError) throw e;
    if (e?.code === "ENOENT") throw new DakError("explain_missing", `"${command[0]}" is not installed. Pick another helper in Settings.`, 502);
    throw e;
  } finally {
    running--;
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

const labelFor = (bin: string) => Object.values(HELPERS).find((h) => h.command[0] === bin)?.label ?? bin;
