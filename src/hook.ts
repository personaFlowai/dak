import { nameFor, touch, claimedName } from "./presence";
import { readerForFolder } from "./config";
import { getThreadRow, takeUnread } from "./store";
import type { Message } from "./types";

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
  const claimed = claimedName(input.session_id);
  return { where, name: (process.env.DAK_NAME || claimed || readerForFolder(where) || nameFor(where)).toLowerCase() };
}

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
    const mail = takeUnread(name);
    console.log(JSON.stringify(mail.length ? { followup_message: brief(name, mail) } : {}));
    return;
  }
  const msgs = takeUnread(name);
  if (!msgs.length) return;
  const text = brief(name, msgs);
  // Both tools name the event hook_event_name; Codex sessions are untested until one runs it.
  if ((input.hook_event_name ?? input.event) === "Stop") {
    console.log(JSON.stringify({ decision: "block", reason: text }));
  } else {
    console.log(text);
  }
}

export function brief(name: string, msgs: Message[]): string {
  const lines = [`New Dak message${msgs.length > 1 ? "s" : ""} for you (${name}):`];
  for (const m of msgs) {
    const t = getThreadRow(m.thread_id);
    const v = m.verdict ? ` [${{ approve: "approved", changes: "changes requested", question: "question" }[m.verdict]}]` : "";
    lines.push("", `Thread ${t.id} "${t.subject}", from ${m.author}${v}:`, m.body.trim() || (m.choice ? "" : "(no text)"));
    if (m.choice) lines.push(`  Picked: ${m.choice}`);
    for (const c of m.comments) {
      const at = !c.anchor ? "" : c.anchor.kind === "code" ? `${c.anchor.file}:${c.anchor.start_line}-${c.anchor.end_line}` : `"${c.anchor.quote.slice(0, 80)}"`;
      lines.push(`  - on ${at}: ${c.body}`);
    }
    for (const a of m.attachments) lines.push(`  (attached ${a.type}: ${a.name}; dak show ${t.id} --json)`);
  }
  const threads = [...new Set(msgs.map((m) => m.thread_id))];
  lines.push("", ...threads.map((id) => `Reply with: dak reply ${id} --from ${name} "<your answer>"`));
  return lines.join("\n");
}

export const CLAUDE_HOOK_SETTINGS = (bin: string) => ({
  hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop"].map((event) =>
    [event, [{ hooks: [{ type: "command", command: `${bin} hook claude-code`, timeout: 5 }] }]])),
});
