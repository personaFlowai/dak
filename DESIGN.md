---
name: Dak
description: A Mac mail client for agent work, where agents send PRs and documents for review and get the answer back on the same thread.
colors:
  petrol: "#1f6f8b"
  petrol-hover: "#185c74"
  petrol-text: "#1a6580"
  petrol-tint: "rgba(31,111,139,.08)"
  petrol-tint-strong: "rgba(31,111,139,.15)"
  post-yellow: "#f2b705"
  window: "#ffffff"
  sidebar: "#f3f3f3"
  panel: "#fafafa"
  ink: "#1d1d1f"
  ink-secondary: "#48484d"
  ink-tertiary: "#86868b"
  ink-quaternary: "#b0b0b5"
  hairline: "rgba(0,0,0,.1)"
  hairline-soft: "rgba(0,0,0,.06)"
  hover-wash: "rgba(0,0,0,.045)"
  press-wash: "rgba(0,0,0,.075)"
  selection-grey: "rgba(0,0,0,.075)"
  added-green: "#1f7a3f"
  added-bg: "rgba(31,122,63,.08)"
  removed-red: "#b42318"
  removed-bg: "rgba(180,35,24,.07)"
  caution-amber: "#9a5b00"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.35
  body-reading:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.62
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    lineHeight: 1.3
  code:
    fontFamily: "ui-monospace, \"SF Mono\", Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  xs: "4px"
  sm: "5px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  full: "50%"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "22px"
  3xl: "28px"
  4xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.petrol}"
    textColor: "{colors.window}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.petrol-hover}"
  button-push:
    backgroundColor: "{colors.window}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-push-hover:
    backgroundColor: "{colors.panel}"
  icon-button:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    width: "30px"
    height: "28px"
  source-list-row:
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  source-list-row-selected:
    backgroundColor: "{colors.selection-grey}"
  chip:
    backgroundColor: "{colors.hairline-soft}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    padding: "0 9px"
    height: "24px"
  chip-on:
    backgroundColor: "{colors.petrol-tint}"
    textColor: "{colors.petrol-text}"
  input:
    backgroundColor: "{colors.window}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 9px"
  agent-mark:
    backgroundColor: "{colors.hairline-soft}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    size: "28px"
  agent-mark-small:
    backgroundColor: "{colors.hairline-soft}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    size: "18px"
  composer:
    backgroundColor: "{colors.window}"
    rounded: "{rounded.xl}"
    padding: "8px"
  comment-card:
    backgroundColor: "{colors.window}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "9px 11px"
  comment-card-draft:
    backgroundColor: "{colors.petrol-tint}"
  chapter-step-on:
    backgroundColor: "{colors.petrol-tint}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
---

# Design System: Dak

## Overview

**Creative North Star: "The Post Office on the Desktop"**

Dak is a macOS mail client whose post is agent work. It is built to disappear into the system it runs on: a translucent source-list sidebar, a 52px unified toolbar with the traffic lights centred in it, San Francisco type, neutral greys, and hairlines instead of cards. Nothing about it reads as a web dashboard. The agent's explanation and the conversation sit beside the thing under review, and the reading surface stays quiet so the PR or the document is what you look at.

The one loud thing is petrol, a deep blue-green, and it is rationed. It marks the primary action, the current selection inside the content, and what is waiting on you. Everything else is ink on grey. Red is not an accent at all; it appears only to mean danger. The post-office identity lives in the name (डाक, "the post") and in the app icon, a petrol pillar box with a letter going into its slot; the screens themselves carry no stamps, textures or postal decoration.

Density is a Mac app's, not a website's: a 13px base, 28px controls, 6px corners, tight rows. Reading surfaces open up (14 to 14.5px at 1.6 line height in a 700 to 720px column) because reading is the job. Light and dark follow the system appearance through one set of tokens.

**Key Characteristics:**
- Native shell first: hidden title, full-size content, translucent sidebar material, native menus, Dock badge, menu bar count, notifications.
- One accent, rationed: petrol for the primary action, in-content selection and "waiting on you". Red only for danger.
- One ink for every agent: a tool logo or an initial, never a per-agent colour.
- Hairlines and tonal washes for structure; shadows only on things that float.
- System type only: SF Pro for UI and reading, SF Mono for code.
- One icon family (Phosphor regular) and real tool logos from Simple Icons, all in currentColor.

## Colors

A neutral Apple grey palette with one rationed accent: petrol, plus functional diff green and red, a danger red for high risk and changes requested, and a single amber for caution. Every value has a dark counterpart under `prefers-color-scheme: dark` (recorded in the sidecar); the dark accent lifts to a brighter petrol so it holds contrast on near-black.

### Primary
- **Petrol** (`petrol`): fill of the one primary button in any view (Send, Approve, Request changes, Add comment, Start reading, Next chapter, Ask), the unread dot, the selected tab's underline, the left rule on a commented paragraph, the spinner's leading arc, and the colour behind focus rings and resize handles (mixed toward transparent).
- **Petrol Hover** (`petrol-hover`): primary button hover only.
- **Petrol Text** (`petrol-text`): petrol used as text, a shade darker than the fill for contrast. Links, "Waiting on you" in the toolbar, the unread row's time, an active chip's label, hover on a line number or a key-change title.
- **Petrol Tint** (`petrol-tint`, `petrol-tint-strong`): the selection wash inside content. The current chapter in the PR rail, a selected diff line range (strong tint on its line numbers), an open paragraph in a document, highlighted quoted words, text selection in a document, a picked agent, an active chip, an unsent draft comment, the input focus halo.

### Tertiary
- **Post Yellow** (`post-yellow`): the stamp on the letter in the app icon, and the frame in the browser favicon. It appears nowhere in the interface.

### Neutral
- **Window** (`window`): main content background, push buttons, inputs, cards, composer.
- **Sidebar** (`sidebar`): sidebar background in a browser. In the Mac app the sidebar is transparent and the window's sidebar material shows through.
- **Panel** (`panel`): conversation pane background, diff hunk headers, push-button hover, paragraph hover in a document.
- **Ink** (`ink`, `ink-secondary`, `ink-tertiary`, `ink-quaternary`): four text levels. Primary text; secondary text and icons; metadata, timestamps, section labels and placeholders; diff line numbers.
- **Hairline** (`hairline`, `hairline-soft`): 1px borders. The stronger one separates panes and outlines fields; the soft one divides rows, lists and files, and doubles as the fill for chips, inline code, agent marks and the segmented control track.
- **Washes** (`hover-wash`, `press-wash`, `selection-grey`): translucent black (white in dark) laid over any surface for hover, press and native selection in the sidebar.

### Functional
- **Added Green / Removed Red** (`added-green`, `added-bg`, `removed-red`, `removed-bg`): diff rows, `+n −n` counts, a read chapter's check, an approved status ("answered"), and the Live label beside a listening agent. Removed red is never used as an accent; "Changes requested" and high risk use the danger red (`--danger-text`).
- **Caution Amber** (`caution-amber`): "Needs care" risk only.
- **Syntax**: an Xcode-like set of seven hues for keywords, strings, comments (italic), functions, numbers, types and attributes, each with a dark variant. Confined to code.

### Named Rules
**The Rationed Accent Rule.** Petrol means one of three things: this is the primary action, this is what you have selected inside the content, or this is waiting on you. One petrol-filled button per view. If petrol is doing something else, it is wrong.

**The Native Selection Rule.** The sidebar selects like a Mac source list, in neutral grey (`selection-grey`). Petrol tint is for selection inside the reading surface (a chapter, a line range, a paragraph, a pick), where it ties the selection to what you are commenting on.

**The One Ink Rule.** Agents never get colours of their own. Every agent is drawn in `ink-secondary` on `hairline-soft`, distinguished by its tool's logo or its initial.

## Typography

**Display Font:** SF Pro via `-apple-system` (with BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui)
**Body Font:** the same system stack
**Label/Mono Font:** SF Mono via `ui-monospace` (with Menlo)

**Character:** The system's own voice. No brand typeface; hierarchy comes from size steps of half a pixel to a few pixels and from weight (400, 500, 600, one 700), as in Mail and Xcode.

### Hierarchy
- **Display** (700, 22px, 1.3, -0.012em): a document's title only. Balanced wrapping.
- **Headline** (600, 20px, 1.3, -0.01em): a PR overview's title. Balanced wrapping.
- **Title** (600, 17px, 1.35): a chapter's title beside its large number. Document h2 is 16.5px/600, document h3 14.5px/600, a settings section heading 15px/600.
- **Body, reading** (400, 14.5px, 1.62): document paragraphs and list items, in a column of at most 700px. PR overview prose is 14px/1.6 in a 720px column; chapter summaries 13.5px/1.55 capped at 70ch.
- **Body** (400, 13px, 1.45): the base for the whole interface: rows, buttons, inputs, messages (13px/1.55 for message prose), comment bodies.
- **Secondary** (400, 11.5 to 12.5px): toolbar subtitles, thread metadata, hints, timestamps (tabular figures).
- **Label** (600, 11 to 12px, sentence case, `ink-tertiary`): sidebar group names ("Agents"), rail labels ("Chapters"), overview and chapter section headings ("Why", "Risk", "What to review"), field labels (12px, `ink-secondary`). Never uppercase, never tracked.
- **Code** (400, 12px, 1.7, SF Mono): diff tables and file paths (500 weight for paths). Inline code is 11.5 to 12.5px on a `hairline-soft` fill.

### Named Rules
**The System Voice Rule.** Only the system stacks. No web font is loaded, and none should be.

**The Sentence Case Rule.** Every label, button and heading is sentence case. No uppercase labels, no letter-spaced small caps.

## Layout

The window is a CSS grid that mirrors a Mac app: **sidebar | main**, and inside main a 52px **toolbar** over the content.

- **Sidebar** (264px default): a compose button at the top right of the toolbar strip (84px left inset in the app, clearing the traffic lights), an Inbox heading with its unread count, one row per agent (name, role, the topic waiting on you, how many are waiting), and Settings pinned at the foot. ⌘\ hides it; the column collapses to zero. In focus mode the sidebar starts hidden and the same button shows it.
- **Conversation**: one per agent. Each thread with that agent is a topic in one timeline, opened by a divider (kind icon, short name, state); the topic you are replying on has a red edge, and a closed topic folds to its divider. The composer's "Replying on" menu picks the topic when there is more than one open, and takes the typed text with it. A card from another topic opens beside the chat and moves the reply to that topic.
- **Toolbar** (52px, `--toolbar`): sidebar toggle, a two-line title (13px/600 subject over an 11.5px "from to" line), and status plus tools on the right. It has a hairline bottom border.
- **Thread with a PR or document**: a **conversation pane** (340px) on the left, the **review pane** on the right.
  - **PR**: a **reading-order rail** (232px) of Overview then numbered chapters, and the **reading** to its right (overview at 720px max, chapters at 900px max header, full-width diff tables).
  - **Document**: one **reading column** (700px max, padding 32px 44px 64px 40px) centred in the space, and a **comment margin** (280px) that stays in view while you scroll.
- **Thread that is just a note**: the conversation alone, centred at 760px.
- **Forms** (new message, settings): one 640px column, 28px padding, 18px gaps.

Every pane divider can be dragged (a 7px hit area with a 1px line that turns red on hover) and double-clicked to reset.

Spacing runs on a 2/4/6/8/12/16 base with larger reading steps (18, 22, 28, 32px). Rows are 28px; list items use 8px padding; sections in a reading view sit 22px apart.

**Responsive:** below 1100px the conversation pane narrows to 300px, the rail to 196px, and the document margin drops below the text. Below 760px (browser fallback) the sidebar and rail hide, the conversation stacks above the review at up to 40vh, and resize handles disappear. The Mac window's minimum is 900 × 600 (default 1440 × 900).

### Named Rules
**The Beside Rule.** The conversation sits beside the thing under review, never above it or in a modal. At desktop widths both are always visible.

### Native shell

The page is drawn inside an AppKit window and behaves as part of it.
- **Window:** titled, full-size content view, title hidden, title bar transparent; the web view draws no background of its own.
- **Material:** an `NSVisualEffectView` with the sidebar material, blending behind the window and following the window's active state. The page's sidebar is transparent so the desktop shows through, as in Mail and Finder; the main column paints `window`.
- **Traffic lights:** re-placed on every resize and after full screen, vertically centred in the 52pt toolbar, 20pt from the left and 20pt apart. The page insets the sidebar's top strip (or the toolbar, when the sidebar is hidden) by 84px to clear them.
- **Dragging:** the toolbar band drags the window, except where the page reports its controls.
- **System surfaces:** a native menu bar (Settings… ⌘,, New Message ⌘N, Edit, Window), a menu bar item with the unread count and a "Waiting on you" menu, a Dock badge, and system notifications titled "Agent · kind".

## Elevation & Depth

Flat by default. Structure comes from hairlines, from tonal steps between window, panel and sidebar, and from the native window material behind a transparent sidebar. Shadows appear only on things that float above the reading: the composer, an open comment editor, the selection popover and the toast.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px -12px rgba(0,0,0,.18)`; dark `0 1px 2px rgba(0,0,0,.3), 0 10px 28px -12px rgba(0,0,0,.6)`): composer, editing comment card, selection popover, toast. Always paired with a 0.5px hairline ring.
- **Push button** (`box-shadow: 0 0 0 .5px var(--line), 0 1px 1.5px rgba(0,0,0,.08)`): AppKit-style push buttons, the verdict pop-up, the selected segment.
- **Primary button** (`box-shadow: 0 1px 1.5px rgba(0,0,0,.15)`): the red button, no ring.
- **Ring only** (`box-shadow: 0 0 0 .5px var(--line)`): a sent comment card inside a diff.

The one blur in the interface is the sticky file bar in a diff (`window` at 92% with a 12px backdrop blur), so code scrolls under the path.

### Named Rules
**The Hairlines Not Cards Rule.** Lists, threads, settings and document comments are rows divided by hairlines. A box with a shadow means it floats; nothing that sits in the flow gets one.

## Shapes

Small, consistent Mac corners. Inline code and highlights 4px (2px for a highlighted quote); the inner segment of a segmented control and the small agent mark 5px; buttons, rows, inputs, chips, icon buttons and the medium agent mark 6px; thread items and the segmented track 7px; cards, pickers, option groups, media and code blocks 8px; the selection popover 9px; the composer and toast 10px. Chapter numbers and the unread dot are circles. Borders are 1px hairlines, except the 0.5px rings on push buttons and floating surfaces and a 2px underline on the selected tab.

The app icon follows the macOS grid: an 824pt rounded square (185pt radius) on a 1024 canvas with a soft drop shadow, filled with a pale sky gradient so the red carries. On it stands an India Post pillar box drawn as a lit cylinder in India Post red (lighter on the left, darker at the edges) on a two-tier dark-red plinth, with a domed cap and knob, an outlined door with a keyhole, a cream collection plate, and a cream letter with a post-yellow stamp tilting into the slot. The browser favicon is simpler: a red 7px-radius square with a thin post-yellow frame.

## Components

### Buttons
Native push buttons, not web buttons.
- **Shape:** 6px corners, 28px tall, 12px side padding, 13px/500 text, 6px gap to a 14px icon.
- **Primary:** India Post red fill, white text, darker red on hover. One per view.
- **Push (default):** window fill with a 0.5px hairline ring and a 1px soft shadow; panel fill on hover; press wash when held. Disabled is 45% opacity.
- **Icon button:** 30 × 28px, 17px icon in `ink-secondary`; hover wash and ink on hover.
- **Link button:** `ink-tertiary` 12px text that turns red on hover (Delete, Clear, Remove).
- **Focus:** a 3px ring of red mixed 40% toward transparent, 1px offset, on every focusable element.

### Segmented control
- **Style:** a `hairline-soft` track with 2px padding and 7px corners; segments 24px tall (20px small), 5px corners, `ink-secondary` text.
- **State:** the chosen segment lifts to window fill with a push-button ring and 500 weight. Used for Changes / Whole file in each diff and for choices in the new-message form.

### Verdict pop-up
A native-looking pop-up menu beside Send, styled as a push button with a drawn chevron. It starts on "Comment" (nothing is approved by accident). Choosing Request changes turns its text red; the Send button relabels to the verdict.

### Chips
- **Style:** 24px tall, 6px corners, `hairline-soft` fill, `ink-secondary` 12px text, 13px icon. Used for attachments in a message (PR with its `+n −n`, document with its version, link, file) and for suggested questions in the Ask pane.
- **State:** the attachment open in the review pane is on: red tint fill, red text.

### Inputs / Fields
- **Style:** 1px hairline border, 6px corners, window fill, 6px 9px padding, 13px text.
- **Focus:** border shifts toward red (55%) with a 3px red-tint halo.
- **Error:** removed-red 12.5px text beside the control. Field labels are 12px/600 `ink-secondary`; "optional" is 400 `ink-tertiary`.
- **Composer:** a floating 10px-corner box at the foot of the conversation, borderless textarea (56px minimum) over a row of verdict pop-up, optional GitHub checkbox, a one-line status, and the red Send button. ⌘↩ sends.

### Navigation (sidebar)
- **Mailbox rows:** 28px, 6px corners, 16px `ink-secondary` icon, label, tabular count in `ink-tertiary`. Hover wash; the current row is `selection-grey` at 500 weight.
- **Agent rows:** the small agent mark, name, and a one-line role in 11px `ink-tertiary`. A listening agent shows "Live" in green.
- **Thread items:** 7px corners, 8px padding. Top line: mark, sender (500, `ink-secondary`), time. Subject in 13px, clamped to two lines. Third line: kind and state ("Pull request · Waiting on you"). **Unread:** sender and subject go to 600 ink, the time turns red, and a 7px red dot leads the top line.

### Agent mark
The signature identity rule. A rounded square (28px at 6px corners, or 18px at 5px) filled `hairline-soft`, holding the agent's tool logo at 62% size in `ink-secondary`, or its initial in 600 weight when there is no logo (you are "Y"). Claude and Cursor use Simple Icons paths; GitHub and the shell use Phosphor; Grok falls back to its initial.

### Tabs
Conversation and Ask sit as text tabs over the conversation pane: 12.5px `ink-tertiary`, the selected one 600 ink with a 2px red underline.

### PR reading rail and chapters
- **Rail steps:** a 20px circular number (1px hairline inset ring) beside the chapter title and a line of risk label plus `+n −n`. Hover wash; the current step is red tint with a 600 title and a darker ring; a read chapter shows a green check in a green ring. A "Chapters 2/4 read" label sits above.
- **Overview:** headline, a metadata line, then Why, What it does, Where to look and Risk sections, each under a small grey label. Risk rows name the level ("Low risk" in `ink-tertiary`, "Needs care" in amber, "High risk" in red) and the reason. A red "Start reading" button ends it.
- **Chapter:** a 26px number, the title and summary, the risk reason, and "What to review" key changes that jump to a line. A footer holds Mark as read and a red Next button.

### Diff
A full-width SF Mono table at 12px/1.7. Line numbers in `ink-quaternary` are buttons that select a line or range (red on hover). Added rows on a green wash with stronger green behind their numbers; removed rows the same in removed red. Hunk headers on panel fill. A selected range takes the red tint; a jumped-to line flashes the strong red tint for 1.4s. Comments, drafts and the selection bar (Comment, Ask, Clear) open as rows directly under the last line they cover. The file bar is sticky and blurred.

### Comment cards
- **In a diff:** 8px corners, 9px 11px padding, window fill with a 0.5px ring, a small mark, author and anchor, then the body. A draft is red tint with "not sent yet". An editing card floats with the Float shadow and holds Cancel and a red Add comment.
- **In a document margin:** the same content as a list, not cards: no fill, no corners, divided by soft hairlines; only the open editor floats.

### Document blocks
Each paragraph is a block with a 10px bleed. Hover washes it in panel grey and reveals a comment button in the right gutter; an open block takes the red tint; a block with comments carries a 1px red rule in the left gutter. Selected words raise a floating popover with Comment (red) and Ask, and become a red-tint highlight once commented.

### Settings rows
Option groups are 8px-corner bordered lists with soft hairlines between rows: a radio (red accent colour), the tool mark, name and command line, and an optional model field. Unavailable options drop to 55% opacity.

## Do's and Don'ts

### Do:
- **Do** keep exactly one red-filled button per view, on the action that sends or advances.
- **Do** draw every agent with the agent mark: tool logo or initial, `ink-secondary` on `hairline-soft`.
- **Do** use Phosphor regular icons at 16px (17px in icon buttons, 14px in buttons, 13px in chips), in currentColor.
- **Do** separate rows with 1px hairlines and reserve the Float shadow for the composer, open editors, popovers and toasts.
- **Do** write every label in sentence case and every timestamp and count with tabular figures.
- **Do** give every new colour a dark value in the `prefers-color-scheme: dark` block, and lift red to the brighter dark accent there.
- **Do** keep the conversation beside the review at desktop widths.

### Don't:
- **Don't** give an agent its own colour, coloured avatar or coloured pill.
- **Don't** use India Post red for decoration, success, headings or anything not primary, selected or waiting on you.
- **Don't** use post yellow anywhere in the interface; it lives in the icon.
- **Don't** load a web font or use a non-system face.
- **Don't** wrap list content in shadowed cards or build a dashboard of tiles.
- **Don't** use uppercase or letter-spaced labels.
- **Don't** add a second icon family or brand marks whose licence does not allow it.
