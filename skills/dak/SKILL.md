---
name: dak
description: Send a pull request, a design doc or a note to a person or another agent through Dak (the local review inbox on this Mac), read your Dak inbox, reply on a thread, and wait for a verdict. Use whenever someone needs to review or approve your work, instead of pasting a PR link or a document into chat, and when a hook says you have Dak mail.
---

# Dak

Dak is the review inbox on this Mac. You send work to a reader (a person, such as `sam`, or an agent, such as `atlas`). They read it in the Dak app, leave comments anchored to lines or paragraphs and a verdict, and the answer comes back to you on the same thread. Every command takes `--json`.

Before the first send, check Dak is there: `dak agents --json` lists the readers and sessions. If `dak` is not found, it is not installed on this machine: say so and stop.

**Your name.** `dak whoami` prints your name on Dak in this session. Inside Claude Code, Codex or Cursor, `send`, `reply`, `inbox` and `wait` fill it in, so `--from` and `--for` are only needed to use a different name (a named role such as `atlas`). Once you send as a name, this session answers to it.

**Getting mail.** Claude Code receives mail through Dak's hooks, even when idle. If your tool has no hook running (Codex until its hook is approved), run `dak inbox --unread --json` at the start and the end of every task.

## 1. Send a PR, with chapters

A PR without chapters reads one file at a time. Chapters turn it into a five-minute read: the reviewer knows why each part exists, where to look, what could go wrong and how you know it does not.

Start from a draft: `dak chapters draft --pr <number> > chapters.json` (or `--base main`) lists every hunk, grouped by folder, with `WRITE:` placeholders. Regroup the hunks by what they do and replace every placeholder; `dak chapters check` refuses any left. The finished file looks like:

```json
{ "prologue": {
    "why": "The problem, as a person using the product sees it. No file names.",
    "what": "What this PR does about it, in two or three sentences.",
    "focus": ["The one or two places worth a careful look, and why"] },
  "chapters": [{
    "title": "Taps go through the work service",
    "summary": "What changed in this part, in one or two plain sentences.",
    "why": "Why this part exists: what would be wrong without it.",
    "risk": "low | medium | high",
    "risk_why": "Medium or high only: what could go wrong, in plain words.",
    "proof": "How you know it does not: the test name, the run, the before and after number. Required for high.",
    "noticed": "What a person using the product will notice, or 'Nothing visible'.",
    "check": ["A question the reviewer should answer while reading this chapter"],
    "hunks": [{ "file": "src/core/work/actions.ts", "start": 62 }],
    "key_changes": [{ "text": "The permission check moves here", "file": "src/core/work/actions.ts", "line": 66 }]
  }] }
```

How to write them well:

- **Order is reading order**, not file order. Group hunks by what they do. Start with the part everything else depends on. Three to six chapters for most PRs; a small PR can have one.
- **Write for someone who knows the product, not the code.** Plain words, no ticket history.
- **`why` and `summary` answer different questions.** `summary` is what changed. `why` is what would be broken or missing without it.
- **Risk is a claim, so it needs evidence.** `risk_why` says what could go wrong; `proof` names what shows it does not (a test that fails without the change, a measured run, a query plan). A risk you only assert is a risk the reviewer has to take on trust.
- **`check` is what you would ask yourself**, e.g. "Does any caller still read the old field?" Two or three, concrete, answerable from the diff.
- **`noticed`** is what changes on screen or in a message. Say "Nothing visible" for internal changes.
- **`key_changes`**: the two to four lines worth looking at first. `side: "old"` for a removed line.
- **A concept chapter** has no `hunks`, only `key_changes`: use it to explain one part of a big hunk (a long migration, say) on its own. Its hunks still belong to another chapter.
- **`hunks[].start`** is the hunk's first line on the new side (the old side for a deleted file). Every hunk must be in exactly one chapter. List them with `git diff main...HEAD | grep -n '^@@'`.
- **Small chapters.** A chapter is at most 6 files and 12 hunks, so a reader can hold it. Split a bigger one by what each part does. If one truly must stay whole (a rename across a folder), give the reason as `"big_why"` on that chapter, or `--allow-big "why"` on the send; it shows on the chapter. `dak chapters check` and `dak send` refuse a big chapter without one. A concept chapter (key changes only) is exempt.
- **A reviewer can write them, or add to them.** If a code reviewer (Cursor, Codex) has read the diff, ask it to write the chapters, or to add `"reviewer_note": { "by": "cursor", "text": "..." }` to the chapters it has an opinion on. The reader sees the note under the chapter's heading.

Then:

1. Check: `dak chapters check chapters.json --pr <number>` (or `--base main`). Fix every line it prints; `dak send` refuses the same mistakes.
2. Send: `dak send --to <reader> --from <you> --pr <number> --chapters chapters.json "What you need from them" --json`. Use `--base main` instead of `--pr` for a branch with no PR yet. Keep the thread id it prints.
3. Wait (section 4).

### Ready for review

When the PR is ready, say so with the proof, as fields Dak checks:

`dak send --to <reader> --from <you> --pr <n> --chapters chapters.json --ready --migration none --proof tests:pass:412 --proof build:pass --skipped "e2e: no device today" --head <sha> --cc codex:reviewer --cc atlas:watcher --json`

- `--migration` is the migration file name, or `none`. `--proof` is `name:pass|fail[:count]`, at least one. `--skipped` says what you did not run, and why.
- `--head` is the commit your proofs ran on. If the PR's head has moved, Dak refuses: re-run on the head.
- `--cc name:role` puts the reviewer, the approver and anyone watching on the same thread. Each gets the mail and can reply there; nobody copies findings between messages.
- After a rebase with nothing new to review: `dak reply <thread> --head-only "Renumbered, same SQL" --json`.

### A reviewer that runs on its own

If Dak has a runner named `codex` (`dak runner add codex`), sending a PR to it, or `--cc codex:reviewer`, makes Dak run `codex exec` read-only on the PR. It posts its findings on the thread as line comments with a verdict, and writes the chapters or a `reviewer_note` per chapter. Every run is a paid model call, so only send to a runner when a review is wanted.

## 2. Send a doc or a note

- A doc to review: `dak send --to <reader> --from <you> --doc docs/brief.md "What you need decided" --json`. Comments come back anchored to paragraphs, with the words quoted.
- A note: `dak send --to <reader> --from <you> --subject "<subject>" "<message>" --json`. Add `--file path` (images show inline) or `--link url` (an artifact, a page).
- Say what you need in the message: "Approve to merge", "Pick A or B".
- **A choice gets buttons.** `--option "Merge #2401 first" --option "Hold both"` (up to six, short). The reader answers in one click; the reply's `choice` is the exact text of the button. Use buttons whenever the answer is one of a few known options.
- **An update gets `--fyi`.** "Merged", "tests running", "deployed" need no answer: add `--fyi` so the thread does not sit in the reader's inbox as waiting. An update never interrupts the reader or wakes an idle session: it arrives at their next turn, marked "(an update, no reply needed)", with no reply line. Do not answer one. After the reader approved, a plain text reply counts as an update anyway; a new version, a question or buttons always ask.
- **Links to Linear, Notion, GitHub or Figma** go in with `--link <url>` and show as named cards (the issue id and title, the page name). Put the ticket and the doc you are working from on every send.

## 3. Read your inbox

- `dak inbox --for <you> --unread --json` returns new messages and marks them read.
- `dak show <thread> --json` returns the whole thread, and `reads`: who has read how far, and when (`seen_at`). Use it to tell "not opened yet" from "read, no answer" before chasing.
- A message with `$`, backticks or quotes in it: write it to a file and pass `--message-file msg.md` (or `--message-file -` for stdin), so the shell does not touch it.
- If the Claude Code hook is connected, new mail arrives at the start and end of your turns with the thread id in it. Act on it in that turn.

### To several agents at once

- A group: `dak send --to group:engineers --from <you> --fyi "Load 67: stop your stacks" --json`. Each member answers with `dak ack <thread> --from <them> "Stopped"`; `dak show <thread>` lists who acked and who has not opened it.
- A question that spends money: add `--cost 0.15 --cap 0.25` beside its `--option` buttons. `dak decisions --for <person>` later lists every button they picked, with the question, the date and the cost.

### Finding threads

`dak thread --pr 2426` prints the thread carrying that PR. `dak send --json` and `dak reply --json` return `thread_id`.

### Routes

The person can have a group's PRs and briefs come to an agent first: `dak route set pratik --from-group engineers --via atlas`. Such a send goes to atlas with a note saying why, and `dak send` prints "Routed". Replies, notes and questions are never routed.

### Try it

A "try it" on a live feature: `dak send --to pratik --type tryit --ticket REVA-2850 "Open Settings → Messages and ..."`. It gets the buttons "Works: move REVA-2850 to Done" and "Something's wrong". When they pick Works, the reply carries `tryit_result: {result: "works", ticket}`: post your production proof on the ticket and move it to Done; that pick was the Checking.

### Reviewer runners on stacked PRs

`--range base..head` on `dak send`, `dak add` or `dak reply` makes a runner (codex, cursor) review only those commits, for example `dak add <thread> codex:reviewer --range origin/reva-2440..HEAD`. In a read-only sandbox the Dak inbox check prints nothing new and exits 0; reviewer workspaces in temporary folders are hidden from `dak agents` (`--all` shows them).

### The merge queue

Merge scripts keep it current: `dak queue set <pr> --state approved|testing|building|merging|merged|migrated|deployed|failed|held [--eta 4m] [--after <pr>] [--head sha] [--migration f] [--note "full suite"]`. Set `--eta` at each step so the person sees time left; use `--after` for a PR that waits on another, not the title. Approval is read from the person's verdict on the thread, so never mark a PR approved they have not approved. `dak queue` prints what waits for their review, what is moving and what waits its turn. When the person presses "I'm reviewing", you get a Dak message and `dak show` says so.

What waits on the person is one list across types: PRs, briefs (a doc, a spec or a mock: one type) and decisions (buttons, or a question after an approval). Updates (`--fyi`) and PRs they approved that only wait to merge are not in it. Dak works out the type; say it when it is not obvious (`--type brief`), and say what the answer releases (`--blocks "Rohan, #2433"`) on any send, reply or `dak queue priority <thread> --review`. The order is one order across types: a brief that holds an engineer goes before a normal PR.

Priorities. Three tiers (urgent: a production bug, security, an unblocker; normal; later), with an order inside each:
- Review order, what the person should review first: `dak queue priority <pr> --review --tier urgent --why "unblocks 8 PRs"`, and `dak queue review-order <pr> <pr>...` for the order. A PR sent with `--hotfix` goes urgent on its own.
- Merge order: `dak queue order <pr> <pr>...` and `dak queue set <pr> --tier urgent --why "production bug"`. Dak refuses an order that puts a PR ahead of the one it waits for (`--after`).
- Say what a held or waiting row is waiting on, in plain words: `--waiting "a migration renumber"` (cleared when its state changes). Dak adds "Waiting on #2413" and "Waiting on its pair" itself.
- Pairs tested together: `dak queue pair 2420 2433`; they show as one row and merge together.
- When the person asks for an order (they pick your "Use this order" button, or write "can you move them lower?"), apply it with `--confirmed-by <that thread>` on `order`, `review-order` or `priority`; it then counts as theirs and moves rows they had placed. Dak checks that they answered there after your last question, in the last day, and your output quotes what they wrote: only use it when their words asked for this.
- About to change a PR the person may start reviewing? `dak queue set <pr|thread> --rework "prefix being added"`: it greys out below the rest, `queue next` skips it, and it comes back by itself with your next version (`dak reply --pr`). `--rework none` ends it early.
- Open but parked by the person's choice: `dak queue set <pr|thread> --state parked --waiting "department settings"`. It stays out of the review count until `dak queue unpark <pr|thread>`.
- When a head moves after the approval, the queue row says so, and whether it is a rebase only or the changes differ. Report each push with `--head <sha>`: Dak compares against the approved diff (GitHub's for a PR, git's for a branch). A merge script should stop on "content changed".
- The person can drag rows and change tiers; their order wins, and your reordering leaves their rows in place (the command says which it kept). So read the order rather than assume it: your merge loop asks `dak queue next --json` for the next ready PR or pair (approved, not held, what it waits for already merged), and gets exit code 3 when nothing is ready.

## 4. Wait for the answer

In Claude Code with Dak connected, you do not need to wait at all: finish your turn, and the answer wakes this session when it arrives. Otherwise:

`dak wait <thread> --for <you> --timeout 30m --json`

Exit code 2 means nothing yet. Carry on with other work and wait again later; do not ask in chat whether they have looked. Run long waits in the background.

## 5. Act on the verdict, and reply on the same thread

| Verdict | Do |
|---|---|
| `approve` | Go ahead (merge, ship, proceed) as the message says. |
| `changes` | Do exactly what the comments say, then send the new version on the same thread. |
| `question` | Answer first, then wait again. Change nothing until answered. |
| none | A plain message: read it and answer if it asks something. If it has a `choice`, the reader clicked that button. |

**The team and @mentions.** `dak team` lists everyone who works through Dak, on this Mac or outside it: their @name, role, area, and what they can and cannot do. Send work to the one whose area it is. Writing `@name` in any message or reply brings that member onto the topic from that message on, and the mail reaches them (marked "mentions you"). Write `@<person>` only for what needs the person.

**A thread can carry several PRs.** Each PR number is its own PR: replying with `--pr 2451` on a thread that has #2450 adds a second PR, and `--pr 2450` again is #2450's next version. A verdict names the PRs it is about (`"prs": [2450]` on the message, "approved #2450" in your hook), and covers only those. Read what is approved from `dak show <thread> --json`: `prs` lists each PR with its own `verdict`, `by` and `at`. **Merge only PRs whose own verdict is `approve`**; never read one approval as approving the thread. A new version of a PR clears its approval and no other PR's. To give a verdict yourself on such a thread: `dak reply <thread> --from <you> --verdict approve --on 2450`. Approving without `--on` is refused when the thread has more than one PR.

Each comment has an anchor: `{kind: "code", file, side, start_line, end_line}` or `{kind: "doc", quote, ...}`. `side: "old"` is a line the PR removed.

- Answer: `dak reply <thread> --from <you> "Fixed in 4e1c2a0: the check now runs before the write" --json`
- An update that needs no answer: `dak reply <thread> --from <you> --fyi "Tests running" --json`
- **When the work is finished** (merged, shipped, no longer needed), close it: `dak reply <thread> --from <you> --done "Merged as 4e1c2a0" --json`. The topic leaves the reader's conversation, so their list holds only open work. A later new version or question brings it back. Do this every time a PR you sent merges.
- A question with buttons on the same thread: `dak reply <thread> --from <you> "Which goes first?" --option "#2401 first" --option "#2402 first" --option "Hold both" --json`, then `dak wait`. The answer's `choice` is the button text, exactly as you wrote it. Over HTTP: `options: [...]` on the message.
- The same PR after a rebase or a fixup, with nothing new to say: `dak refresh <thread> --json`. The reader sees the current head in place; no new version, no notification. The chapters stay if they still match; otherwise pass `--chapters`.
- A new version of the PR: `dak reply <thread> --from <you> --pr <number> --chapters chapters.json "What changed since version 1" --json`
- A new version of the doc: `dak reply <thread> --from <you> --doc docs/brief.md "What changed" --json`

Always reply on the thread you were answered on. A new thread for the same work splits the conversation the reader is following.

`dak help`, `dak help chapters` and `docs/agents.md` in the Dak repo have the rest.
