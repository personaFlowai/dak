# Using Dak from an agent

Dak is how you hand work to a person (or another agent) and get their answer back, without them leaving their review screen. Use it instead of pasting a PR link or a brief into chat.

## The loop

1. **Send** one thread per thing to review: `dak send --to <reader> --from <you> ...`. It prints the thread id (`--json` gives `{thread, message}`).
2. **Wait** for the answer: `dak wait <thread> --for <you> --timeout 15m --json`. It exits 0 with the new messages, or 2 on timeout. Waiting marks the reply read, which shows the person "picked it up".
3. **Act** on the verdict and comments, then **reply** on the same thread: `dak reply <thread> --from <you> "Fixed in 4e1c2a0"`. A new version of a PR or doc goes on the same thread too (`--base main --chapters ...`, or `--doc brief.md`).
4. To see everything new for you at once: `dak inbox --for <you> --unread --json`.

Readers are the names in `~/.dak/config.toml` (`dak readers`). Sending to anyone else is refused with the list.

## Verdicts

| Verdict | Meaning |
|---|---|
| `approve` | Go ahead. |
| `changes` | Do what the comments say, then send the new version on this thread. |
| `question` | Answer on this thread before doing anything else. |
| none | A plain reply (notes and conversation). |

Comments carry an anchor: `{kind: "code", file, side: "old"|"new", start_line, end_line}` for code, or `{kind: "doc", version, block_index, block_hash, quote}` for a paragraph of a doc. `side: "old"` means a line the PR removed.

## Your name

`dak whoami` prints your name on Dak in this session. Inside Claude Code, Codex or Cursor, `send`, `reply`, `inbox` and `wait` fill it in. A Codex session's name is its folder plus `-codex` and its worktree's id (say `shop-codex-bc25`), so it never shares a name with a Claude Code session in the same repository. Sending as a different name (`--from atlas`) makes the session answer to that name from then on.

## How mail reaches you

- **Claude Code**, once connected in Dak's Settings: new mail is added at the start of a turn, a stop is held while mail is waiting, and an idle session is woken when mail arrives. You do not need to poll or run `dak wait` in a loop.
- **Codex**: mail arrives at the start and end of each turn once you approve Dak's hook in Codex (`/hooks`). Codex cannot be woken once idle; with "Keep Codex listening" on in Dak's Settings, a session waits up to an hour after each turn and carries on the moment mail arrives. Until then, and as a fallback, Codex runs `dak inbox --unread` at the start and end of every task (its AGENTS.md says so). An idle Codex session cannot be woken.
- **Cursor**: the stop hook hands new mail over as a follow-up message when a turn ends.
- **Anything else**: `dak wait <thread> --for <you>` (blocks until a reply), `dak watch --for <you>` (a stream), or `GET /x/wait/<id>` over HTTP.


- **A closed session still gets its mail.** The Claude desktop app closes an idle session's process. When mail waits for one, Dak runs one turn on it in the background with the mail (`claude -p --resume <session>` in its folder) and tells the person. Act on it as at any turn, then stop.
## Buttons, updates and links

- `--option "<text>"` (repeatable, up to six) puts buttons under your message. The reader's reply carries `choice`: the exact button text. Over HTTP, send `options: [...]`; the reader's reply has `choice`.
- `--fyi` (HTTP `needs_reply: false`) marks an update that needs no answer, so the thread does not wait on the reader. After the reader approves, text-only replies count as updates anyway; a new version, a `question` verdict or buttons always ask.
- `--link <url>` attaches a link. Linear issues, Notion pages, GitHub PRs and Figma files show as named cards.
- Threads between two agents (Atlas writing to Mitra, say) are visible to the person under "Between agents", read only.

## Chapters

A PR without chapters shows one section per file. Chapters make it reviewable in minutes: write them in the order a reader should read, grouping hunks by what they do, not by file. Open with a prologue: the reader sees it first, before any code.

```json
{ "prologue": {
    "why": "The problem, in plain words, for someone who knows the product but not this code.",
    "what": "What this PR does about it, in two or three sentences.",
    "focus": ["The one or two places worth a careful look, and why"] },
  "chapters": [{ "title": "The work service learns about taps",
   "summary": "One or two plain sentences: what changed and why.",
   "risk": "medium",
   "risk_why": "Only for medium or high: what could go wrong, in plain words.",
   "why": "Why this part exists, for someone who knows the product but not this code.",
   "proof": "How the risk is shown safe: the test, the run, the number. Required for high risk.",
   "noticed": "What a person using the product will notice, or 'Nothing visible'.",
   "check": ["A question the reviewer should answer while reading this chapter"],
   "reviewer_note": { "by": "cursor", "text": "What a reviewer who read the code wants the reader to know." },
   "hunks": [{ "file": "src/core/work/actions.ts", "start": 62 }],
   "key_changes": [{ "text": "writerFor: a writer for someone already signed in", "file": "src/core/work/actions.ts", "line": 66 }] }] }
```

- A `medium` or `high` chapter must say why in `risk_why`, and a `high` one must give its `proof`; `dak chapters check` refuses them otherwise.
- `why`, `noticed`, `check` and `reviewer_note` are optional and show at the top of the chapter. A code reviewer who has read the diff (Cursor, Codex) often writes better chapters than the author: it can write the whole file, or add a `reviewer_note` to the chapters it has an opinion on.

- `hunks[].start` is the hunk's first line on the new side (the old side for a deleted file). Every hunk must be in exactly one chapter.
- `key_changes` are the three or four lines worth looking at first. `side: "old"` for a removed line.
- Check before sending: `dak chapters check chapters.json --pr <n>` (or `--base main`, or `--diff file`). It names any hunk left out and any line that is not in the diff, and `dak send` refuses the same mistakes.
- To list hunk starts: `git diff main...HEAD | grep -n '^@@'`, or send once without chapters and read the file list.
- Start from `dak chapters draft --pr <n>` (or `--base main`): every hunk listed, grouped by folder, with `WRITE:` placeholders that `check` refuses until they are replaced.
- A concept chapter leaves out `hunks` and gives only `key_changes`, to explain one part of a big hunk on its own.
- After a rebase, `dak refresh <thread>` moves the thread's PR to the new head in place (no new version). `dak show <thread> --json` carries `reads`: who has read how far, and when. `--message-file <f>` (or `-` for stdin) sends a body the shell never touches.

## Working with other agents

- **One thread per PR.** `--cc codex:reviewer --cc atlas:watcher` (or `dak add <thread> name:role` later) puts everyone on the same thread. Roles: author, reviewer, approver, watcher. A participant gets the mail like the addressee and can reply; an approver can approve.
- **Ready for review.** `--ready --migration <f|none> --proof tests:pass:412 --proof build:pass [--skipped "e2e: why"] [--head sha]`. Dak refuses a handoff with a missing field, or whose `--head` is not the PR's head.
- **Groups.** `dak group set engineers a b c`, then `--to group:engineers`. Each member acks with `dak ack <thread>`; `dak show` lists who acked, who read it and who has not opened it.
- **Reviewer runners.** `dak runner add codex` makes `codex` a reader that is a command. A PR sent to it (or with `--cc codex:reviewer`) is reviewed by `codex exec` read-only in the PR's folder; Dak posts the findings as line comments, a verdict, and chapters or reviewer notes. `--command '["prog","arg"]'` runs anything that prints the same JSON. Runs are paid model calls.
- **Decisions and cost.** `--cost 0.15 --cap 0.25` on a question with buttons. `dak decisions --for <person>` lists every choice with its question, date and cost.
- **Stacked PRs.** A PR whose base is another branch shows "Stacked on #N", linked to that PR's thread.
- **Merge queue.** `dak queue set <pr> --state ...` from merge scripts; Dak shows the queue live. Over HTTP: `GET /v1/queue`, `PUT /v1/queue/<pr>` with `{ "state": "testing", "note": "..." }`.
- **Holds.** `dak queue set <pr|thread> --rework "why"` greys a PR out below the rest until its next version; `--state parked --waiting "why"` keeps it out of the review count until `dak queue unpark`.
- **Moved heads.** An approval records the head and diff it approved. The queue row says when the head moved since, and whether it is a rebase only or the changes differ (`--head <sha>` from the merge script triggers the check).
- **Routes.** `dak route set <person> --from-group <group> --via <agent>`: that group's PRs and briefs to the person go to the agent first, with a note. Replies are not routed.
- **Try it.** `--type tryit --ticket REVA-123` gives Works / Something's wrong; a Works pick comes back with `tryit_result` naming the ticket to close.
- **Stacked reviews.** `--range base..head` (send, add, reply) makes a runner review only those commits.
- **Lookup.** `dak thread --pr <n>` prints the thread id; `send --json` returns `thread_id`.
- **Confirmed orders.** `--confirmed-by <thread>` on `order`, `review-order` and `priority` applies an order as the person's when they asked for it there, by button or in words; the output quotes them.

## Over HTTP

For agents without a shell: `http://127.0.0.1:7474/v1`, with `Authorization: Bearer $(cat ~/.dak/token)`.

| Call | Does |
|---|---|
| `POST /v1/threads` `{to, from, subject, body, attachments:[{type:"doc",name,content} \| {type:"link",url} \| {type:"file",name,base64,mime}]}` | Send |
| `GET /v1/threads/:id/wait?for=<you>&timeout=25` | Long-poll for a reply (at most 55 s per call) |
| `POST /v1/threads/:id/messages` `{author, body, verdict?, comments?}` | Reply |
| `GET /v1/inbox?for=<you>&unread=1` | New messages, marked read |
| `GET /v1/threads/:id` | The whole thread |

PRs are sent with the CLI, which can read the repository. Errors are always `{error: {code, message}}`.
