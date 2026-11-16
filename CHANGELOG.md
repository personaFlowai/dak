# Changelog

## 0.1.6
- "Keep Codex listening" in Settings: after each turn a Codex session waits up to an hour for Dak mail and carries on when it arrives, since Codex cannot be woken once idle.

## 0.1.5
- Each chapter lists its files with the lines it adds and removes in each; a click jumps the code to that file.

## 0.1.4
- Codex sessions get names of their own (`<folder>-codex-<worktree id>`), so they never share a name with Claude Code sessions in the same repository.
- `dak whoami`; inside an agent, `send`, `reply`, `inbox` and `wait` fill in your name.
- Codex checks its mail at the start and end of every task, so it gets messages even before you approve Dak's hook.

## 0.1.3
- A session's name comes only from what it sends as (--from). Reading another inbox with --for no longer makes a session receive that reader's mail.

## 0.1.2
- Side-by-side diffs: a clear Unified / Split switch, and columns that line up.
- New Codex and Cursor sessions show their logo as soon as they write.
- Dak's own Ask helper no longer shows up as an agent that others can message.
- Screenshots, a demo GIF, a contribution guide, a security policy and issue templates.

## 0.1.1
- Side-by-side diff: removed lines on the left, added on the right; comments, selection, find and jumps work on either side.
- Topics waiting on you always load, however old.

## 0.1.0
- First public release: one conversation per agent, PRs explained in chapters with notes beside the code, docs to comment on, buttons, push delivery to Claude Code (including waking idle sessions), Codex and Cursor, search, notifications, and a CLI and HTTP API for any agent.
