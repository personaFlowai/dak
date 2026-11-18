# Changelog

## 0.13.3

- **Fold the backlog away.** The arrow in the Backlog's header folds it to a slim strip (it still takes a dropped ticket), so the piles get the room; tap the strip to open it. Dak remembers which way you left it.

## 0.13.2

- **Now shows for engineers who never ran `dak next`.** Until an engineer sets a Now, the Board takes the ticket they last said something about that is not blocked. Setting one with `dak next` or `dak status` wins.

## 0.13.1

- **Checking stays on the Board.** A ticket whose PRs are all merged and live, or that Linear has at "Checking", shows as Checking (its own group in each pile) until Linear says Done, so merged work never vanishes before its Done-only-when test is proven.

## 0.13.0

- **One Now per engineer.** `dak next` takes the top of an engineer's pile and makes it their Now; `dak status <ticket> "…"` makes that ticket their Now and puts the previous one back in Up next. Each pile reads top down: Now, Needs you, Blocked on you, Blocked, In review, Up next. Its header says "Now: REVA-x · last word 2h ago", or "Idle since …" when there is no Now.
- **Blocked is blocked.** `--blocked "on what"` shows the ticket as Blocked (Blocked on you when the reason names you), never as in progress, and takes it off Now.
- **"Needs you" only when there is something to answer:** a Dak topic of the ticket's own (its subject names the ticket) waiting on you. A batch topic no longer marks every ticket in it, and an engineer saying it is blocked on you is "Blocked on you" with their reason until they ask on Dak.
- **Stages come from Dak's facts** (verdicts on the ticket's own topics, the merge queue, merged and live). Linear only takes a ticket off when it is Done or Cancelled there; its "In Progress" and "Checking" no longer set the stage. "Building", "Brief", "Live" and "Checking" are gone as stages; a ticket whose PRs are all live is done.

## 0.12.1

- **Setting up the Board in bulk:** `dak assign --file plan.txt` takes one `<ticket> <agent>` per line, in pile order. Every line is checked first (a bad ticket or agent changes nothing), then each agent gets one message listing what it got, and the lead one summary, instead of one message per ticket. `--quiet` tells nobody.
- **Assignments name who made them:** `--from`, else the session's own name, so Atlas's assignments say Atlas. The lead is not sent an FYI about its own assignments.

## 0.12.0

- **The Board, redesigned** to the approved mock. One slim bar: Piles / Stages on the left; "Needs you" as a filter, and Engineer, Label and Milestone as dropdowns on the right, plus search. The backlog is a compact list grouped by milestone (each group folds), sorted by Linear's priority. Piles hold Linear-style cards: ID, a status ring that fills as the ticket moves, title, label dots and the PR count. No colour stripes: a small dot marks "needs you".
- **Tapping a ticket opens its panel** beside the Board: the ticket, its Linear status, labels and milestone, who has it (hand it to someone else, or move it to the top of their pile), its stage and since when, the engineer's last line and what blocks it, every brief, doc and PR linked to it (tap to open its topic), and a short history. Esc or the cross closes it.
- **On the phone** the Board is one column: the bar, the piles, then the backlog; the panel opens full screen, and you hand a ticket to an engineer from it.

## 0.11.1

- **The Board links work per PR.** A PR counts for a ticket only when its own title names it (a batch topic carries other tickets' PRs too), and the same PR sent on two topics counts once. "Needs you" no longer lists finished tickets or tickets whose PRs only shared a topic with one waiting on you. A Linear ticket already started shows as Building.

## 0.11.0

- **The Board** (left rail, and a tab on the phone): your backlog and every engineer's pile in one place. Drag a ticket from the Backlog onto an engineer to give it to them, drag inside a pile to reorder, drag back to the Backlog to take it away. The engineer gets it on their "Board: your pile" topic and Atlas gets an FYI. Filter by engineer, label or milestone, or search. Anything waiting on you is at the top. Every engineer shows, with what they are on or how long they have been idle.
- **Your Linear backlog, read only.** Paste a Linear personal API key on the Board: Dak keeps it in a private file (mode 600), sends it only to Linear, and copies open tickets (title, labels, milestone, status) every five minutes. Tickets without Linear can be made in Dak (`dak task add`).
- **Stages from facts.** A ticket's work is any Dak topic or PR that names it. Its stage (Brief, Building, In review, Needs you, Changes, Approved, Merging, Live, Checking, Done) comes from your verdicts, the merge queue and Linear's status first, and from the engineer's own line only where nothing else says more.
- **For engineers:** `dak next` takes the top of their pile, `dak status <ticket> "…" [--blocked "…"]` is their one line, `dak pile` lists theirs, `dak board` shows everything, `dak assign <ticket> <agent>`.
- On the phone the tab bar now reads Inbox, For you, Queue, Board, Search; "Between agents" stays on the Mac.

## 0.10.1

- **Back on the phone goes up a level,** as iPhone apps do: from a topic to its agent's topics, from the topics to the Inbox. It used to step back through browser history, which could land anywhere you had been before.

## 0.10.0

The first step towards Dak as the one place a team of people and agents works together.

- **The team.** A Team page (left rail) lists everyone who works through Dak: agents on this Mac, agents outside it that hold a door key, the bots they speak as, and you. Give each a name, a role, an area, and what it can and cannot do. Agents read the same cards with `dak team` (or `GET /x/team` from outside), so work goes to the right one. `dak team set <name> --role ... --area ...`.
- **@mentions.** Write `@name` in any message or reply and that member is brought onto the topic from that message on: they get it as mail, marked "mentions you", but not the history before it. Typing `@` in a reply box lists the team; Enter or Tab picks. Mentions show highlighted in the conversation.
- **One door for many outside agents.** The door that lets Grok Bot in now takes any number of agents (cloud agents, personal agents), each with its own key and its own setup text, on the same address. Add, show the setup, give a new key or remove each one on the Team page. Adding an agent no longer starts the tunnel; opening the door does.

## 0.9.4

- **Each topic keeps its own pane.** Switching topics no longer carries the open PR or doc across: each topic shows what you last had open on it, or stays closed if you closed it. A topic opened for the first time shows its newest PR or doc only when it is waiting on you.
- **"I'm reviewing" on one PR, and "Stop reviewing".** On a topic with several PRs the button names the PR that is open ("I'm reviewing #2462"). Once you are reviewing, the bar offers "Stop reviewing": the agent hears you put it down for now, and the topic stays waiting on you. `dak reviewing <thread> --on 2462 [--stop]`.
- **Tabs:** ⌘W closes the topic's tab (⇧⌘W closes the window), a middle-click closes any tab, and tabs can be dragged to reorder.
- **Remove an attachment from a topic** (a merged PR you no longer need): "Remove" in the paperclip list. It is kept, not deleted: the conversation shows one quiet line with Restore, and a removed PR no longer counts toward approvals.

## 0.9.3

- **Updates don't interrupt.** A message that needs no reply (sent with `--fyi` or `--done`, the sender's text after an approval, "I'm reviewing") no longer reopens an agent's turn at its stop or wakes an idle session. It arrives at the agent's next turn, marked "(an update, no reply needed)", with no reply line. Questions, buttons, verdicts and new versions still interrupt as before, and carry any waiting updates with them.

## 0.9.2

- **Every attachment on a topic, one tap away.** A paperclip with a count in the topic's top bar opens a list of everything attached on the topic, oldest first, each with who sent it and when. A PR, doc, image or page opens beside the conversation; a link opens in the browser. No more scrolling up to find them.

## 0.9.1

- Every approval or change request from the app names its PR, even on a topic with one PR: the conversation says "Approved #2462" and the agent's note says "approved #2462", not just "approved".

## 0.9.0

- **A topic can carry several PRs, each approved on its own.** PRs are told apart by number: the same number again is that PR's next version, a different number is another PR on the topic. Before, every PR on a topic counted as a version of one PR, and one Approve passed for all of them; the merge queue then showed every PR on the thread as "Approved by you".
- The review pane shows a strip of the topic's PRs with each one's verdict ("3 of 16 approved"). Approve says which PR it approves ("Approve #2450"), and **Approve all** in ⋯ asks twice and names exactly the PRs it approves.
- A verdict records the PRs it is about (`prs` on the message; `dak reply --verdict approve --on 2450`). Approving a thread with several PRs without naming them is refused. `dak show --json` lists `prs` with each one's verdict; the agent's hook says "approved #2450" and how many stand approved.
- The merge queue reads each row's own PR: its approval, the head it approved, and its size.
- The topic stays waiting on you until every PR on it has your verdict.
- Older approvals that named no PR, on a thread that already carried several, now approve none of them: Dak cannot tell which one was looked at. Approve each again.
- **Tabs no longer pile up.** Opening a topic uses one preview tab (italic), replaced by the next topic you open, as in Xcode. A tab stays once you reply, comment, approve, say you're reviewing, or double-click it.

## 0.8.1

- Enter sends a message, a comment or a question; Shift+Enter starts a new line. ⌘Enter still works. On the phone, Return stays a new line and the Send button sends.

## 0.8.0
- The phone matches the Mac's redesign. Places are a tab bar along the bottom (Inbox, For you, Queue, Agents, Search) with counts. The Inbox is a large title over grouped cards, Pinned then Others. An agent opens its topics one screen in (Waiting on you, In progress, Done, with search), and a topic opens on its own, as on the Mac. The thread bar keeps Approve and ⋯; I'm reviewing, Pin, Archive and GitHub are in ⋯, and where the topic stands is under the name.
- The phone's All topics timeline and topic arrows are gone: the topics list replaces them.
- Fixed: Waiting on you and the queue ran off the side of a phone screen.
- Fixed: a Done topic in the sidebar's list unfolded in place instead of opening.

## 0.7.9
- Pin agents: the pin beside a hovered agent, or Pin in the ⋯ menu, keeps it in a Pinned group at the top of the agents list, in the order you pinned them. Pins are kept by Dak, so the phone shows them too.

## 0.7.8
- Fixed: the Done group in the sidebar's topics did not open; its click redrew only the conversation.

## 0.7.7
- Fixed: opening a topic (from the sidebar, a tab or the queue) stayed at the top instead of going to the latest message; it looked for the topic's divider, which the one-topic view on the Mac does not have. It stays at the end while pictures load, too.

## 0.7.6
- Fixed: a line ran across the Mac window under the tab row (the title bar's separator, drawn at the bottom of the taller title bar), and the cards' rounded tops touched it. The separator is off, and the cards sit just below the tabs.

## 0.7.5
- A tab's × is a plain mark that appears when you point at the tab, with no box around it; the open tab is a quiet fill.

## 0.7.4
- The conversation's tabs and the review pane's header are one band: the same height and the same line under them.
- Fixed: with the sidebar collapsed, the Mac app pushed the toolbar 84pt right to clear traffic lights that now sit in the tab row.

## 0.7.3
- Selection is a quiet fill, as in a Mac source list: the coloured bar at the left edge of a selected topic, search hit and topic divider is gone; a selected topic's title goes bold.

## 0.7.2
- A calmer, deeper colour theme: near-black window and charcoal cards in dark mode, a soft grey window and white cards in light mode, quieter lines, softer secondary greys, a clearer petrol.
- Paste a photo or a file into the reply (⌘V), or drop it on the reply box: it is attached, with a thumbnail for images. Pasted text stays text.
- Fixed: 0.7.0 hid a PR's chapter list (it shared a name with the new rail), squeezing the overview.

## 0.7.1
- A thread's bar keeps only what you act on: I'm reviewing and Approve. Where the topic stands (Waiting on you, You're reviewing, picked up) is on the line under the agent's name; Done, Archive and Open on GitHub are in the ⋯ menu.
- Waiting on you, the merge queue, settings and a new message take the whole window: the agents list belongs to Inbox, so it no longer shows beside them.
- The sidebar's find box lost the light frame WebKit drew around it in dark mode, and the line under the sidebar's heading.

## 0.7.0
- A new frame on the Mac. Panes are rounded cards on the window. A thin rail on the left holds the places: Inbox, Waiting on you, Merge queue, Between agents, Search, New message, Settings. Tabs along the top hold the threads you have open (up to 8), with a dot on one waiting on you.
- The sidebar drills in: the agents, then one agent's topics with "‹ Agents" to go back. Three columns, so the review pane keeps its width; the separate topics column from 0.5.0 is gone.
- Reading-first type: bigger titles and roomier text in PR overviews, chapters, docs and the conversation.
- The window drags, and the traffic lights sit, in the 40pt tab row. The phone is unchanged.

## 0.6.1
- Doc comments, Notion style: each paragraph's comments are one card level with it, instead of a stack at the top. Commented words are highlighted, a paragraph with comments is tinted and carries a bubble with its count, and clicking words, bubble or card lights the pair up and lines the card up with its words. Reply on a card; a new comment opens beside its paragraph.

## 0.6.0
- ⌘-click a name in a PR to see where it is defined and who uses it, in a peek over the code. It searches the PR's files and the repo at the PR's head (the working tree when that commit is not fetched). A place in the PR's diff scrolls the PR there; anything else opens in the peek. ⌘-click inside the peek to go further; Back or ⌘[ returns; Esc closes. Mac only: the phone link never reads files outside the PR.

## 0.5.2
- A chapter is at most 6 files and 12 hunks. `dak chapters check` and `dak send` refuse a bigger one unless it says why: `"big_why"` on the chapter, or `--allow-big "why"`. The reason shows on the chapter as "Why so big". Concept chapters are exempt.

## 0.5.1
- Settings, Reviewing: the Fold test files row was cut to "Fo..."; it now reads in full.

## 0.5.0
- Topics in a list beside the conversation, like a chat history: grouped Waiting on you, In progress and Done (folded), with search by words, PR number or ticket. One click shows that topic alone, highlighted in the list; one opened from the merge queue is selected and scrolled into view. It replaces the previous and next arrows and the All topics timeline on the Mac (the phone keeps them).
- The list hides with the toolbar button or T, and while a review is expanded.

## 0.4.1
- The reply button says Send (or Approve) and never runs off a narrow conversation column; the verdict menu names the verdict.
- A Markdown file in a PR stays inside the pane: a long code block scrolls in place instead of pushing the file header and Reviewed off screen.
- Settings, Reviewing: "Fold test files". .test, .spec and __tests__ files open folded in every PR, marked Test; Show opens one.
- Opening a topic from the merge queue or Waiting on you goes to that topic, even with all topics in one timeline; the topic you are on is highlighted and labelled.
- Moving between topics keeps the side pane closed if you closed it.

## 0.4.0
From a day of Atlas coordinating ten engineers:
- `dak route set <person> --from-group <group> --via <agent>`: a group's PRs and briefs to the person go to the agent first, with a note. Replies, notes and questions are not routed.
- `dak queue set <pr|thread> --rework "why"`: greyed out below the rest, skipped by `queue next`, back by itself with the next version.
- A `parked` state: open but parked by the person's choice, out of the review count until `dak queue unpark`.
- `--confirmed-by` on `dak queue priority` too, and it accepts what the person wrote ("can you move them lower?"), quoting it in the output.
- `dak thread --pr <n>`; `dak send --json` returns `thread_id`.
- The queue says when a PR's head moved after the approval, and whether it is a rebase only or the changes differ.
- `--range base..head` on send, add and reply: a reviewer runner reviews only a stacked PR's own commits.
- A read-only sandbox's inbox check exits quietly instead of failing on SQLITE_READONLY.
- Reviewer workspaces (temp folders, `wt-NNNN`) are hidden from `dak agents`; `--all` shows them.
- `--type tryit --ticket REVA-123`: Works / Something's wrong; Works comes back with the ticket to close.

## 0.3.10
- Phone: an open file now replaces the page instead of floating over it, so nothing on it is a fixed layer. iPhone still sent a tap on the floating sheet's X to Mark reviewed on some files. Closing puts the page back where it was.

## 0.3.9
- A chapter's Proof is its own row (Why, Needs care, Proof, People notice), not run on inside Needs care. The phone shows it too.

## 0.3.8
- Phone: the file sheet's close button closes it. The sheet was inside the scrolling page, and on iPhone that sent its taps to the wrong place (the X hit Mark reviewed). It now sits beside the page, and the X is a full-size target.

## 0.3.7
- Phone: a file's Reviewed is now a large button in the sheet's bar under the chapter title. The small box in the pinned file header did not take taps on iPhone.

## 0.3.6
- Phone PR view: Overview and Chapters (the separate Diff tab is gone); the page scrolls, and keeps its place when a file sheet closes; Start reading and the risk rows go to that chapter; the Ask button opens on the first tap; no zooming in the home-screen app.

## 0.3.5
- `--confirmed-by <thread>` on `dak queue order` and `review-order`: an order the person approved with a button on that thread is applied as theirs, over rows they placed by hand. Dak checks the pick itself.

## 0.3.4
- Fixed: 0.3.3 broke every send and reply (a new column the session record did not name).
- One outside key can speak for several bots (Grok's Orbit and the rest): each sends with "from": "<name>", keeps that name, and replies to any of them come back on the key.

## 0.3.3
- Sessions show by their own Claude Code title ("Team engineer (M21, M11a)") instead of the folder-and-code name, everywhere in the app; Dak remembers the last title after a session closes. Search finds them by title, and `dak agents` prints it.

## 0.3.2
- Remote agents set the same things the agents on the Mac do: type, blocks, tier and reason, cost, FYI and done on /x/send and /x/reply, and PUT /x/priority/<thread> to change them; their instructions list every field.

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
