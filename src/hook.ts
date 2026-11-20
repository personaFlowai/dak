import { touch, whoami } from "./presence";
import { loadConfig } from "./config";
import { getThread, getThreadRow, takeUnread } from "./store";
import { approvedSummary, verdictLabel } from "./verdicts";
import type { Message } from "./types";
import { isFor } from "./addressing";
import { countRead } from "./usage";

// Push for Claude Code. Installed as a hook, this runs at the edges of every turn:
//   SessionStart / UserPromptSubmit: new Dak messages are added to the turn's context.
//   Stop: if a message arrived while the agent worked, the stop is blocked with the
//         message as the reason, so the agent reads it and carries on by itself.
// A session waiting at an empty prompt runs no hook of these; wake.ts covers that case for
// Claude Code. Codex and Cursor sessions read their mail on their next turn.
// The hook must never break a session: every failure exits 0 and prints nothing.

// Which agent a session is: DAK_NAME, else the name it has sent as, else the reader whose
// folder it runs in, else a name made from the folder.
export function sessionName(input: any, _tool: string): { name: string; where: string } {
  const where = String(input.cwd ?? input.workspace_roots?.[0] ?? process.cwd());
  // The session id comes only from the hook's own input: a hook never borrows the shell's.
  return { where, name: whoami({ tool: _tool, where, session: input.session_id ?? "" }) };
}

const LISTEN_MS = Number(process.env.DAK_LISTEN_MS || 60 * 60 * 1000);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function agentHook(tool: "claude-code" | "codex" | "cursor" = "claude-code"): Promise<void> {
  let input: any = {};
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return; }
  // Dak's read-only helper (Ask) runs Claude Code, Codex or Cursor too; it is not an agent.
  if (process.env.DAK_HELPER) { if (tool === "cursor") console.log(JSON.stringify({ continue: true })); return; }
  const { name, where } = sessionName(input, tool);
  touch(name, { tool, where, session: input.session_id ?? input.conversation_id });
  const event = input.hook_event_name ?? input.event;
  // Cursor: its prompt hook must always answer, and only its stop hook can carry mail,
  // as a follow-up message the agent then works on. Untested in a live Cursor session.
  if (tool === "cursor") {
    if (event !== "stop") { console.log(JSON.stringify({ continue: true })); return; }
    const mail = asksSomething(name) ? takeUnread(name) : [];
    console.log(JSON.stringify(mail.length ? { followup_message: brief(name, mail) } : {}));
    return;
  }
  // After a tool call, mid-turn: only mail for this agent that needs an answer, with the rest of
  // its topic so far. Everything else waits for the turn's end or the next turn.
  if (event === "PostToolUse") {
    const threads = [...new Set(takeUnread(name, { peek: true }).filter((m) => !m.quiet && isFor(m, name)).map((m) => m.thread_id))];
    if (!threads.length) return;
    const mail = threads.flatMap((id) => takeUnread(name, { threadId: id }));
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `${brief(name, mail)}\n(This arrived during your turn. Answer it when it fits, then carry on.)` } }));
    return;
  }
  // At a stop, only mail that asks something reopens the turn; updates wait for the next turn's
  // start, where they arrive as context. At the start of a turn, everything is handed over.
  const stop = event === "Stop";
  let msgs = !stop || asksSomething(name) ? takeUnread(name) : [];
  // Codex cannot be woken once idle, so with "keep listening" on, its Stop hook waits here
  // for mail (up to an hour, while Codex is still running) and hands it over as a reason to
  // carry on. Typing to the session or pressing Esc ends the wait, as with any running turn.
  if (!msgs.length && tool === "codex" && stop && loadConfig().codex_listen) {
    const until = Date.now() + LISTEN_MS;
    const parent = process.ppid;
    while (!msgs.length && Date.now() < until && alive(parent)) {
      await Bun.sleep(2000);
      if (asksSomething(name)) msgs = takeUnread(name);
    }
  }
  if (!msgs.length) return;
  const text = brief(name, msgs);
  // Both tools name the event hook_event_name; Codex sessions are untested until one runs it.
  if ((input.hook_event_name ?? input.event) === "Stop") {
    console.log(JSON.stringify({ decision: "block", reason: text }));
  } else {
    console.log(text);
  }
}

// Is there unread mail for this agent that is for it and needs an answer (not only updates)?
export const asksSomething = (name: string) => takeUnread(name, { peek: true }).some((m) => !m.quiet && isFor(m, name));

// A message for someone else on the topic, in one line: who, to whom, and how it starts.
function oneLine(m: Message): string {
  const t = getThreadRow(m.thread_id);
  const to = m.mentions?.length ? ` to ${m.mentions.map((n) => "@" + n).join(", ")}` : m.answers ? ` to ${m.answers}` : "";
  // "@helper why only plain?" reads "sam to @helper: why only plain?", not with the name twice.
  const first = (m.body.trim().split("\n").find((l) => l.trim()) ?? (m.choice ? `picked ${m.choice}` : "(no text)")).trim()
    .replace(/^(?:@[\w.-]+[,\s]+(?:and\s+)?)+/, "");
  return `  ${t.id} "${t.subject.length > 40 ? t.subject.slice(0, 39) + "…" : t.subject}" ${m.author}${to}: ${first.length > 100 ? first.slice(0, 99) + "…" : first}`;
}

/* What an agent is handed: its mail grouped by topic, the topic's name and how to answer once
   per topic rather than once per message, then the rest of its topics as a line each. Every
   character here is read by a model, so nothing is said twice. */
export function brief(name: string, all: Message[]): string {
  const msgs = all.filter((m) => isFor(m, name));
  const others = all.filter((m) => !isFor(m, name));
  const lines = msgs.length ? [`Dak mail for you (${name}):`] : [];
  for (const id of [...new Set(msgs.map((m) => m.thread_id))]) {
    const t = getThreadRow(id);
    const here = msgs.filter((m) => m.thread_id === id);
    // Only what asks something gets a reply line: an update is read, not answered.
    const asks = here.some((m) => !m.quiet);
    lines.push("", `${t.id} "${t.subject}"${asks ? ` · answer: dak reply ${t.id} --from ${name} "..."` : ""}`);
    for (const m of here) {
      const v = m.verdict ? ` [${verdictLabel(m)}]` : "";
      const tags = [m.mentions?.includes(name) && "mentions you", m.quiet && "update, no reply needed"].filter(Boolean).join(", ");
      lines.push(`${m.author}${v}${tags ? ` (${tags})` : ""}: ${m.body.trim() || (m.choice ? "" : "(no text)")}`);
      // On a thread carrying several PRs, a verdict covers only the PRs it names: say which stand approved.
      if (m.verdict) { const sum = approvedSummary(getThread(t.id).prs); if (sum) lines.push(`  ${sum}. Merge only those.`); }
      if (m.choice) lines.push(`  Picked: ${m.choice}`);
      if (m.tryit_result) lines.push(m.tryit_result.result === "works"
        ? `  It works: that is the Checking. Post your production proof on ${m.tryit_result.ticket ?? "the ticket"} and move it to Done.`
        : `  Something's wrong: ask what they saw, and keep ${m.tryit_result.ticket ?? "the ticket"} out of Done.`);
      for (const c of m.comments) {
        const at = !c.anchor ? "" : c.anchor.kind === "code" ? `${c.anchor.file}:${c.anchor.start_line}-${c.anchor.end_line}` : `"${c.anchor.quote.slice(0, 80)}"`;
        lines.push(`  - on ${at}: ${c.body}`);
      }
      if (m.attachments.length) lines.push(`  (attached: ${m.attachments.map((a) => `${a.type} ${a.name}`).join(", ")}; dak show ${t.id} --json)`);
    }
  }
  // The rest is the topic going on around this agent: a line each, opened only if it matters.
  if (others.length) {
    if (lines.length) lines.push("");
    lines.push(`${others.length} more on your topics, not for you (dak show <topic> to open one):`, ...others.map(oneLine));
  }
  const text = lines.join("\n");
  countRead(name, text.length);
  return text;
}

export const CLAUDE_HOOK_SETTINGS = (bin: string) => ({
  hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop"].map((event) =>
    [event, [{ hooks: [{ type: "command", command: `${bin} hook claude-code`, timeout: 5 }] }]])),
});
