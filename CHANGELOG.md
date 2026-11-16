# Changelog

## 0.3.1
- Remote agents can read their own instructions at /x/skill, so they refresh them after Dak changes.

## 0.3.0
- Back and forward: every place you go is a history entry; ‹ › in the toolbar, ⌘[ ⌘], and the browser's back all walk it.
- On the phone's home screen Dak has its own icon and name, runs full-screen, and keeps inside the iPhone's safe areas.
- Remote agents (Grok) can write to any agent by name (`"to"` on /x/send; who is listed at /x/agents), and are told to check their inbox at every task.
- The remote agents' door now survives Dak updates and restarts, like the phone link.
- Grok has its logo.

## 0.2.9
- Phone PR view, like a PR app: tabs for Overview, Guide (every chapter in one scroll, each with its files and a Reviewed box per file) and Diff. A file opens as a sheet over the page; closing it leaves you where you were.
- New message lists who you have talked to in the last two weeks, newest first, instead of a fixed list; anyone else by name.
- Settings no longer runs child processes while a page loads (Bun 1.1.42 crashed in spawnSync there).

## 0.2.8
- New message, rebuilt: pick who (your agents first; any other session when you type its name), then write. For an agent you already talk to it opens their conversation as a new topic. No subject box: the first line is the subject. Files and links attach from the reply box; pulling in a GitHub PR is a link at the foot of the picker.
- Phone: a file opens on a page of its own, with its diff, Reviewed and Next file at the bottom.
- "I'm reviewing" shows on any thread waiting on you that carries a PR or a doc, however it began.
- You always show as yourself, never with the logo of a session that sent as you.

## 0.2.7
- "Waiting on you" is its own page at the top of the sidebar (PRs, briefs, decisions, filter by type); the merge queue holds only approved PRs on their way out.
- Phone: files in a chapter start folded ("Show changes"), smaller type, and the toolbar keeps "I'm reviewing" and Approve.
- The Mac app restarts Dak's server if it ever exits, and logs why in ~/.dak/server.log.

## 0.2.6
- "Waiting on you" holds PRs, briefs and decisions in one order, with chips to filter by type. Updates and approved PRs that only wait to merge stay out; a question asked after an approval counts as a decision.
- `--type pr|brief|decision` and `--blocks "Rohan, #2433"` on sends and replies; each brief or decision shows what its answer releases.
- Fixed: a button question asked after an approval was marked answered on its own and dropped out of what waits on you.
- Fixed: setting a review priority before anything was in the merge queue failed.

## 0.2.5
- Dak on your phone. Settings → Your phone opens a private link through a Cloudflare quick tunnel (no account) and shows a code to scan. Only a phone holding that key gets in; it cannot change the Mac's setup; "Sign out phone" replaces the key. The tunnel runs apart from Dak, so the phone's saved address survives Dak updates.
- A phone layout: the list (merge queue first, then agents) and what you open from it, with a back button. PRs open full-screen with the reply bar at the bottom; a chapter reads as notes then code, single-column diff.

## 0.2.4
- Waking closed sessions: the Claude desktop app closes an idle session's process, and then no hook can wake it. When mail waits for a closed Claude Code session, Dak now runs one turn on it in the background (`claude -p --resume`) with the mail, and posts a Mac notification saying so. Settings → Claude Code → "Wake closed sessions" (on by default).
- Dak's wake hook no longer holds a one-off `claude -p` run open waiting for mail.

## 0.2.3
- Priorities in the merge queue: urgent, normal and later, with an order inside each, and a reason per row. Agents set them (`dak queue order`, `review-order`, `priority`, `--hotfix`); you drag rows or change a row's tier, and your order wins.
- `dak queue next`: the next ready PR or pair, for a merge loop.
- Pairs tested together show as one row. Each waiting row says what it waits on, in plain words.
- An HTML, PDF or text file opens beside the conversation with a close button; an HTML page runs sandboxed. Before, it took over the window with no way back.
- The app's window can no longer be navigated away from Dak; and an update's code always reaches an open window.

## 0.2.2
- PR size (+lines −lines · files) on every review and queue row, with large changes in bold.
- The merge queue sits at the top of the sidebar, with a count of PRs waiting for your review.
- One topic at a time: a bar above the conversation names the topic you are reading (PR number, title, where it stands, size, "topic 3 of 30") with previous and next ([ and ]). "All topics" brings back the single timeline.

## 0.2.1
- The merge queue, rebuilt: PRs waiting for your review first (from your inbox), then in progress, then approved and waiting, then deployed today.
- "Approved by you" is read from your verdict on the PR's thread, never typed; a row without one says so.
- Each row shows how long it has been at its step, an estimate (`--eta 4m`: "about 4 min left", or "over"), and what it waits for (`--after 2413`).
- "I'm reviewing" on a PR (`dak reviewing <thread>`): the sender hears, the PR stays waiting on you, and `dak show` says you are on it until your verdict.

## 0.2.0
Agent-to-agent work, not only agent-to-person.
- Shared threads: `--cc name:role` and `dak add` put a reviewer, an approver and watchers on one thread. They get its mail and reply on it.
- Ready-for-review handoffs (`--ready`): head, base, migration and proofs, refused when a field is missing or the head moved.
- Reviewer runners: `dak runner add codex` reviews PRs sent to it with `codex exec` read-only, and posts line comments, a verdict, and chapters or reviewer notes.
- Groups: `--to group:<name>` reaches every member; `dak ack`; `dak show` says who acked, read, or has not opened it.
- Read state under your last message in the app.
- `--cost` and `--cap` on a priced question; `dak decisions` lists every choice with its question and cost.
- `dak reply --head-only`: a new head in place, with a note.
- Stacked PRs show "Stacked on #N", linked to its thread.
- The merge queue: `dak queue set <pr> --state ...` from merge scripts, shown live in the app.

## 0.1.7
- `dak chapters draft`: a chapters.json with every hunk listed and grouped by folder, so an agent writes only the words. `check` refuses the placeholders it leaves.
- Concept chapters: a chapter may give only `key_changes`, to explain part of a big hunk on its own.
- Read signal: `dak show` says whether the reader has opened a thread, and when; `--json` carries `reads`.
- `dak refresh <thread>`: the same PR at its new head after a rebase, in place, with no new version.
- `--message-file <f>` (or `-` for stdin), so `$` and backticks reach the reader as written.
- Switch topics from the menu on the topic line in the toolbar, in any view, focus included.
- Settings: Codex's and Cursor's extra settings sit nested under them, without icons.

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
