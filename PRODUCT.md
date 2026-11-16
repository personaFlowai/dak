# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Rendered inside a native macOS shell (`mac/`, AppKit window around a WKWebView). Mac app first: the window, title bar, menus and notifications are native; the same screens also open in a browser as a fallback.

## Users

Designed for a developer or founder who runs many AI coding agents on one Mac: named agents (a coordinator, an advisor, engineers in their own worktrees) plus Claude Code, Codex, Cursor and remote agents. They review PRs, design briefs and notes between other work, often several in a row, and read for decisions rather than every line. Agent names are whatever you choose; nothing assumes a particular team.

## Product Purpose

One local inbox where any agent sends work for review and gets the answer back on the same thread. A PR arrives explained in chapters, with the diff and the whole file; a brief arrives as a document to comment on. He leaves anchored comments and a verdict; the agent receives them as JSON. Success: he understands an agent's PR in about five minutes and stops checking several apps for agent messages.

## Positioning

The review and the conversation are one thing: the agent that wrote the change explains it in its own words (chapters, key changes, risk with a reason), the founder answers in place, and the answer travels back to that agent's session without a copy-paste. Everything stays on the machine.

## Operating Context

- Agents send with the `dak` CLI or the localhost HTTP API; Claude Code sessions receive replies through a hook at each turn.
- PRs come from GitHub through `gh`; comments can optionally be mirrored back to GitHub as a review.
- A read-only helper (Claude Code, Codex or Cursor, chosen in Settings) answers his questions about code or a doc without posting anything.
- A shared, often busy laptop: no heavy builds, no background services beyond the one local server.

## Capabilities and Constraints

- Store: one SQLite file and a blob folder in `~/.dak`. Nothing leaves the machine except GitHub reviews he chooses to post.
- Remote agents (Grok Bot, say) reach Dak through a tunnel Dak opens on request, with a key that only lets that agent send and read its own replies.
- How mail reaches each agent (connected from Settings):
  - Claude Code: at each turn's start and end, and an idle session is woken when mail arrives (an `asyncRewake` hook running `~/.dak/wake.sh`, one `curl` long-poll per session).
  - Codex: at each turn's start and end. Codex hooks cannot start a turn, so an idle Codex session reads its mail when it next runs.
  - Cursor: its stop hook hands new mail over as a follow-up when a turn ends; an idle Cursor agent cannot be woken.
  - Grok Bot (remote): long-polls its own key's `/x/wait`.

## Brand Commitments

- Name: Dak (डाक, "the post").
- Petrol (#1f6f8b) is the one accent colour. Red appears only to mean danger: high risk, changes requested. Gold only for the letter's stamp in the app icon. One consistent colour for every agent: no per-agent hues.
- Must feel like a native Mac app, not a website.
- Tool identity shown with real marks: Claude, Cursor and GitHub from Simple Icons (CC0); Codex with Phosphor's OpenAI logo (MIT icon set; the mark itself stays OpenAI's). Grok gets a plain initial: xAI publishes no free mark.

## Evidence on Hand

Threads live only in each user's local store. Screenshots and demos use made-up conversations. No invented users, metrics or testimonials.

## Product Principles

1. The agent explains; the founder decides. Every PR leads with why and what, then the code.
2. Answers go back where they came from, anchored to the exact line or words.
3. Native and quiet: the tool disappears into reading.
4. Local and private by default; anything that leaves the machine is an explicit choice per send.
