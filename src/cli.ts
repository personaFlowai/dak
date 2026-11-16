#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig, writeConfig, configPath, dakHome, person, HELPERS } from "./config";
import {
  addMessage, createThread, getThread, listThreads, putBlob, refreshPr, requireReader, setStatus, takeUnread,
  type NewAttachment,
} from "./store";
import { touch, detectTool, agents, claimName, whoami, inAgent } from "./presence";
import { SKILL, INSTRUCTIONS } from "./skill";
import pkg from "../package.json";
import { agentHook, CLAUDE_HOOK_SETTINGS } from "./hook";
import { snapshotPr, loadChapters, checkChapters, diffForChapters, draftChapters } from "./pr";
import { DakError, type Message, type Verdict } from "./types";

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

// --message-file (or --body-file) takes the text from a file, or from stdin with "-", so a
// "$" or a quote never has to survive a shell. Agents should prefer it for anything long.
// "Read by pratik at 14:02 (all)" or "pratik has not opened it": whether the other side has
// seen the latest message, judged against what they had not written themselves.
function readLine(t: ReturnType<typeof getThread>): string {
  const others = [t.thread.to, t.thread.from];
  return [...new Set(others)].map((who) => {
    const theirs = t.messages.filter((m) => m.author !== who);
    if (!theirs.length) return "";
    const r = t.reads.find((x) => x.reader === who);
    const last = theirs[theirs.length - 1].id;
    if (!r || r.up_to < theirs[0].id) return `${who} has not opened it`;
    const at = r.seen_at ? ` at ${new Date(r.seen_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    return r.up_to >= last ? `${who} read it all${at}` : `${who} read up to message ${r.up_to}${at}, not the latest`;
  }).filter(Boolean).join(" · ");
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
      if (values.pr || values.base || values.diff) {
        const { meta } = snapshotPr({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff, chaptersFile: values.chapters });
        atts.unshift({ type: "pr", name: meta.number ? `PR #${meta.number}` : "Changes", meta });
        kind = "pr";
        subject ??= meta.title ?? undefined;
      }
      if (!subject) {
        const doc = (values.doc ?? [])[0];
        const heading = doc ? readFileSync(doc, "utf8").match(/^#\s+(.+)$/m)?.[1] : undefined;
        subject = heading ?? (values.file ?? [])[0] ?? readBody(positionals, values).split("\n")[0].slice(0, 80);
      }
      const { thread, message } = createThread({ to: values.to, from: values.from, subject: subject ?? "", kind, body: readBody(positionals, values), attachments: atts, options: values.option, ...(values.fyi ? { needs_reply: false } : {}) });
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
      if (values.pr || values.base || values.diff) {
        const { meta } = snapshotPr({ repo: values.repo, pr: values.pr, base: values.base, diffFile: values.diff, chaptersFile: values.chapters });
        atts.unshift({ type: "pr", name: meta.number ? `PR #${meta.number}` : "Changes", meta });
      }
      const body = readBody(positionals, values);
      // --done: the work is finished (merged, shipped). The note is an update, and the topic
      // leaves the reader's conversation; anything later that asks something brings it back.
      const m = body.trim() || !values.done
        ? addMessage(id, { author: values.from, body, verdict: verdict ?? null, attachments: atts, options: values.option, choice: values.choice, ...(values.fyi || values.done ? { needs_reply: false } : {}) })
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
      const { meta } = refreshPr(id, (old) => {
        const pr = values.pr ?? (values.base || values.diff ? undefined : old.number ? String(old.number) : undefined);
        const baseRef = values.base ?? (pr || values.diff ? undefined : old.base_ref);
        if (!pr && !baseRef && !values.diff) throw new DakError("usage", "That diff came from a file: pass --diff <file> (or --base <ref>).");
        const { meta: fresh, files } = snapshotPr({ repo: values.repo ?? old.repo ?? ".", pr, base: baseRef, diffFile: values.diff, chaptersFile: values.chapters });
        if (values.chapters) return fresh;
        const problems = old.chapters.length ? checkChapters(old.chapters, files) : [];
        if (problems.length) throw new DakError("bad_chapters", "The old chapters no longer match the new head; pass --chapters:\n  " + problems.join("\n  "));
        return { ...fresh, chapters: old.chapters, ...(old.prologue ? { prologue: old.prologue } : {}) };
      });
      out(json, { thread: id, head_sha: meta.head_sha }, () => `Refreshed ${id} to ${meta.head_sha?.slice(0, 7) ?? "the new diff"}.`);
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
