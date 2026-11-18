import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dakHome, loadConfig } from "./config";
import { takeUnread } from "./store";
import { asksSomething, brief, sessionName } from "./hook";
import { touch } from "./presence";

// Waking an idle Claude Code session. Claude Code's asyncRewake hooks run in the
// background and wake the session when they exit with code 2, even at an empty prompt.
// Dak's is a small shell script (wake.sh) holding one curl request to this server: it
// costs a sleeping shell, not a process per session in Bun. The server answers when mail
// arrives for that session's agent, and the script hands it to Claude on stderr.
//
// One waiter per session: a newer one (the next Stop) releases the older. Mail is only
// handed to a waiter whose Claude process is still running, so a closed session's
// leftover waiter can never swallow a message meant for the next one.

const waiters = new Map<string, () => void>();
const MAX_WAIT_MS = 12 * 60 * 60 * 1000;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function waitForMail(input: any, pid: number, signal: AbortSignal): Promise<string | null> {
  const { name, where } = sessionName(input, "claude-code");
  const session = String(input.session_id ?? where);
  waiters.get(session)?.();
  let released = false;
  const release = () => { released = true; };
  waiters.set(session, release);
  touch(name, { tool: "claude-code", where, session: input.session_id });
  const deadline = Date.now() + MAX_WAIT_MS;
  try {
    while (!released && !signal.aborted && Date.now() < deadline && (!pid || alive(pid))) {
      // Only mail that asks something wakes a session; updates wait for its next turn.
      if (asksSomething(name)) { const msgs = takeUnread(name); if (msgs.length) return brief(name, msgs); }
      await Bun.sleep(1000);
    }
    return null;
  } finally {
    if (waiters.get(session) === release) waiters.delete(session);
  }
}

// The script the hook runs. Port and token path are written in at connect time.
export function writeWakeScript(): string {
  const path = join(dakHome(), "wake.sh");
  const port = loadConfig().port;
  const tokenPath = join(dakHome(), "token");
  writeFileSync(path, `#!/bin/sh
# Dak: wakes this Claude Code session when Dak mail arrives for it (an asyncRewake hook).
# Exit 2 with the mail on stderr wakes Claude; exit 0 means nothing to say.
input=$(cat)
# The Claude process: our parent, or its parent when the hook ran through a shell.
pid=$PPID
case "$(ps -o comm= -p "$pid" 2>/dev/null)" in *sh) pid=$(ps -o ppid= -p "$pid" | tr -d ' ');; esac
# A one-off run (claude -p, or a turn Dak itself started) ends when its work ends: waiting here
# would hold it open. Only an interactive session waits to be woken.
[ -n "$DAK_WAKE_RUN" ] && exit 0
case " $(ps -o args= -p "$pid" 2>/dev/null) " in *" -p "*|*" --print "*) exit 0 ;; esac
while kill -0 "$pid" 2>/dev/null; do
  out=$(printf '%s' "$input" | curl -s --max-time 43200 -X POST \\
    -H "Authorization: Bearer $(cat '${tokenPath}')" -H "X-Dak-Pid: $pid" -H "content-type: application/json" \\
    --data-binary @- -w '\\n%{http_code}' "http://127.0.0.1:${port}/v1/wake")
  code=$(printf '%s' "$out" | tail -n 1)
  case "$code" in
    200) printf '%s\\n' "$out" | sed '$d' >&2; exit 2 ;;
    204) exit 0 ;;
    *) sleep 20 ;;
  esac
done
exit 0
`);
  chmodSync(path, 0o755);
  return path;
}
