---
name: sidenote
description: Work with the user's Sidenote notepads (notes in the Sidenote Chrome side panel) through the sidenote MCP tools. Use when the user mentions Sidenote, their notepads or notes in Sidenote, or asks to save, find, update, tick off or organise something in their notes.
---

# Sidenote notepads

The `sidenote` tools read and write the user's synced Sidenote account. Changes show up in
Sidenote on every synced computer within seconds of it being open.

## Finding a notepad
- `list_notepads` shows the tree (subpads indented) with ids. `search_notepads` does full-text search.
- Every other tool takes a notepad's id or its title. If a title is ambiguous, the error lists the ids; use one.

## Changing a notepad
- Small change (tick a to-do, fix a line, add a line under a heading): `read_notepad`, then `edit_notepad`
  with the exact text to find. Everything else in the note stays untouched.
- Adding to the end or start: `update_notepad` with `mode: "append"` or `"prepend"`.
- Rewriting a whole notepad: `update_notepad` with `mode: "replace"` and `base_rev` set to the revision
  `read_notepad` reported, so a newer edit by the user is never overwritten.
- New notepad: `create_notepad` (pass `parent` to make a subpad). Star or archive with `organize_notepad`.
  There is no delete tool: archive instead, and tell the user they can delete from Sidenote.

## Images, videos and whiteboards
- An image is a line `![image](sidenote-image:img-…)`; `view_image` with its key shows it to you. `add_image`
  adds one from a web address or base64 data (PNG, JPEG, GIF or WebP, up to 15 MB;
  PNGs and JPEGs are shrunk to at most 1600 px, most under 250 KB).
- A line `![YouTube](https://…)` with a YouTube or Google Drive / Docs / Sheets / Slides / Forms link shows
  it in a frame. Write it on its own line.
- Whiteboards (flagged "whiteboard") are a canvas, not text: `read_notepad` lists items with ids and
  positions (board pixels, x right, y down). Change them with `edit_whiteboard`: `add` (stickies, text,
  rectangles, ellipses, diamonds, arrows, images, embeds, notepad cards; give a `ref` so an arrow in the same
  call can connect new items), `update` by id, `remove` by id. Leave out x/y to have new items laid out in
  rows. Make one with `create_notepad` and `kind: "whiteboard"`.

## Sidenote Markdown
Each line is its own paragraph; blank lines only separate blocks. Headings `#`–`###`, `**bold**`,
`_italic_`, `~~strike~~`, `` `code` ``, links, `-`/`1.` lists (indent to nest), `- [ ]`/`- [x]` to-dos,
`>` quotes, tables, `---`, fenced code. Sidenote extras:
- `==highlight==`, `<u>underline</u>`, `<font size="5">bigger text</font>` (sizes 1 to 7, 3 is normal)
- `[Title](sidenote:<id>)` links to another notepad
- `<details><summary>Toggle</summary>` … `</details>` is a toggle (Markdown inside)
- `## Heading <!--fold-->` is a folded heading; a line with only `<br>` is an empty line
- `<time data-at="EPOCH_MS">label</time>` is a reminder (Sidenote notifies at that time)
- `<span data-m="person">Name</span>` / `data-m="place"` is a mention

Keep these as they are when editing around them. Match the user's existing style (to-dos vs bullets,
heading levels) when adding to a notepad.
