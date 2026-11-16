#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig, writeConfig, configPath, dakHome, person, HELPERS } from "./config";
import {
  addMessage, createThread, getThread, listThreads, putBlob, refreshPr, requireReader, setStatus, takeUnread,
  addParticipant, decisions, groups, setGroup, awaitingReview,
  type NewAttachment,
} from "./store";
import { touch, detectTool, agents, claimName, whoami, inAgent } from "./presence";
import { SKILL, INSTRUCTIONS } from "./skill";
import pkg from "../package.json";
import { agentHook, CLAUDE_HOOK_SETTINGS } from "./hook";
import { snapshotPr, loadChapters, checkChapters, diffForChapters, draftChapters } from "./pr";
import { DakError, type Message, type Verdict } from "./types";
import { buildCost, buildHandoff, describeCost, describeHandoff, parseParticipant } from "./handoff";
import { addRunner, removeRunner, runners } from "./reviewer";
import { queue, removeQueue, setQueue, type QueueRow } from "./queue";
import type { AwaitingReview } from "./store";

const HELP = `dak: a review inbox and message queue for the agents on your Mac

  dak send --to <reader> --from <name> [what] [message]
      what:  --pr <number> [--repo .]       a GitHub PR, through gh
             --base <ref> [--repo .]        this branch against <ref> (default main)
             --diff <file>                  a diff you already have
             --chapters <file>              chapters for the PR (see dak help chapters)
             --doc <file.md>                a Markdown doc to review (repeatable)
             --file <path>                  any file, images shown inline (repeatable)
             --link <url>                   a link, such as an artifact (repeatable)
             --subject <text>               defaults to the PR title or the doc's heading
             --fyi                          no reply needed: an update, not a question
             --option <text>                a button the reader can answer with (repeatable, up to 6)
  dak inbox --for <reader> [--unread] [--peek]   threads, or with --unread the new messages
  dak wait <thread> --for <name> [--timeout 15m] wait for a reply, print it, exit
  dak reply <thread> --from <name> [message] [--verdict approve|changes|question] [--doc f] [--file f]
                    [--pr n | --base ref] [--chapters f]   a new version of the PR, on the same thread
                    [--option text]... [--choice text]     buttons to answer with; the button picked
                    [--done]                               the work is finished: the topic leaves the reader's list
                    [--fyi]                                an update that needs no answer (after an approval, text-only replies are updates anyway)
  dak show <thread>                              the whole thread
  dak refresh <thread> [--pr n | --base ref | --diff f] [--chapters f]
                                                 the same PR at its new head (after a rebase), in place: no new version
  dak close <thread>
  send/reply extras:
      --cc <name:role>          also on the thread: reviewer, approver, watcher (repeatable)
      --ready --migration <f|none> --proof tests:pass:412 [--proof ...] [--skipped "e2e: why"] [--head sha]
                                a ready-for-review handoff; refused if a field is missing or the head moved
      --cost 0.15 [--cap 0.25]  what a yes would spend, shown with the buttons
      --head-only (reply)       move the PR to its new head in place, with a note that asks nothing
      --message-file <f|->      the message from a file or stdin, untouched by the shell
  dak add <thread> <name:role>...                bring someone onto a thread; they get it all as new mail
  dak group set <name> <member>... | dak group   send to all of them with --to group:<name>
  dak ack <thread> --from <name> [text]          a member's "done" on a broadcast
  dak decisions [--for <name>]                   every button picked, with the question and its cost
  dak runner add codex | cursor | claude | <name> --command '["prog","arg"]'
                                                 a reader that is a command: PRs sent to it get reviewed headless
  dak runner list | dak runner remove <name>
  dak queue [--all] | dak queue set <pr> --state <s> [--head sha] [--migration f] [--note text] [--title t]
                                                 the merge queue; states: approved testing building merging merged migrated deployed failed held
                                                 --eta 4m: how long this step should take; --after 2413: waits for that PR first
  dak reviewing <thread> [text]                  tell the sender you are reviewing it (the person's "I'm on it")
  dak queue remove <pr>
  dak chapters draft [--pr n | --base ref | --diff f]   a chapters.json with every hunk listed, grouped by folder
  dak chapters check <file> [--pr n | --base ref | --diff f] [--repo .]
  dak agents                                     readers and every session Dak has seen or can see running
  dak whoami                                     your name on Dak in this session (fills in --from and --for)
  dak skill [--plain]                            how to use Dak, for an agent's instructions (--plain: no front matter)
  dak watch --for <name>                         stream new messages as JSON lines (push, for long-lived agents)
  dak hook claude-code                           Claude Code hook: new messages reach the session at each turn
  dak hook print                                 the hooks block for ~/.claude/settings.json
  dak readers [add <name> [--person]]
  dak init --readers you:person,atlas,mitra         (first run)
  dak serve [--port 7474]                        the review screens at http://127.0.0.1:7474
  dak --version
  Add --json to any command for machine-readable output.
`;

const CHAPTERS_HELP = `chapters.json: an array of chapters, in the order a reviewer should read them.

  [{ "title": "Taps call one service function",
     "summary": "One or two sentences: what changed and why.",
     "risk": "low" | "medium" | "high",
     "risk_why": "Only for medium or high: what could go wrong.",
     "why": "Optional: why this part exists, for someone who knows the product, not the code.",
     "proof": "How the risk is shown safe: the test, the run, the number. Required for high.",
     "noticed": "Optional: what a person using the product will notice, or 'Nothing visible'.",
     "check": ["Optional: questions the reviewer should answer while reading"],
     "reviewer_note": { "by": "cursor", "text": "Optional: what a reviewer who read the code wants the reader to know." },
     "hunks": [{ "file": "src/app/taps.ts", "start": 18 }],
     "key_changes": [{ "text": "Permission check removed", "file": "src/app/taps.ts", "side": "old", "line": 20 }] }]

  hunks.start is the hunk's first line on the new side (the old side for a deleted file).
  Every hunk must be in exactly one chapter. dak chapters check names any that are not.
  The file may also be { "prologue": { "why", "what", "focus": [] }, "chapters": [...] }.
`;

function out(json: boolean, data: unknown, text: () => string) {
  console.log(json ? JSON.stringify(data, null, 2) : text());
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) throw new DakError("bad_timeout", `Could not read "${s}" as a time. Use 30s, 15m or 1h.`);
  return +m[1] * ({ ms: 1, s: 1000, m: 60000, h: 3600000 } as any)[m[2] ?? "s"];
}

// Where each person on the thread stands with it: replied, read it all, read part, or not opened.
// "Delivered" and "read" are the same moment for an agent: its hook hands it the mail.
function readLine(t: ReturnType<typeof getThread>): string {
  const who = [...new Set([t.thread.to, t.thread.from, ...t.participants.map((p) => p.name)])].filter((w) => !w.startsWith("group:"));
  const role = (w: string) => t.participants.find((p) => p.name === w)?.role;
  return who.map((w) => {
    const theirs = t.messages.filter((m) => m.author !== w);
    if (!theirs.length) return "";
    const label = role(w) ? `${w} (${role(w)})` : w;
    const lastTheirs = theirs[theirs.length - 1].id;
    const lastOwn = [...t.messages].reverse().find((m) => m.author === w && !m.reviewing);
    if (lastOwn && lastOwn.id > theirs[0].id && w !== t.thread.from) return `${label} replied`;
    const on = [...t.messages].reverse().find((m) => m.author === w && (m.reviewing || m.verdict));
    if (on?.reviewing) return `${label} is reviewing it, since ${new Date(on.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const r = t.reads.find((x) => x.reader === w);
    if (!r || r.up_to < theirs[0].id) return `${label} has not opened it`;
    const at = r.seen_at ? ` at ${new Date(r.seen_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    return r.up_to >= lastTheirs ? `${label} read it all${at}` : `${label} read up to message ${r.up_to}${at}, not the latest`;
  }).filter(Boolean).join(" · ");
}

// The thread's newest PR, re-read at its current head. Chapters stay unless new ones are given,
// and must still match the new diff.
function refreshThread(id: string, values: any) {
  return refreshPr(id, (old) => {
    const pr = values.pr ?? (values.base || values.diff ? undefined : old.number ? String(old.number) : undefined);
    const baseRef = values.base ?? (pr || values.diff ? undefined : old.base_ref);
    if (!pr && !baseRef && !values.diff) throw new DakError("usage", "That diff came from a file: pass --diff <file> (or --base <ref>).");
    const { meta: fresh, files } = snapshotPr({ repo: values.repo ?? old.repo ?? ".", pr, base: baseRef, diffFile: values.diff, chaptersFile: values.chapters });
    if (values.chapters) return fresh;
    const problems = old.chapters.length ? checkChapters(old.chapters, files) : [];
    if (problems.length) throw new DakError("bad_chapters", "The old chapters no longer match the new head; pass --chapters:\n  " + problems.join("\n  "));
    return { ...fresh, chapters: old.chapters, ...(old.prologue ? { prologue: old.prologue } : {}) };
  }).meta;
}

// The queue as Atlas reads it in a terminal: what waits on the person, what is moving, what waits.
function queueText(rows: QueueRow[], reviews: AwaitingReview[], who: string): string {
  const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const left = (r: QueueRow) => { if (!r.eta_at) return ""; const m = Math.round((Date.parse(r.eta_at) - Date.now()) / 60000); return m >= 0 ? `, about ${m} min left` : `, ${-m} min over`; };
  const line = (r: QueueRow) => `  #${String(r.pr).padEnd(6)} ${r.title}  [${r.state} for ${ago(r.state_since)}${left(r)}]${r.after_pr ? ` after #${r.after_pr}` : ""}${r.approval ? "" : ` (no approval from ${who} on the thread)`}${r.note ? `  ${r.note}` : ""}`;
  const moving = rows.filter((r) => ["testing", "building", "merging", "merged", "migrated"].includes(r.state));
  const waiting = rows.filter((r) => ["approved", "held", "failed"].includes(r.state));
  const done = rows.filter((r) => r.state === "deployed");
  return [
    `Waiting for ${who}'s review (${reviews.length})`, ...reviews.map((r) => `  ${r.pr ? `#${r.pr}`.padEnd(7) : "".padEnd(7)} ${r.subject}  [from ${r.from}, ${r.reviewing_since ? `reviewing for ${ago(r.reviewing_since)}` : `waiting ${ago(r.waiting_since)}`}]`),
    "", `In progress (${moving.length})`, ...moving.map(line),
    "", `Approved, waiting (${waiting.length})`, ...waiting.map(line),
    ...(done.length ? ["", `Deployed today (${done.length})`, ...done.map(line)] : []),
  ].join("\n");
}

function readBody(positionals: string[], values: any): string {
  const file = values["message-file"] ?? values["body-file"];
  if (file === "-") return readFileSync(0, "utf8");
  if (file) return readFileSync(file, "utf8");
  return positionals.join(" ");
}

function attachmentsFrom(values: any): NewAttachment[] {
  const list: NewAttachment[] = [];
  for (const path of values.doc ?? []) {
    if (!existsSync(path)) throw new DakError("no_file", `No file at ${path}.`);
    list.push({ type: "doc", name: basename(path), meta: { blob: putBlob(readFileSync(path, "utf8")), version: 1 } });
  }
  for (const path of values.file ?? []) {
    if (!existsSync(path)) throw new DakError("no_file", `No file at ${path}.`);
    const bytes = readFileSync(path);
    list.push({ type: "file", name: basename(path), meta: { blob: putBlob(bytes), size: statSync(path).size, mime: Bun.file(path).type } });
  }
  for (const url of values.link ?? []) list.push({ type: "link", name: url, meta: { url } });
  return list;
}

function describe(m: Message): string {
  const v = m.verdict ? ` [${{ approve: "approved", changes: "changes requested", question: "question" }[m.verdict]}]` : "";
  const lines = [`#${m.id} ${m.author}${v} · ${m.created_at}`];
  if (m.body.trim()) lines.push("  " + m.body.trim().replace(/\n/g, "\n  "));
  if (m.options?.length) lines.push(`  options: ${m.options.map((o) => `[${o}]`).join(" ")}`);
  if (m.choice) lines.push(`  picked: ${m.choice}`);
  if (m.handoff) lines.push(`  ${describeHandoff(m.handoff)}`);
  if (m.cost) lines.push(`  ${describeCost(m.cost)}`);
  for (const a of m.attachments) lines.push(`  attached ${a.type}: ${a.name}`);
  for (const c of m.comments) {
    const where = !c.anchor ? "" : c.anchor.kind === "code"
      ? `${c.anchor.file}:${c.anchor.start_line}${c.anchor.end_line !== c.anchor.start_line ? "-" + c.anchor.end_line : ""}${c.anchor.side === "old" ? " (old)" : ""}`
      : `doc block ${c.anchor.block_index + 1}: "${c.anchor.quote.slice(0, 60)}"`;
    lines.push(`  comment on ${where}: ${c.body.replace(/\n/g, " ")}`);
  }
  return lines.join("\n");
}

// The flags every command shares. Unknown flags fail loudly rather than being ignored.
const OPTIONS = {
  to: { type: "string" }, from: { type: "string" }, for: { type: "string" }, subject: { type: "string" },
  pr: { type: "string" }, repo: { type: "string" }, base: { type: "string" }, diff: { type: "string" },
  chapters: { type: "string" }, doc: { type: "string", multiple: true }, file: { type: "string", multiple: true },
  link: { type: "string", multiple: true }, verdict: { type: "string" }, timeout: { type: "string" },
  "body-file": { type: "string" }, "message-file": { type: "string" }, readers: { type: "string" }, port: { type: "string" },
  unread: { type: "boolean" }, peek: { type: "boolean" }, json: { type: "boolean" }, person: { type: "boolean" },
  force: { type: "boolean" }, fyi: { type: "boolean" }, plain: { type: "boolean" }, done: { type: "boolean" }, option: { type: "string", multiple: true }, choice: { type: "string" }, help: { type: "boolean", short: "h" },
  cc: { type: "string", multiple: true }, ready: { type: "boolean" }, head: { type: "string" }, migration: { type: "string" },
  proof: { type: "string", multiple: true }, skipped: { type: "string", multiple: true }, cost: { type: "string" }, cap: { type: "string" },
  "head-only": { type: "boolean" }, as: { type: "string" }, command: { type: "string" }, preset: { type: "string" },
  eta: { type: "string" }, after: { type: "string" },
  state: { type: "string" }, note: { type: "string" }, thread: { type: "string" }, title: { type: "string" }, all: { type: "boolean" },
} as const;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v" || cmd === "version") { console.log(`dak ${pkg.version}`); return 0; }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(rest[0] === "chapters" ? CHAPTERS_HELP : HELP);
    return 0;
  }
  const { values, positionals } = parseArgs({ args: rest, options: OPTIONS as any, allowPositionals: true }) as any;
  // Inside an agent's session, its Dak name fills in --from and --for: one less thing to get wrong.
  if (inAgent() && ["send", "reply", "inbox", "wait", "watch"].includes(cmd)) {
    if (["send", "reply"].includes(cmd)) values.from ??= whoami();
    else values.for ??= whoami();
  }
  const json = !!values.json;

  switch (cmd) {
    case "init": {
      if (existsSync(configPath()) && !values.force) {
        throw new DakError("exists", `${configPath()} already exists. Use --force to replace it, or dak readers add.`);
      }
      const readers = String(values.readers ?? "me:person").split(",").map((s) => {
        const [name, kind] = s.trim().split(":");
        return { name: name.toLowerCase(), kind: kind === "person" ? "person" : "agent" } as const;
      });
      writeConfig({ readers, port: Number(values.port ?? 7474), helper: "claude", explain: { command: HELPERS.claude.command, timeout_seconds: 180 }, models: {} });
      out(json, { config: configPath(), readers }, () => `Wrote ${configPath()} with readers: ${readers.map((r) => r.name).join(", ")}`);
      return 0;
    }
    case "readers": {
      const cfg = loadConfig();
      if (positionals[0] === "add") {
        const name = String(positionals[1] ?? "").toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new DakError("bad_name", "A reader name is letters, digits, - or _.");
        if (!cfg.readers.some((r) => r.name === name)) cfg.readers.push({ name, kind: values.person ? "person" : "agent" });
        writeConfig(cfg);
      }
      out(json, loadConfig().readers, () => loadConfig().readers.map((r) => `${r.name} (${r.kind})`).join("\n"));
      return 0;
    }
    case "send": {
      if (!values.to) throw new DakError("no_reader", "Say who it is for with --to <reader>.");
      if (!values.from) throw new DakError("no_sender", "Say who is sending with --from <name>.");
      touch(values.from, { tool: detectTool(), where: process.cwd() }); claimName(values.from);
      const atts = attachmentsFrom(values);
      let kind: "pr" | "doc" | "note" = atts.some((a) => a.type === "doc") ? "doc" : "note";
      let subject = values.subject as string | undefined;
      let prMeta: any = null;
      if (values.pr || values.base || values.diff) {
        const { meta } = snapshotPr({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff, chaptersFile: values.chapters });
        atts.unshift({ type: "pr", name: meta.number ? `PR #${meta.number}` : "Changes", meta });
        prMeta = meta;
        kind = "pr";
        subject ??= meta.title ?? undefined;
      }
      if (!subject) {
        const doc = (values.doc ?? [])[0];
        const heading = doc ? readFileSync(doc, "utf8").match(/^#\s+(.+)$/m)?.[1] : undefined;
        subject = heading ?? (values.file ?? [])[0] ?? readBody(positionals, values).split("\n")[0].slice(0, 80);
      }
      const extra = { handoff: values.ready ? buildHandoff(prMeta, values) : undefined, cost: buildCost(values) };
      const { thread, message } = createThread({ to: values.to, from: values.from, subject: subject ?? "", kind, body: readBody(positionals, values), attachments: atts, options: values.option,
        participants: (values.cc ?? []).map(parseParticipant), extra, ...(values.fyi ? { needs_reply: false } : {}) });
      out(json, { thread, message }, () => `Sent ${thread.id} to ${thread.to}: ${thread.subject}\nWait for the reply with: dak wait ${thread.id} --for ${thread.from}`);
      return 0;
    }
    case "inbox": {
      const reader = String(values.for ?? person(loadConfig())).toLowerCase();
      touch(reader, { tool: detectTool(), where: process.cwd() });
      if (values.unread) {
        const msgs = takeUnread(reader, { peek: values.peek });
        out(json, msgs, () => msgs.length ? msgs.map(describe).join("\n\n") : "Nothing new.");
      } else {
        const list = listThreads(reader);
        out(json, list, () => list.length ? list.map((t) =>
          `${t.unread ? "●" : " "} ${t.id}  ${t.from} → ${t.to}  [${t.kind}, ${t.status}]  ${t.subject}`).join("\n") : "No threads yet.");
      }
      return 0;
    }
    case "wait": {
      const id = positionals[0];
      if (!id) throw new DakError("no_thread", "Which thread? dak wait <thread> --for <name>");
      const reader = String(values.for ?? values.from ?? "");
      if (!reader) throw new DakError("no_reader", "Say who is waiting with --for <name>.");
      const { thread } = getThread(id);
      touch(reader.toLowerCase(), { tool: detectTool(), where: process.cwd() });
      const deadline = Date.now() + parseDuration(values.timeout ?? "15m");
      while (true) {
        const msgs = takeUnread(reader.toLowerCase(), { threadId: thread.id });
        if (msgs.length) {
          out(json, { thread: getThread(id).thread, messages: msgs }, () => msgs.map(describe).join("\n\n"));
          return 0;
        }
        if (Date.now() >= deadline) {
          out(json, { thread, messages: [], timed_out: true }, () => `No reply on ${id} yet. Run dak wait again later.`);
          return 2;
        }
        await Bun.sleep(1000);
      }
    }
    case "reply": {
      const id = positionals.shift();
      if (!id) throw new DakError("no_thread", "Which thread? dak reply <thread> --from <name> <message>");
      if (!values.from) throw new DakError("no_sender", "Say who is replying with --from <name>.");
      touch(values.from, { tool: detectTool(), where: process.cwd() }); claimName(values.from);
      const verdict = values.verdict as Verdict | undefined;
      if (verdict && !["approve", "changes", "question"].includes(verdict)) {
        throw new DakError("bad_verdict", "A verdict is approve, changes or question.");
      }
      const atts = attachmentsFrom(values);
      const { messages } = getThread(id);
      // A new doc with the same name as an earlier one is its next version.
      for (const a of atts) if (a.type === "doc") {
        const prior = messages.flatMap((m) => m.attachments).filter((x) => x.type === "doc" && x.name === a.name).length;
        (a.meta as any).version = prior + 1;
      }
      let prMeta: any = null;
      if (values["head-only"]) {
        // Same review, new head (a rebase, a renumbered migration): swap it in place, and say why.
        prMeta = refreshThread(id, values);
      } else if (values.pr || values.base || values.diff) {
        const { meta } = snapshotPr({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff, chaptersFile: values.chapters });
        atts.unshift({ type: "pr", name: meta.number ? `PR #${meta.number}` : "Changes", meta });
        prMeta = meta;
      }
      if (values.ready && !prMeta) prMeta = messages.flatMap((m) => m.attachments).filter((a) => a.type === "pr").pop()?.meta ?? null;
      const extra = { handoff: values.ready ? buildHandoff(prMeta, values) : undefined, cost: buildCost(values) };
      for (const c of values.cc ?? []) addParticipant(id, parseParticipant(c));
      const body = readBody(positionals, values);
      if (values["head-only"] && !body.trim() && !values.ready) { out(json, { thread: id, head_sha: prMeta.head_sha }, () => `Moved ${id} to ${prMeta.head_sha?.slice(0, 7)}.`); return 0; }
      // --done: the work is finished (merged, shipped). The note is an update, and the topic
      // leaves the reader's conversation; anything later that asks something brings it back.
      const m = body.trim() || !values.done
        ? addMessage(id, { author: values.from, body, verdict: verdict ?? null, attachments: atts, options: values.option, choice: values.choice, extra,
            ...(values.fyi || values.done || (values["head-only"] && !values.ready) ? { needs_reply: false } : {}) })
        : null;
      if (values.done) setStatus(id, "closed");
      out(json, m ?? { done: id }, () => values.done ? `Marked ${id} done.` : `Replied on ${id}.`);
      return 0;
    }
    case "agents": {
      const list = agents({ scan: true });
      out(json, list, () => list.map((a) => `${a.listening ? "●" : a.running ? "○" : " "} ${a.name.padEnd(42)} ${(a.reader ? (a.kind === "person" ? "person" : "reader") : a.tool ?? "").padEnd(12)} ${a.where ?? ""}`).join("\n")
        + "\n\n● listening (used Dak in the last 10 minutes)   ○ running, not listening yet");
      return 0;
    }
    case "watch": {
      const reader = String(values.for ?? "").toLowerCase();
      if (!reader) throw new DakError("no_reader", "Say whose messages to watch with --for <name>.");
      while (true) {
        touch(reader, { tool: detectTool(), where: process.cwd() });
        for (const m of takeUnread(reader)) console.log(JSON.stringify(m));
        await Bun.sleep(1000);
      }
    }
    case "hook": {
      if (positionals[0] === "claude-code" || positionals[0] === "codex" || positionals[0] === "cursor") { try { await agentHook(positionals[0]); } catch { /* never break a session */ } return 0; }
      if (positionals[0] === "print") {
        console.log(JSON.stringify(CLAUDE_HOOK_SETTINGS(process.execPath.endsWith("/bun") ? "dak" : process.execPath), null, 2));
        return 0;
      }
      throw new DakError("usage", "dak hook claude-code | dak hook print");
    }
    case "show": {
      const t = getThread(positionals[0] ?? "");
      out(json, t, () => `${t.thread.subject}\n${t.thread.from} → ${t.thread.to} · ${t.thread.status}\n${readLine(t)}\n\n${t.messages.map(describe).join("\n\n")}`);
      return 0;
    }
    case "skill": {
      // The Dak skill, for an agent Dak cannot install it into: paste it into its instructions.
      console.log(values.plain ? INSTRUCTIONS : SKILL);
      return 0;
    }
    case "whoami": {
      const name = whoami();
      out(json, { name, tool: detectTool(), where: process.cwd() }, () => name);
      return 0;
    }
    case "refresh": {
      // Same PR, new head (a rebase, a fixup): the thread's newest PR is re-read in place.
      // Its chapters stay unless --chapters gives new ones; they must still match the diff.
      const id = positionals[0] ?? "";
      const meta = refreshThread(id, values);
      out(json, { thread: id, head_sha: meta.head_sha }, () => `Refreshed ${id} to ${meta.head_sha?.slice(0, 7) ?? "the new diff"}.`);
      return 0;
    }
    case "add": {
      // dak add <thread> codex:reviewer pratik:approver
      const id = positionals.shift() ?? "";
      if (!positionals.length) throw new DakError("usage", "dak add <thread> <name:role>... (roles: author, reviewer, approver, watcher)");
      let list = getThread(id).participants;
      for (const p of positionals) list = addParticipant(id, parseParticipant(p));
      out(json, list, () => list.map((p) => `${p.name} (${p.role})`).join(", "));
      return 0;
    }
    case "group": {
      // dak group set engineers alpha beta gamma | dak group list
      if (positionals[0] === "set" && positionals[1]) {
        const members = setGroup(positionals[1], positionals.slice(2));
        out(json, { group: positionals[1], members }, () => `group:${positionals[1]} is ${members.join(", ") || "empty"}.`);
        return 0;
      }
      const all = groups();
      out(json, all, () => Object.entries(all).map(([g, m]) => `group:${g}  ${m.join(", ")}`).join("\n") || "No groups. Make one with: dak group set <name> <member>...");
      return 0;
    }
    case "ack": {
      // A member saying "seen, done" on a broadcast: an answer that asks nothing back.
      const id = positionals.shift() ?? "";
      if (!values.from) throw new DakError("no_sender", "Say who is acking with --from <name>.");
      addMessage(id, { author: values.from, body: readBody(positionals, values) || "Done.", needs_reply: false });
      out(json, { acked: id }, () => `Acked ${id}.`);
      return 0;
    }
    case "queue": {
      // dak queue | dak queue set <pr> --state testing [--head sha] [--migration f] [--note text] | dak queue remove <pr>
      const [sub, n] = positionals;
      if (sub === "set" && n) {
        const row = setQueue(Number(String(n).replace(/^#/, "")), { state: values.state, title: values.title ?? values.subject, head: values.head, migration: values.migration, note: values.note, thread: values.thread, eta: values.eta, after: values.after });
        out(json, row, () => `#${row.pr} ${row.state}${row.note ? ` (${row.note})` : ""}`);
        return 0;
      }
      if (sub === "remove" && n) { removeQueue(Number(String(n).replace(/^#/, ""))); out(json, { removed: n }, () => `Removed #${n}.`); return 0; }
      const rows = queue({ all: values.all });
      const who = person(loadConfig());
      const reviews = awaitingReview(who);
      out(json, rows, () => queueText(rows, reviews, who));
      return 0;
    }
    case "runner": {
      // dak runner add codex | add review-bot --command '["prog","--flag"]' | list | remove <name>
      const [sub, name] = positionals;
      if (sub === "add" && name) {
        let command: string[] | undefined;
        if (values.command) { try { command = JSON.parse(values.command); } catch { throw new DakError("bad_runner", `--command is a JSON array: '["codex","exec","--sandbox","read-only"]'.`); } }
        const r = addRunner(name, { preset: values.preset, command, timeout_seconds: values.timeout ? parseDuration(values.timeout) / 1000 : undefined });
        out(json, r, () => `${r.name} reviews what is sent to it, with: ${r.command.join(" ")}\nSend a PR: dak send --to ${r.name} --pr <n>, or add it to a thread: dak add <thread> ${r.name}:reviewer`);
        return 0;
      }
      if (sub === "remove" && name) { removeRunner(name); out(json, { removed: name }, () => `Removed ${name}.`); return 0; }
      const list = runners();
      out(json, list, () => list.map((r) => `${r.name.padEnd(14)} ${r.command.join(" ")}`).join("\n") || "No runners. Add one with: dak runner add codex");
      return 0;
    }
    case "reviewing": {
      // The reader saying "I'm on it": the sender hears, and the PR stays waiting on them.
      const id = positionals.shift() ?? "";
      const from = String(values.from ?? person(loadConfig()));
      addMessage(id, { author: from, body: readBody(positionals, values) || "Reviewing this now.", needs_reply: false, extra: { reviewing: true } });
      out(json, { reviewing: id }, () => `Told ${getThread(id).thread.from} you are reviewing ${id}.`);
      return 0;
    }
    case "decisions": {
      const reader = String(values.for ?? person(loadConfig())).toLowerCase();
      const list = decisions(reader);
      out(json, list, () => list.length ? list.map((d) => `${d.decided_at.slice(0, 10)}  ${d.choice}  (${d.subject}, ${d.thread_id})${d.cost ? `  ${describeCost(d.cost)}` : ""}\n    asked by ${d.asked_by}: ${d.question.split("\n")[0].slice(0, 120)}`).join("\n") : "No decisions yet.");
      return 0;
    }
    case "close": {
      setStatus(positionals[0] ?? "", "closed");
      out(json, { closed: positionals[0] }, () => `Closed ${positionals[0]}.`);
      return 0;
    }
    case "chapters": {
      // draft: every hunk already listed (file and new-side start), grouped by folder, so the
      // agent writes only the words. Prints chapters.json; save it, then fill it in.
      if (positionals[0] === "draft") {
        const files = diffForChapters({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff });
        console.log(JSON.stringify(draftChapters(files), null, 2));
        return 0;
      }
      if (positionals[0] !== "check" || !positionals[1]) throw new DakError("usage", "dak chapters draft|check <file> [--pr n | --base ref | --diff f]");
      const chapters = loadChapters(positionals[1]);
      const files = diffForChapters({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff });
      const problems = checkChapters(chapters, files);
      out(json, { ok: !problems.length, problems }, () => problems.length ? problems.join("\n") : `All ${files.reduce((n, f) => n + f.hunks.length, 0)} hunks are in a chapter.`);
      return problems.length ? 1 : 0;
    }
    case "serve": {
      const { serve } = await import("./server");
      const s = serve(values.port ? Number(values.port) : undefined);
      console.log(`Dak is at http://127.0.0.1:${s.port} (store: ${dakHome()})`);
      await new Promise(() => {});
      return 0;
    }
    default:
      throw new DakError("unknown_command", `No command "${cmd}". Run dak help.`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    if (e instanceof DakError) {
      if (process.argv.includes("--json")) console.log(JSON.stringify({ error: { code: e.code, message: e.message } }));
      else console.error(`dak: ${e.message}`);
      process.exit(1);
    }
    if (e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || e?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      console.error(`dak: ${e.message}. Run dak help.`);
      process.exit(1);
    }
    throw e;
  });
}
