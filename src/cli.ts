#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig, writeConfig, configPath, dakHome, person, HELPERS } from "./config";
import {
  addMessage, setReviewing, createThread, getThread, threadForPr, listThreads, putBlob, refreshPr, requireReader, setStatus, takeUnread,
  addParticipant, decisions, groups, setGroup, awaitingReview, routes, setRoute,
  type NewAttachment,
} from "./store";
import { touch, detectTool, agents, claimName, whoami, inAgent } from "./presence";
import { SKILL, INSTRUCTIONS } from "./skill";
import pkg from "../package.json";
import { agentHook, CLAUDE_HOOK_SETTINGS } from "./hook";
import { snapshotPr, loadChapters, checkChapters, bigChapters, diffForChapters, draftChapters } from "./pr";
import { DakError, type Message, type Verdict } from "./types";
import { approvedSummary, verdictLabel } from "./verdicts";
import { setMember, team } from "./team";
import { addTask, assign, assignMany, board, next as nextTask, pileOf, setTaskStatus, unstart, type Card } from "./board";
import { buildCost, buildHandoff, describeCost, describeHandoff, parseParticipant } from "./handoff";
import { addRunner, removeRunner, runners, setRange } from "./reviewer";
import { checkHead, inQueue, next, queue, removeQueue, setQueue, type QueueRow } from "./queue";
import { confirmedBy, setHold, describeReview, orderQueue, orderReviews, pairQueue, prioritizeQueue, prioritizeReview, reviewsInOrder, tierOf, type OrderedReview } from "./priority";
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
                    [--on 2450]...                         the PRs the verdict is about; required to approve
                                                           when the thread carries more than one PR
                    [--pr n | --base ref] [--chapters f]   a new version of the PR, on the same thread
                    [--option text]... [--choice text]     buttons to answer with; the button picked
                    [--done]                               the work is finished: the topic leaves the reader's list
                    [--fyi]                                an update that needs no answer (after an approval, text-only replies are updates anyway)
  dak show <thread>                              the whole thread
  dak pile [--for name]                          your tickets on the Board, in order
  dak next                                       take the top of your pile (marks it started)
  dak status <ticket> "what you're doing" [--blocked "on what"]   your one line on a ticket (makes it your Now)
  dak status <ticket> --stop                     back to Up next: not Now, not started
  dak assign <ticket> <agent|none> [--before <ticket>] [--quiet]  put a ticket in an agent's pile
  dak assign --file plan.txt [--quiet]           many at once: "<ticket> <agent>" per line, in pile order;
                                                 each agent gets one message listing its tickets
  dak board [--for agent] [--json]               every open ticket and where it stands
  dak task add "title"                           a ticket that is not in Linear
  dak team [--json]                              everyone on the team: @name, role, area, what they can and cannot do
                                                 (@name in any message brings them onto that topic)
  dak thread --pr <n>                            the thread carrying PR #n (prints its id)
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
      --type tryit [--ticket REVA-123]   a "try it" on a live feature: buttons Works / Something's wrong; on Works
                                the reply says to post the proof on the ticket and move it to Done
      --allow-big "why"         send chapters over 6 files or 12 hunks anyway; the reason shows on each big chapter
      --range base..head        (also on dak add) a reviewer runner reviews only these commits: a stacked PR's own
  dak add <thread> <name:role>...                bring someone onto a thread; they get it all as new mail
  dak group set <name> <member>... | dak group   send to all of them with --to group:<name>
  dak route set <reader> --from-group <group> --via <reader>
                                                 PRs and briefs a group sends to <reader> go to --via first (replies are not routed)
  dak route | dak route remove <reader> --from-group <group>
  dak ack <thread> --from <name> [text]          a member's "done" on a broadcast
  dak decisions [--for <name>]                   every button picked, with the question and its cost
  dak runner add codex | cursor | claude | <name> --command '["prog","arg"]'
                                                 a reader that is a command: PRs sent to it get reviewed headless
  dak runner list | dak runner remove <name>
  dak queue [--all] | dak queue set <pr> --state <s> [--head sha] [--migration f] [--note text] [--title t]
                                                 the merge queue; states: approved testing building merging merged migrated deployed failed held
                                                 --eta 4m: how long this step should take; --after 2413: waits for that PR first
  dak reviewing <thread> [text] [--on 2450] [--stop]  tell the sender you are reviewing it (the person's "I'm on it"),
                                                 one PR with --on, or that you stopped for now with --stop
  dak queue remove <pr>
  dak queue set <pr> --tier urgent|normal|later --why "unblocks 8 PRs" --waiting "a rebase"
  dak queue set <pr|thread> --rework "prefix being added"   about to change: greyed, below the rest, skipped by
                                                 queue next; back by itself with the next version (--rework none ends it)
  dak queue set <pr|thread> --state parked --waiting "department settings"
                                                 open but parked by the person's choice: out of the review count
  dak queue unpark <pr|thread>
  dak queue order <pr>... [--tier t]             merge order; refused if it puts a PR before the one it waits for
  dak queue review-order <pr|thread>... [--tier t]   the order the person reviews in
  dak queue priority <pr|thread> [--review] --tier t --why text
  dak queue pair <pr> <pr> | unpair <pr>         two PRs tested and merged together
  dak queue next [--json]                        the next ready PR or pair (exit 3 when none): what a merge loop takes
  dak send ... --hotfix                          the PR goes to the top of the review list as urgent
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
    const on = [...t.messages].reverse().find((m) => m.author === w && (m.reviewing !== undefined || m.verdict));
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
    const { meta: fresh, files } = snapshotPr({ repo: values.repo ?? old.repo ?? ".", pr, base: baseRef, diffFile: values.diff, chaptersFile: values.chapters, allowBig: values["allow-big"] });
    if (values.chapters) return fresh;
    const problems = old.chapters.length ? checkChapters(old.chapters, files) : [];
    if (problems.length) throw new DakError("bad_chapters", "The old chapters no longer match the new head; pass --chapters:\n  " + problems.join("\n  "));
    return { ...fresh, chapters: old.chapters, ...(old.prologue ? { prologue: old.prologue } : {}) };
  }).meta;
}

// The queue as Atlas reads it in a terminal: what waits on the person, what is moving, what waits.
function queueText(rows: QueueRow[], reviews: OrderedReview[], who: string): string {
  const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const left = (r: QueueRow) => { if (!r.eta_at) return ""; const m = Math.round((Date.parse(r.eta_at) - Date.now()) / 60000); return m >= 0 ? `, about ${m} min left` : `, ${-m} min over`; };
  const line = (r: QueueRow) => `  #${String(r.pr).padEnd(6)} ${r.title}  [${r.state} for ${ago(r.state_since)}${left(r)}]${r.tier !== "normal" ? ` ${r.tier}` : ""}${r.why ? ` (${r.why})` : ""}${r.pair_id ? ` pair ${r.pair_id}` : ""}${r.waiting_reason ? `  ${r.waiting_reason}` : ""}${r.approval ? "" : ` (no approval from ${who} on the thread)`}${r.note ? `  ${r.note}` : ""}`;
  const live = rows.filter((r) => !r.hold);
  const moving = live.filter((r) => ["testing", "building", "merging", "merged", "migrated"].includes(r.state));
  const waiting = live.filter((r) => ["approved", "held", "failed"].includes(r.state));
  const done = live.filter((r) => r.state === "deployed");
  const heldRows = rows.filter((r) => r.hold);
  const open = reviews.filter((r) => !r.hold), heldReviews = reviews.filter((r) => r.hold);
  const holdLine = (h: NonNullable<QueueRow["hold"]>) => `${h.kind === "rework" ? "being reworked" : "parked"}${h.note ? `: ${h.note}` : ""}`;
  return [
    `Waiting on ${who} (${open.length})`, ...open.map((r) => `  ${r.pr ? `#${r.pr}`.padEnd(7) : "".padEnd(7)} ${r.subject}  {${r.type}}${r.tier !== "normal" ? `  ${r.tier.toUpperCase()}` : ""}${r.why ? ` (${r.why})` : ""}${r.blocks ? `  blocks: ${r.blocks}` : ""}  [from ${r.from}, ${r.reviewing_since ? `reviewing for ${ago(r.reviewing_since)}` : `waiting ${ago(r.waiting_since)}`}]`),
    ...(heldReviews.length ? ["", `Not to review now (${heldReviews.length})`, ...heldReviews.map((r) => `  ${r.pr ? `#${r.pr}`.padEnd(7) : "".padEnd(7)} ${r.subject}  [${holdLine(r.hold!)}]`)] : []),
    "", `In progress (${moving.length})`, ...moving.map(line),
    "", `Approved, waiting (${waiting.length})`, ...waiting.map(line),
    ...(heldRows.length ? ["", `Parked or being reworked (${heldRows.length})`, ...heldRows.map((r) => `${line(r)}  [${holdLine(r.hold!)}]`)] : []),
    ...(done.length ? ["", `Deployed today (${done.length})`, ...done.map(line)] : []),
  ].join("\n");
}

// SQLite refusing a write: the store is read-only to this run (Codex's read-only sandbox).
const readOnly = (e: any) => /readonly|read-only|SQLITE_CANTOPEN|unable to open|EPERM|operation not permitted/i.test(String(e?.code ?? "") + " " + String(e?.message ?? e));

function inboxCmd(values: any, json: boolean) {
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
}

// --confirmed-by <thread>: act as the person, because they asked for it there. The output quotes
// what they said, so anyone reading the agent's log sees what the order rests on.
function asPerson(values: any, by: string): { as: string; said: string | null } {
  if (!values["confirmed-by"]) return { as: by, said: null };
  const c = confirmedBy(values["confirmed-by"], by);
  const p = person(loadConfig());
  return { as: p, said: c.quoted ? `Applied as ${p}'s, who wrote on ${values["confirmed-by"]}: "${c.choice}"` : `Applied as ${p}'s, who picked "${c.choice}" on ${values["confirmed-by"]}.` };
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

// --on 2450 --on "#2451", or --on 2450,2451: the PRs a verdict is about.
function prNumbers(list?: string[]): number[] | undefined {
  const ns = (list ?? []).flatMap((x) => x.split(",")).map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
  const bad = ns.find((x) => !/^\d+$/.test(x));
  if (bad) throw new DakError("bad_pr", `--on takes PR numbers: "${bad}" is not one.`);
  return ns.length ? ns.map(Number) : undefined;
}

function describe(m: Message): string {
  const v = m.verdict ? ` [${verdictLabel(m)}]` : "";
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
  link: { type: "string", multiple: true }, verdict: { type: "string" }, on: { type: "string", multiple: true },
  blocked: { type: "string" }, before: { type: "string" }, quiet: { type: "boolean" },
  display: { type: "string" }, role: { type: "string" }, area: { type: "string" }, can: { type: "string" }, cannot: { type: "string" }, timeout: { type: "string" },
  "body-file": { type: "string" }, "message-file": { type: "string" }, readers: { type: "string" }, port: { type: "string" },
  unread: { type: "boolean" }, peek: { type: "boolean" }, json: { type: "boolean" }, person: { type: "boolean" },
  force: { type: "boolean" }, stop: { type: "boolean" }, fyi: { type: "boolean" }, plain: { type: "boolean" }, done: { type: "boolean" }, option: { type: "string", multiple: true }, choice: { type: "string" }, help: { type: "boolean", short: "h" },
  cc: { type: "string", multiple: true }, ready: { type: "boolean" }, head: { type: "string" }, migration: { type: "string" },
  proof: { type: "string", multiple: true }, skipped: { type: "string", multiple: true }, cost: { type: "string" }, cap: { type: "string" },
  "head-only": { type: "boolean" }, as: { type: "string" }, command: { type: "string" }, preset: { type: "string" },
  eta: { type: "string" }, after: { type: "string" }, tier: { type: "string" }, why: { type: "string" }, waiting: { type: "string" },
  review: { type: "boolean" }, hotfix: { type: "boolean" }, "confirmed-by": { type: "string" }, type: { type: "string" }, blocks: { type: "string" },
  rework: { type: "string" }, "from-group": { type: "string" }, via: { type: "string" }, range: { type: "string" }, ticket: { type: "string" }, "allow-big": { type: "string" }, state: { type: "string" }, note: { type: "string" }, thread: { type: "string" }, title: { type: "string" }, all: { type: "boolean" },
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
        const { meta } = snapshotPr({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff, chaptersFile: values.chapters, allowBig: values["allow-big"] });
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
      const extra: any = { handoff: values.ready ? buildHandoff(prMeta, values) : undefined, cost: buildCost(values) };
      // A "try it": the person tries the live feature and answers with one tap. The first button
      // means it works; on that, the agent posts its proof on the ticket and moves it to Done.
      if (values.type === "tryit") {
        extra.tryit = values.ticket ? { ticket: values.ticket } : {};
        values.option ??= [values.ticket ? `Works: move ${values.ticket} to Done` : "Works", "Something's wrong"];
      }
      const { thread, message, routed } = createThread({ to: values.to, from: values.from, subject: subject ?? "", kind, body: readBody(positionals, values), attachments: atts, options: values.option,
        participants: (values.cc ?? []).map(parseParticipant), extra, ...(values.fyi ? { needs_reply: false } : {}) });
      if (values.range) setRange(thread.id, values.range);
      // A hotfix goes to the top of the reader's review list.
      if (values.hotfix) prioritizeReview(thread.id, values.from, { tier: "urgent", why: values.why ?? "Hotfix" });
      describeReview(thread.id, { type: values.type, blocks: values.blocks });
      out(json, { thread_id: thread.id, thread, message, ...(routed ? { routed } : {}) }, () => `${routed ? `Routed: ${routed.to} has ${routed.from_group}'s PRs and briefs go to ${routed.via} first.\n` : ""}Sent ${thread.id} to ${thread.to}: ${thread.subject}\nWait for the reply with: dak wait ${thread.id} --for ${thread.from}`);
      return 0;
    }
    case "inbox": {
      // A reviewer run inside a read-only sandbox (codex exec) cannot write the store, and has no
      // mailbox anyway: skip the check quietly instead of logging SQLITE_READONLY on every run.
      if (process.env.DAK_HELPER) { out(json, [], () => "Nothing new."); return 0; }
      try { inboxCmd(values, json); } catch (e) {
        if (!readOnly(e)) throw e;
        out(json, [], () => "Nothing new here: this run cannot write Dak's store (a read-only sandbox), so the inbox is not checked.");
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
        const { meta } = snapshotPr({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff, chaptersFile: values.chapters, allowBig: values["allow-big"] });
        atts.unshift({ type: "pr", name: meta.number ? `PR #${meta.number}` : "Changes", meta });
        prMeta = meta;
      }
      if (values.ready && !prMeta) prMeta = messages.flatMap((m) => m.attachments).filter((a) => a.type === "pr").pop()?.meta ?? null;
      const extra = { handoff: values.ready ? buildHandoff(prMeta, values) : undefined, cost: buildCost(values) };
      for (const c of values.cc ?? []) addParticipant(id, parseParticipant(c));
      if (values.range) setRange(id, ["none", ""].includes(values.range) ? null : values.range);
      describeReview(id, { type: values.type, blocks: values.blocks });
      const body = readBody(positionals, values);
      if (values["head-only"] && !body.trim() && !values.ready) { out(json, { thread: id, head_sha: prMeta.head_sha }, () => `Moved ${id} to ${prMeta.head_sha?.slice(0, 7)}.`); return 0; }
      // --done: the work is finished (merged, shipped). The note is an update, and the topic
      // leaves the reader's conversation; anything later that asks something brings it back.
      const m = body.trim() || !values.done
        ? addMessage(id, { author: values.from, body, verdict: verdict ?? null, prs: prNumbers(values.on), attachments: atts, options: values.option, choice: values.choice, extra,
            ...(values.fyi || values.done || (values["head-only"] && !values.ready) ? { needs_reply: false } : {}) })
        : null;
      if (values.done) setStatus(id, "closed");
      out(json, m ?? { done: id }, () => values.done ? `Marked ${id} done.` : `Replied on ${id}.`);
      return 0;
    }
    // The Board from the command line: your pile, the next ticket, a status line, assigning.
    case "pile": case "next": case "status": case "assign": case "board": case "task": {
      const who = values.for ?? values.from ?? whoami({ tool: detectTool(), where: process.cwd() });
      const line = (c: Card) => `${c.now ? "NOW " : "    "}${c.id.padEnd(11)} ${c.stage.padEnd(9)} ${c.title}${c.stage_note ? `  (${c.stage_note})` : ""}${c.agent && cmd === "board" ? `  @${c.agent}` : ""}`;
      if (cmd === "pile") { const p = pileOf(who); out(json, p, () => p.length ? p.map((c, i) => `${String(i + 1).padStart(2)}. ${line(c)}`).join("\n") : `Nothing in ${who}'s pile.`); return 0; }
      if (cmd === "next") {
        const c = nextTask(who);
        out(json, c, () => c ? `Next for ${who}: ${c.id} ${c.title}${c.url ? `\n${c.url}` : ""}\nSay where you are with: dak status ${c.id} "what you're doing"` : `Nothing waiting in ${who}'s pile.`);
        return 0;
      }
      if (cmd === "status") {
        const [id, ...rest] = positionals;
        if (!id) throw new DakError("no_task", 'Which ticket? dak status REVA-3041 "fixing Cursor round 2" [--blocked "..."] [--stop]');
        if (values.stop) { const c = unstart(id, who); out(json, c, () => `${c.id} is back in Up next: not Now, not started, no line or block.`); return 0; }
        const c = setTaskStatus(id, who, rest.join(" ") || readBody([], values), values.blocked);
        out(json, c, () => `${c.id}: ${c.stage}${c.stage_note ? ` (${c.stage_note})` : ""}`);
        return 0;
      }
      if (cmd === "assign") {
        // Who assigned it: --from, else this session's own name (so Atlas's assignments say Atlas).
        const by = values.from ?? whoami({ tool: detectTool(), where: process.cwd() });
        if (values.file) {
          // One "<ticket> <agent>" per line, in pile order; # starts a comment.
          const lines = readFileSync(values.file[0], "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => {
            const [task, agent] = l.split(/\s+/);
            return { task, agent: !agent || agent === "none" ? null : agent.toLowerCase() };
          });
          const r = assignMany(lines, by, { quiet: !!values.quiet });
          out(json, r, () => `Assigned ${r.assigned} ticket${r.assigned === 1 ? "" : "s"}: ${Object.entries(r.agents).map(([a, n]) => `${a} ${n}`).join(", ") || "no pile changed"}.${values.quiet ? " Nobody was told." : " Each agent got one message listing its tickets."}`);
          return 0;
        }
        const [id, agent] = positionals;
        if (!id) throw new DakError("no_task", "dak assign <ticket> <agent> [--before <ticket>] [--quiet]   (agent 'none' puts it back in the backlog)\n       dak assign --file plan.txt [--quiet]   one '<ticket> <agent>' per line, in pile order");
        const c = assign(id, !agent || agent === "none" ? null : agent, { before: values.before, by, quiet: !!values.quiet });
        out(json, c, () => c.agent ? `${c.id} is in ${c.agent}'s pile.` : `${c.id} is back in the backlog.`);
        return 0;
      }
      if (cmd === "task") {
        if (positionals[0] !== "add") throw new DakError("usage", 'dak task add "title"   a ticket that is not in Linear');
        const t = addTask(positionals.slice(1).join(" "));
        out(json, t, () => `Added ${t.id}.`);
        return 0;
      }
      const b = board();
      const shown = values.for ? b.cards.filter((c) => c.agent === values.for) : b.cards;
      out(json, { ...b, cards: shown }, () => shown.map(line).join("\n") || "The Board is empty. Set the Linear key on the Board page.");
      return 0;
    }
    case "team": {
      // dak team                       everyone who works through Dak, with name, role and area
      // dak team set <name> --display "Atlas" --role CTO --area "..." --can "..." --cannot "..."
      if (positionals[0] === "set") {
        const name = positionals[1];
        if (!name) throw new DakError("no_member", "Whose card? dak team set <name> --role ...");
        const m = setMember(name, { display: values.display, role: values.role, area: values.area, can: values.can, cannot: values.cannot });
        out(json, m, () => `Updated ${m.name}.`);
        return 0;
      }
      const list = team({ all: values.all });
      out(json, list, () => list.map((m) => `${m.listening ? "●" : " "} @${m.name.padEnd(36)} ${(m.kind).padEnd(7)} ${[m.display, m.role, m.area].filter(Boolean).join(" · ")}${m.cannot ? `  (cannot: ${m.cannot})` : ""}`).join("\n"));
      return 0;
    }
    case "agents": {
      const list = agents({ scan: true, all: values.all });
      out(json, list, () => list.map((a) => `${a.listening ? "●" : a.running ? "○" : " "} ${a.name.padEnd(42)} ${(a.reader ? (a.kind === "person" ? "person" : "reader") : a.tool ?? "").padEnd(12)} ${a.title ? `"${a.title}"  ` : ""}${a.where ?? ""}`).join("\n")
        + "\n\n● listening (used Dak in the last 10 minutes)   ○ running, not listening yet" + (values.all ? "" : "\nReviewer workspaces in temporary folders are hidden; --all shows them."));
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
    case "thread": {
      // dak thread --pr 2426: the Dak thread carrying that PR (the newest, if it was sent twice).
      const n = Number(String(values.pr ?? positionals[0] ?? "").replace(/^#/, ""));
      if (!Number.isInteger(n) || n <= 0) throw new DakError("usage", "dak thread --pr <number>");
      const id = threadForPr(n);
      if (!id) throw new DakError("no_thread", `No Dak thread carries PR #${n}.`, 404);
      const t = getThread(id).thread;
      out(json, { thread_id: id, subject: t.subject, from: t.from, to: t.to, status: t.status }, () => id);
      return 0;
    }
    case "show": {
      const t = getThread(positionals[0] ?? "");
      out(json, t, () => `${t.thread.subject}\n${t.thread.from} → ${t.thread.to} · ${t.thread.status}\n${readLine(t)}${approvedSummary(t.prs) ? `\n${approvedSummary(t.prs)}` : ""}\n\n${t.messages.map(describe).join("\n\n")}`);
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
      if (values.range) setRange(id, ["none", ""].includes(values.range) ? null : values.range);
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
    case "route": {
      // dak route set pratik --from-group engineers --via atlas | dak route remove pratik --from-group engineers | dak route
      const [sub, to] = positionals;
      if ((sub === "set" || sub === "remove") && to) {
        if (!values["from-group"]) throw new DakError("usage", "dak route set <reader> --from-group <group> --via <reader>");
        if (sub === "set" && !values.via) throw new DakError("usage", "Say who it goes to instead with --via <reader>.");
        setRoute(to, values["from-group"], sub === "set" ? values.via : null);
      }
      const list = routes();
      out(json, list, () => list.map((r) => `${r.to_reader}: PRs and briefs from group:${r.from_group} go to ${r.via} first`).join("\n") || "No routes. Add one with: dak route set <reader> --from-group <group> --via <reader>");
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
      const num = (x: string) => Number(String(x).replace(/^#/, ""));
      // Who is ordering: an agent's order never moves rows the person placed by hand.
      const by = String(values.from ?? (inAgent() ? whoami() : person(loadConfig()))).toLowerCase();
      if (sub === "set" && n) {
        // --rework and a review-only park put a hold on the PR's thread and leave the merge queue
        // alone: a PR still waiting for review must not appear there as approved.
        const row0 = /^t_/.test(n) ? null : inQueue(num(n));
        const notes: string[] = [];
        if (values.rework !== undefined) {
          const off = ["", "none", "done"].includes(String(values.rework).trim());
          const id = setHold(row0?.thread_id ?? n, off ? null : "rework", off ? null : String(values.rework).trim(), by);
          notes.push(off ? `${id}: no longer being reworked.` : `${id}: being reworked, skip it. It comes back with its next version (dak reply --pr).`);
        }
        const parkNote = values.waiting ?? values.why ?? values.note ?? null;
        if (values.state === "parked") {
          const id = row0?.thread_id ?? (row0 ? null : setHold(n, "parked", parkNote, by));
          if (row0?.thread_id) setHold(row0.thread_id, "parked", parkNote, by);
          if (!row0) { out(json, { parked: id, note: parkNote }, () => [...notes, `${id}: parked${parkNote ? ` (${parkNote})` : ""}. It stays out of the review count until dak queue unpark ${n}.`].join("\n")); return 0; }
        } else if (values.state && row0?.state === "parked" && row0.thread_id) setHold(row0.thread_id, null, null, by);
        const queueFields = ["state", "title", "subject", "head", "migration", "note", "thread", "eta", "after", "tier", "why", "waiting"].some((k) => values[k] !== undefined);
        if (!queueFields || /^t_/.test(n)) { out(json, { holds: notes }, () => notes.join("\n") || "Nothing to change."); return 0; }
        const row = setQueue(num(n), { state: values.state, title: values.title ?? values.subject, head: values.head, migration: values.migration, note: values.note,
          thread: values.thread, eta: values.eta, after: values.after, tier: values.tier, why: values.why, waiting: values.waiting, by });
        if (values.head) { checkHead(num(n), values.head, (cmd, cwd) => { const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" }); return p.exitCode === 0 ? p.stdout.toString() : null; }); }
        const fresh = values.head ? queue({ all: true }).find((r) => r.pr === row.pr) ?? row : row;
        const moved = fresh.head_moved ? `\nHead moved since ${person(loadConfig())}'s approval (${fresh.head_moved.from.slice(0, 7)} → ${fresh.head_moved.to.slice(0, 7)}): ${fresh.head_moved.change ?? "git could not tell whether the changes differ"}.` : "";
        out(json, fresh, () => `#${row.pr} ${row.state}${row.note ? ` (${row.note})` : ""}${moved}`);
        return 0;
      }
      if (sub === "unpark" && n) {
        const row0 = /^t_/.test(n) ? null : inQueue(num(n));
        const id = row0?.thread_id ?? (row0 ? null : setHold(n, null, null, by));
        if (row0?.thread_id) setHold(row0.thread_id, null, null, by);
        if (row0?.state === "parked") setQueue(num(n), { state: "approved", by });
        out(json, { unparked: n }, () => `${id ?? `#${n}`} is back${row0?.state === "parked" ? " in the queue, approved" : " in the review list"}.`);
        return 0;
      }
      if (sub === "remove" && n) { removeQueue(num(n)); out(json, { removed: n }, () => `Removed #${n}.`); return 0; }
      if (sub === "order" || sub === "review-order") {
        const refs = positionals.slice(1);
        if (!refs.length) throw new DakError("usage", `dak queue ${sub} <pr> <pr>... [--tier urgent|normal|later] [--confirmed-by <thread>]`);
        // --confirmed-by: the person asked for this order on that thread (a button, or in words); it is applied as theirs.
        const { as, said } = asPerson(values, by);
        const r = sub === "order" ? orderQueue(refs.map(num), as, { tier: tierOf(values.tier) }) : orderReviews(refs, as, { tier: tierOf(values.tier) });
        out(json, { ...r, ...(said ? { confirmed_by: said } : {}) }, () => `Ordered ${r.ordered.length}.${r.kept.length ? ` Kept ${person(loadConfig())}'s order for ${r.kept.join(", ")}.` : ""}${said ? `\n${said}` : ""}`);
        return 0;
      }
      if (sub === "priority" && n) {
        // One row's tier and reason: --review for the review list, else the merge queue.
        const v = { tier: tierOf(values.tier), why: values.why };
        const { as, said } = asPerson(values, by);
        // Without --review, a PR not in the merge queue yet is a review: set its priority there.
        const review = values.review || /^t_/.test(n) || !inQueue(num(n));
        if (review) { if (v.tier || v.why) prioritizeReview(n, as, v); describeReview(n, { type: values.type, blocks: values.blocks }); }
        else prioritizeQueue(num(n), as, v);
        out(json, { [review ? "review" : "pr"]: n, ...v, ...(said ? { confirmed_by: said } : {}) }, () => `${n}: ${v.tier ?? "tier unchanged"}${v.why ? `, ${v.why}` : ""}${review && !values.review ? " (in the review list)" : ""}.${said ? `\n${said}` : ""}`);
        return 0;
      }
      if (sub === "pair" && n && positionals[2]) { pairQueue(num(n), num(positionals[2])); out(json, { paired: [num(n), num(positionals[2])] }, () => `Paired #${n} and #${positionals[2]}.`); return 0; }
      if (sub === "unpair" && n) { pairQueue(num(n), null); out(json, { unpaired: num(n) }, () => `Unpaired #${n}.`); return 0; }
      if (sub === "next") {
        // The merge loop asks Dak what to take: exit 0 with the PR (or pair), 3 when nothing is ready.
        const rows = next();
        out(json, { next: rows }, () => rows ? rows.map((r) => `#${r.pr} ${r.title}`).join("\n") : "Nothing is ready to merge.");
        return rows ? 0 : 3;
      }
      const rows = queue({ all: values.all });
      const who = person(loadConfig());
      const reviews = reviewsInOrder(who);
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
      setReviewing(id, from, { prs: prNumbers(values.on), stop: !!values.stop, body: readBody(positionals, values) });
      out(json, { reviewing: id, stopped: !!values.stop }, () => `Told ${getThread(id).thread.from} you ${values.stop ? "stopped reviewing" : "are reviewing"} ${id}.`);
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
      const problems = [...checkChapters(chapters, files), ...bigChapters(chapters, values["allow-big"])];
      out(json, { ok: !problems.length, problems }, () => problems.length ? problems.join("\n") : `All ${files.reduce((n, f) => n + f.hunks.length, 0)} hunks are in a chapter, and every chapter is small enough to read.`);
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
    // The inbox check in a read-only sandbox can fail before the command runs (naming the session
    // reads the store too): say so quietly and exit 0, so a reviewer run logs nothing alarming.
    if (process.argv[2] === "inbox" && readOnly(e)) { console.log(process.argv.includes("--json") ? "[]" : "Nothing new here: this run cannot write Dak's store (a read-only sandbox)."); process.exit(0); }
    if (e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || e?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      console.error(`dak: ${e.message}. Run dak help.`);
      process.exit(1);
    }
    throw e;
  });
}
