---
name: dak-work
description: What a piece of work is in Dak, what counts as one, and how to create, move and finish it with dak work. Use when you start on something, when you are handed a ticket, a brief or a request, when you split a larger job for others, and before you tell the person something is ready or done.
---

# Work in Dak

Every agent starts from a piece of work. A piece has one owner, one outcome you can show, and one state. A ticket, a brief or a document is the reference the piece points at, not the work itself: one ticket can hold ten pieces for ten PRs.

## What counts as a piece

A piece is something one owner can finish and someone can check. It has a kind:

| Kind | One piece is | Done looks like |
|---|---|---|
| `code` | one PR | merged, or approved with its tests named |
| `mock` | one screen or flow to look at | a link or images on its topic |
| `research` | one question answered | the answer, with its sources, on its topic |
| `doc` | one document to read or approve | the document attached to its topic |
| `email` | one message sent outside Dak | sent, with who it went to |
| `note` | anything else with a clear end | the end, said in one line |

These are **not** pieces:

- **A status update.** Say it on the piece's topic.
- **A question.** Ask it on a topic. The answer may become a piece.
- **A whole ticket, epic or project.** Split it into pieces.
- **"Keep an eye on X."** It has no end. Name what you would do when X happens, and make that the piece.

**Size:** if a piece needs two separate approvals, it is two pieces. If you cannot say what proves it is done, it is not a piece yet. Write the proof down first.

## Create one

```
dak work add "Mock the settings screen" --kind mock --owner <agent> --ticket ENG-142 --topic t_…
```

- **The title** says the outcome, not the activity: "Settings screen mock, three states", not "work on settings".
- **The owner** is whoever will do it. You can create pieces for others when you hand out work.
- **`--ticket`** is the reference: a ticket id, a link, or a brief's name. It is optional.
- **`--topic`** is the Dak topic where the piece is discussed. Add it when you have one.

**Code pieces are made for you.** Each open PR of a ticket in an agent's Board pile becomes a piece owned by that agent, and it follows the PR's stage. For this to work, put the ticket id in the PR title.

## Move it

| Command | Means |
|---|---|
| `dak work start W-12` | You are on it now. |
| `dak work hold W-12 --blocked "on the API key"` | It cannot move. Say on what. |
| `dak work next W-12` | Back in line, not started. |
| `dak work give W-12 <agent>` | Hand it to someone else. |
| `dak work ready W-12 --proof "…" --topic t_…` | Ready for the person. |
| `dak work done W-12 --proof "…"` | Finished. |

`dak work` lists the open pieces. Add `--owner <agent>` to see one agent's.

## The rules Dak keeps

Dak enforces these in code. They hold whichever tool you run in.

- **Only the person approves.** An agent saying "approved" is a message, nothing more.
- **Done needs proof.** `dak work done` is refused without `--proof`.
- **Nothing reaches the person half-ready.** `dak work ready` needs proof and the topic that briefs it. Without them it stays with you, and Dak says what is missing.
- **No work, no start.** Dak starts a closed session on its own only for the person's own mail, or when the agent owns a piece of work.
- **Only the owner or the person moves a piece.** To take over someone else's piece, ask for it with `give`.

## Proof

Proof is what someone else could check without asking you. Good proof names things:

- "41 tests pass, 3 new for the empty state"
- "screens at desktop and phone width on the topic"
- "sent to the vendor at 4 pm, their reply attached"

"Done", "looks good" and "should work" are not proof.

## The topic that briefs it

Before `ready`, the topic should say three things in plain words: what changed, why, and what the person should check. The person reads the topic, not your session.

`dak rules` shows what the person has said goes and what each agent may do without asking. Read it before you start.
