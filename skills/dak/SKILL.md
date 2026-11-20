---
name: dak
description: Send a pull request, a design doc or a note to a person or another agent through Dak (the local review inbox on this Mac), read your Dak inbox, reply on a thread, and wait for a verdict. Use whenever someone needs to review or approve your work, instead of pasting a PR link or a document into chat, and when a hook says you have Dak mail.
---

# Dak

Dak is the review inbox on this Mac. You send work to a reader (a person, such as `sam`, or an agent, such as `lead`); they answer on the same thread with comments and a verdict. Every command takes `--json`. If `dak` is not found, it is not installed: say so and stop. `dak help guide` has everything this page leaves out (chapters in depth, the merge queue, routes, runners).

**Your name.** `dak whoami` prints it. Inside Claude Code, Codex or Cursor, `send`, `reply`, `inbox` and `wait` fill it in. Mail reaches Claude Code through Dak's hooks, even mid-turn; elsewhere run `dak inbox --unread --json` at the start and end of a task.

## Send

- **A PR, with chapters:** `dak chapters draft --pr <n> > chapters.json`, regroup the hunks by what they do and fill every `WRITE:`, `dak chapters check chapters.json --pr <n>`, then `dak send --to <reader> --pr <n> --chapters chapters.json "What you need" --json`. Chapters are in reading order, plain words, at most 6 files each; risk needs `risk_why` and `proof`. `dak help chapters` has the format.
- **Ready for review:** add `--ready --migration none --proof tests:pass:412 --head <sha>`; `--cc codex:reviewer` puts a reviewer on the same thread.
- **A doc:** `dak send --to <reader> --doc docs/brief.md "What you need decided" --json`.
- **A note:** `dak send --to <reader> --subject "<subject>" "<message>" --json`; `--file` for images, `--link` for a ticket or page. A message with `$`, backticks or quotes goes in a file: `--message-file msg.md`.
- **A choice gets buttons:** `--option "Merge first" --option "Hold"`; the reply's `choice` is the button text.
- **An update gets `--fyi`.** It never wakes anyone and needs no answer; do not answer one.

## Who gets woken

- `@name` in a message wakes only that member; everyone else on the topic gets it as one line at their next turn. Write `@<person>` only for what needs the person.
- In a group, your message with no `@name` wakes nobody; `@all` wakes everyone, so use it only when everyone needs it now. The person's messages to a group, and their button picks, wake whoever they are for.
- Brought in by a mention? Your reply goes to whoever mentioned you, and you leave the topic.
- Mail not for you arrives as one line each; `dak show <thread>` only when it matters.
- **Ask and wait:** `dak reply <thread> "@ana is the API key in?" --wait` stays until the answer comes back (10 minutes, `--timeout`), so you carry on in the same turn.

## End with one line, not a copy

Say what is done and where in a line or two: "#2601 is up, chapters on the topic". Do not paste work, diffs or recaps into Dak: everyone on the topic reads it, and the detail is in the PR, doc or file. An update to other agents over about 600 characters is refused.

**Write each thing once.** Not in your session and again in Dak, not as a message and then an update repeating it, not to the person and again to the lead. One message per step, on the topic it belongs to; whoever needs it reads it there.

## Wait, and act on the verdict

In Claude Code you need not wait: end your turn, and the answer wakes you. Otherwise `dak wait <thread> --timeout 30m --json` (exit 2: nothing yet; carry on and wait later).

| Verdict | Do |
|---|---|
| `approve` | Go ahead as the message says. |
| `changes` | Do what the comments say; send the new version on the same thread. |
| `question` | Answer first; change nothing until answered. |
| none | Read it; answer if it asks. A `choice` is the button they picked. |

- **Reply on the same thread, always:** `dak reply <thread> "Fixed in 4e1c2a0: the check runs first" --json`. A new version: `dak reply <thread> --pr <n> --chapters chapters.json "What changed"`. After a rebase with nothing new: `dak refresh <thread>`.
- **Several PRs on one thread:** a verdict covers only the PRs it names. Merge only PRs whose own verdict in `dak show <thread> --json` is `approve`.
- **Finished** (merged, shipped): `dak reply <thread> --done "Merged as 4e1c2a0"`. Every time a PR you sent merges.

## Work and the team

- Every agent starts from a piece of work: one owner, one outcome, one stage. The dak-work skill says what counts as a piece; `dak work stage W-12 testing` moves yours; `dak rules` shows what the person has said goes.
- `dak team` lists who works through Dak and their areas: send work to the one whose area it is.
- Your Board pile: `dak next` takes your next ticket, `dak status <ticket> "what you're doing"` says where you are, `--blocked "on what"` when stuck. Put the ticket ID in every PR title and topic subject.
