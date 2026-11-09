// The MCP tools: what an AI assistant can do with a Sidenote account. Shared by the local
// (stdio) server and the hosted connector.

import { SidenoteError, ACCENTS } from './client.js';
import { toMarkdown, toHTML, textOf } from './md.js';
import { parseBoard, serializeBoard, describeBoard, itemData, applyEdits, COLORS } from './board.js';
import { putImage, getImage, refs, isImgKey, SOURCE_MAX } from './media.js';
import { prepImage } from './shrink.js';

export const INSTRUCTIONS = `Sidenote is a notes app (a Chrome side panel). Notes are "notepads"; a notepad can have subpads. Every tool that takes a notepad accepts its id or its title.
Content is Markdown, one block per line (each line is its own paragraph). Besides the usual headings (# to ###), **bold**, _italic_, ~~strike~~, \`code\`, [links](https://…), lists, "- [ ]" to-dos, > quotes, tables, --- and \`\`\` code blocks, Sidenote adds:
==highlight==, <u>underline</u>, [Title](sidenote:<id>) to link another notepad, <details><summary>Toggle</summary> … </details> for a toggle (Markdown inside), "## Heading <!--fold-->" for a folded heading, a line with only <br> for an empty line, <time data-at="EPOCH_MS">label</time> for a reminder and <span data-m="person|place">Name</span> for a mention.
To change part of a notepad, prefer edit_notepad (find and replace) over rewriting it; when you do rewrite it with update_notepad, pass the revision you read as base_rev.
Images and embeds sit on lines of their own: ![image](sidenote-image:img-…) is an image kept by Sidenote (view_image shows it to you; add_image adds one from a web address or base64 data and shrinks it to a light size), and ![YouTube](https://www.youtube.com/watch?v=…) shows a YouTube video or a Google Drive, Docs, Sheets, Slides or Forms file in a frame (any such link works; write it on its own line).
Whiteboards are notepads that are a free canvas of items instead of text: stickies, text, rectangles, ellipses, diamonds, arrows between items, images, embeds and notepad cards. read_notepad lists their items with ids and positions; change them with edit_whiteboard (add, update, remove); make one with create_notepad and kind "whiteboard".`;

const NOTEPAD = { type: 'string', description: 'The notepad’s id, or its title (exact or a unique part of it).' };
const NUM = { type: 'number' };
const ITEM = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['sticky', 'text', 'rectangle', 'ellipse', 'diamond', 'arrow', 'image', 'embed', 'notepad'], description: 'What to add. A notepad item is a card that opens another notepad.' },
    ref: { type: 'string', description: 'A name for this new item, so an arrow in the same call can point at it.' },
    text: { type: 'string', description: 'For stickies, text and shapes: Sidenote Markdown.' },
    x: NUM, y: NUM, w: NUM, h: NUM,
    color: { type: 'string', description: `${COLORS.join(', ')} or #rrggbb. Stickies default to amber.` },
    size: { type: 'string', enum: ['s', 'm', 'l', 'xl'], description: 'Text items only: s 14 px, m 18 px (default), l 28 px, xl 44 px.' },
    from: { type: 'string', description: 'Arrows: the item it starts at (an id, or a ref from this call).' },
    to: { type: 'string', description: 'Arrows: the item it points to.' },
    image: { type: 'string', description: 'Images: an image key (img-…) from add_image or read_notepad.' },
    url: { type: 'string', description: 'Embeds: a YouTube or Google Drive / Docs / Sheets / Slides / Forms link.' },
    notepad: { type: 'string', description: 'Notepad cards: which notepad (id or title).' },
  },
  required: ['type'],
  additionalProperties: false,
};
const isBoard = (r) => r?.doc?.kind === 'board';
const noText = (r) => new SidenoteError(`“${r.doc.title}” is a whiteboard, not text: read it with read_notepad and change it with edit_whiteboard.`);
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'list_notepads',
    title: 'List notepads',
    description: 'List the notepads in this Sidenote account as a tree (subpads indented), with ids, flags and a short preview. Archived notepads are left out unless asked for.',
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean', description: 'Also list archived notepads.' } }, additionalProperties: false },
    annotations: { title: 'List notepads', ...ro },
  },
  {
    name: 'read_notepad',
    title: 'Read a notepad',
    description: 'Read one notepad: its title, id, revision, parent and subpads, and its content as Sidenote Markdown (or the stored HTML).',
    inputSchema: { type: 'object', properties: { notepad: NOTEPAD, format: { type: 'string', enum: ['markdown', 'html'], description: 'markdown (default) or the stored html.' } }, required: ['notepad'], additionalProperties: false },
    annotations: { title: 'Read a notepad', ...ro },
  },
  {
    name: 'search_notepads',
    title: 'Search notepads',
    description: 'Full-text search across titles and content. Every word must appear (any order, any case). Returns the matching notepads with the lines that matched.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for.' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most notepads to return (default 10).' }, include_archived: { type: 'boolean' } }, required: ['query'], additionalProperties: false },
    annotations: { title: 'Search notepads', ...ro },
  },
  {
    name: 'create_notepad',
    title: 'Create a notepad',
    description: 'Create a new notepad, optionally as a subpad of another. It appears in Sidenote on every synced device within a few seconds of the app being open.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The notepad’s title.' },
        content: { type: 'string', description: 'Content in Sidenote Markdown (see the server instructions).' },
        parent: { type: 'string', description: 'Make it a subpad of this notepad (id or title).' },
        accent: { type: 'string', description: `Accent colour: ${ACCENTS.join(', ')} or #rrggbb. Defaults to the parent’s, or the least-used one.` },
        kind: { type: 'string', enum: ['notepad', 'whiteboard'], description: 'notepad (default) or whiteboard, a free canvas of stickies, shapes, arrows and images.' },
        items: { type: 'array', items: ITEM, description: 'Whiteboards only: items to start with (see edit_whiteboard).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'Create a notepad', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    write: true,
  },
  {
    name: 'update_notepad',
    title: 'Update a notepad',
    description: 'Rename a notepad, change its accent, or write its content: replace all of it (pass base_rev from read_notepad so a newer edit is never overwritten), or add to the end or start.',
    inputSchema: {
      type: 'object',
      properties: {
        notepad: NOTEPAD,
        title: { type: 'string', description: 'New title.' },
        content: { type: 'string', description: 'Content in Sidenote Markdown.' },
        mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'replace (default), append (add after the current content) or prepend.' },
        base_rev: { type: 'integer', description: 'The revision read_notepad reported. With mode replace, the write is refused if the notepad changed since.' },
        accent: { type: 'string', description: `${ACCENTS.join(', ')} or #rrggbb.` },
      },
      required: ['notepad'],
      additionalProperties: false,
    },
    annotations: { title: 'Update a notepad', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    write: true,
  },
  {
    name: 'edit_notepad',
    title: 'Edit text in a notepad',
    description: 'Find and replace text in a notepad’s Markdown, leaving everything else as it is. `find` must match exactly once unless replace_all is set; include a few nearby words to make it unique. Good for ticking a to-do ("- [ ] milk" -> "- [x] milk"), fixing a line, or inserting after a heading.',
    inputSchema: {
      type: 'object',
      properties: {
        notepad: NOTEPAD,
        find: { type: 'string', description: 'Exact text to find, as read_notepad shows it.' },
        replace: { type: 'string', description: 'What to put instead (Markdown).' },
        replace_all: { type: 'boolean', description: 'Replace every match instead of exactly one.' },
      },
      required: ['notepad', 'find', 'replace'],
      additionalProperties: false,
    },
    annotations: { title: 'Edit text in a notepad', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    write: true,
  },
  {
    name: 'edit_whiteboard',
    title: 'Edit a whiteboard',
    description: 'Add, change or remove items on a whiteboard. Positions are board pixels (x right, y down); leave x and y out and new items are laid out in rows under what is there. Give new items a ref so arrows in the same call can connect them. Removing an item also removes arrows attached to it.',
    inputSchema: {
      type: 'object',
      properties: {
        notepad: NOTEPAD,
        add: { type: 'array', items: ITEM, description: 'New items.' },
        update: {
          type: 'array',
          description: 'Changes to existing items, by id (from read_notepad).',
          items: { type: 'object', properties: { id: { type: 'string' }, x: NUM, y: NUM, w: NUM, h: NUM, text: { type: 'string' }, color: { type: 'string' }, size: { type: 'string', enum: ['s', 'm', 'l', 'xl'] }, type: { type: 'string', enum: ['sticky', 'rectangle', 'ellipse', 'diamond'] }, from: { type: 'string' }, to: { type: 'string' } }, required: ['id'], additionalProperties: false },
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Ids of items to remove.' },
      },
      required: ['notepad'],
      additionalProperties: false,
    },
    annotations: { title: 'Edit a whiteboard', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    write: true,
  },
  {
    name: 'add_image',
    title: 'Add an image',
    description: `Add an image to a notepad (on its own line, at the end or after the given text) or to a whiteboard. Give a web address, or base64 data for a small image you made (PNG, JPEG, GIF or WebP, up to ${SOURCE_MAX / 1e6} MB). PNGs and JPEGs are shrunk the way Sidenote shrinks pasted images: at most 1600 px on the longest side, most under 250 KB, phone photos turned upright. GIFs and WebPs are kept as they are, up to 1 MB. It is stored encrypted, like the notes; the answer has its image key.`,
    inputSchema: {
      type: 'object',
      properties: {
        notepad: NOTEPAD,
        url: { type: 'string', description: 'An http(s) address of the image.' },
        data: { type: 'string', description: 'Or the image itself, base64-encoded.' },
        after: { type: 'string', description: 'Notepads: put it after the line containing this text (as read_notepad shows it). Default: at the end.' },
        x: NUM, y: NUM, w: { type: 'number', description: 'Whiteboards: width on the board (default 360, keeping its shape).' },
        size: { type: 'string', enum: ['small', 'medium', 'full'], description: 'Notepads: how wide it shows (default full).' },
      },
      required: ['notepad'],
      additionalProperties: false,
    },
    annotations: { title: 'Add an image', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    write: true,
  },
  {
    name: 'view_image',
    title: 'View an image',
    description: 'See an image from a notepad or whiteboard: give its key (img-…, as in sidenote-image:img-… in read_notepad).',
    inputSchema: { type: 'object', properties: { image: { type: 'string', description: 'The image key, img-…' } }, required: ['image'], additionalProperties: false },
    annotations: { title: 'View an image', ...ro },
  },
  {
    name: 'organize_notepad',
    title: 'Star or archive a notepad',
    description: 'Star or unstar, archive or unarchive a notepad (archiving hides it and its subpads; nothing is deleted).',
    inputSchema: { type: 'object', properties: { notepad: NOTEPAD, starred: { type: 'boolean' }, archived: { type: 'boolean' } }, required: ['notepad'], additionalProperties: false },
    annotations: { title: 'Star or archive a notepad', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    write: true,
  },
];

export const toolList = (readOnly) => TOOLS.filter((t) => !(readOnly && t.write)).map(({ write, ...t }) => t);

const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown');
const preview = (html, n = 90) => { const t = textOf(html || '').replace(/\n/g, ' · '); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const flags = (a, r) => [isBoard(r) && 'whiteboard', a.isStarred(r.id) && 'starred', a.isArchived(r.id) && 'archived', r.shared && 'shared', r.view && 'view only'].filter(Boolean);
// A notepad's content for an AI: Markdown, or a whiteboard's items.
const body = (a, r) => (isBoard(r) ? describeBoard(r.doc.html, ctxOf(a)) : toMarkdown(r.doc.html));
const ctxOf = (a) => ({ accentOf: (id) => a.get(id)?.doc.accent || null, titleOf: (id) => a.get(id)?.doc.title || null });
const boardCtx = (a) => ({ md: ctxOf(a), resolveNote: (ref) => { try { return a.find(ref).id; } catch { return null; } } });
const ok = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) });
const str = (v, name) => { if (v != null && typeof v !== 'string') throw new SidenoteError(`${name} must be text.`); return v; };

function describe(a, r, md) {
  const d = r.doc, par = d.parent && a.get(d.parent);
  const subs = [...a.recs.values()].filter((x) => x.doc && x.doc.parent === r.id);
  return [
    `Title: ${d.title || 'Untitled'}`,
    `ID: ${r.id} · revision ${r.rev} · updated ${when(d.t)} · accent ${d.accent || 'none'}${flags(a, r).length ? ' · ' + flags(a, r).join(', ') : ''}`,
    par ? `Parent: ${par.doc.title} (id ${par.id})` : null,
    subs.length ? `Subpads: ${subs.map((x) => `${x.doc.title} (id ${x.id})`).join(', ')}` : null,
    '',
    md,
  ].filter((l) => l != null).join('\n');
}

// Every notepad at once, in sidebar order: for a chat link and `sidenote all`. Content past
// `max` characters is left out and named instead.
export function dumpAll(a, { archived = false, max = 500_000 } = {}) {
  const rows = a.list({ archived });
  const hidden = archived ? 0 : a.list({ archived: true }).length - rows.length;
  const pathOf = (r) => { const p = []; for (let x = r, n = 0; x && n < 20; x = x.doc.parent && a.get(x.doc.parent), n++) p.unshift(x.doc.title || 'Untitled'); return p.join(' › '); };
  const out = [`${rows.length} notepad${rows.length === 1 ? '' : 's'}, read ${when(Date.now())}.${hidden ? ` ${hidden} archived not shown.` : ''}`];
  const skipped = [];
  let size = 0;
  for (const { rec: r } of rows) {
    const md = body(a, r) || '(empty)';
    if (size + md.length > max) { skipped.push(r); continue; }
    size += md.length;
    const f = flags(a, r);
    out.push('', `===== ${pathOf(r)} =====`, `id ${r.id} · revision ${r.rev} · updated ${when(r.doc.t)}${f.length ? ' · ' + f.join(', ') : ''}`, '', md);
  }
  if (skipped.length) out.push('', `Too long to include here: ${skipped.map((r) => `${r.doc.title || 'Untitled'} (id ${r.id})`).join(', ')}. Read them one at a time.`);
  return out.join('\n');
}

// ctx: { account: () => Promise<Account> (refreshed), readOnly, image? }. image({ bytes } |
// { url }) -> { bytes, type, w, h, was } fetches and shrinks a picture; the hosted connector
// passes its own (the work is too heavy for an edge function), everything else uses prepImage.
export async function callTool(name, args = {}, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    if (tool.write && ctx.readOnly) throw new SidenoteError('This connection is read-only, so it can’t change notes.');
    const a = await ctx.account();
    return await run(name, args || {}, a, ctx);
  } catch (e) {
    return { content: [{ type: 'text', text: e instanceof SidenoteError ? e.message : `Something went wrong: ${e?.message || e}` }], isError: true };
  }
}

async function run(name, args, a, ctx = {}) {
  switch (name) {
    case 'list_notepads': {
      const rows = a.list({ archived: !!args.include_archived });
      const lines = rows.map(({ rec: r, depth }) => {
        const f = flags(a, r), p = preview(r.doc.html);
        return `${'  '.repeat(depth)}- ${r.doc.title || 'Untitled'} (id ${r.id}${f.length ? ', ' + f.join(', ') : ''})${p ? ' — ' + p : ''}`;
      });
      const text = rows.length ? `${rows.length} notepad${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}` : 'No notepads yet.';
      return ok(text, { notepads: rows.map(({ rec: r, depth }) => ({ id: r.id, title: r.doc.title || 'Untitled', parent: r.doc.parent || null, depth, updated: r.doc.t || null, flags: flags(a, r) })) });
    }
    case 'read_notepad': {
      const r = a.find(str(args.notepad, 'notepad'));
      const text = args.format === 'html' ? r.doc.html || '' : body(a, r);
      const extra = isBoard(r) ? { kind: 'whiteboard', items: parseBoard(r.doc.html).map((it) => itemData(it, ctxOf(a))) } : { images: refs(r.doc.html) };
      return ok(describe(a, r, text || '(empty)'), { id: r.id, title: r.doc.title || 'Untitled', rev: r.rev, parent: r.doc.parent || null, accent: r.doc.accent || null, updated: r.doc.t || null, flags: flags(a, r), format: args.format === 'html' ? 'html' : 'markdown', content: text, ...extra });
    }
    case 'search_notepads': {
      const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw new SidenoteError('Give some words to search for.');
      const limit = Math.min(50, Math.max(1, args.limit | 0 || 10)), hits = [];
      for (const { rec: r } of a.list({ archived: !!args.include_archived })) {
        const title = r.doc.title || 'Untitled', text = textOf(r.doc.html), all = (title + '\n' + text).toLowerCase();
        if (!words.every((w) => all.includes(w))) continue;
        const lines = text.split('\n').filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 4)
          .map((l) => (l.length > 160 ? l.slice(0, 159) + '…' : l));
        hits.push({ r, title, lines, score: words.filter((w) => title.toLowerCase().includes(w)).length * 3 + lines.length });
      }
      hits.sort((x, y) => y.score - x.score || (y.r.doc.t || 0) - (x.r.doc.t || 0));
      const top = hits.slice(0, limit);
      const text = top.length ? `${hits.length} notepad${hits.length === 1 ? '' : 's'} match${hits.length > limit ? `, showing ${limit}` : ''}:\n` + top.map((h) => `- ${h.title} (id ${h.r.id})${h.lines.map((l) => '\n    ' + l).join('')}`).join('\n') : `Nothing matches “${args.query}”.`;
      return ok(text, { results: top.map((h) => ({ id: h.r.id, title: h.title, lines: h.lines })) });
    }
    case 'create_notepad': {
      const title = str(args.title, 'title')?.trim() || 'Untitled';
      const board = args.kind === 'whiteboard';
      if (!board && args.items?.length) throw new SidenoteError('items are for whiteboards: set kind to "whiteboard".');
      if (board && args.content) throw new SidenoteError('A whiteboard has items, not content: pass items (or add them with edit_whiteboard).');
      const html = board ? serializeBoard(applyEdits([], { add: args.items || [] }, boardCtx(a)).items) : args.content ? toHTML(str(args.content, 'content'), ctxOf(a)) : '';
      const r = await a.create({ title, html, parent: str(args.parent, 'parent') || null, accent: str(args.accent, 'accent') || null, kind: board ? 'board' : null });
      const n = board ? parseBoard(r.doc.html).length : 0;
      return ok(`Created ${board ? 'whiteboard' : ''}“${r.doc.title}” (id ${r.id}, revision ${r.rev})${r.doc.parent ? ` under “${a.get(r.doc.parent)?.doc.title}”` : ''}${board ? ` with ${n} item${n === 1 ? '' : 's'}` : ''}. It shows up in Sidenote on the next sync.`.replace('whiteboard“', 'whiteboard “'), { id: r.id, title: r.doc.title, rev: r.rev, kind: board ? 'whiteboard' : 'notepad' });
    }
    case 'update_notepad': {
      const r = a.find(str(args.notepad, 'notepad'));
      const mode = args.mode || 'replace', content = str(args.content, 'content'), title = str(args.title, 'title'), accent = str(args.accent, 'accent');
      if (content == null && title == null && accent == null) throw new SidenoteError('Nothing to change: give content, title or accent.');
      if (accent != null && !(ACCENTS.includes(accent) || /^#[0-9a-f]{6}$/i.test(accent))) throw new SidenoteError(`Accent must be one of ${ACCENTS.join(', ')} or a #rrggbb colour.`);
      if (content != null && isBoard(r)) throw noText(r);
      if (content != null && mode === 'replace' && args.base_rev != null && args.base_rev !== r.rev) throw new SidenoteError(`“${r.doc.title}” changed since revision ${args.base_rev} (it is now revision ${r.rev}). Read it again and redo the change.`);
      const add = content != null ? toHTML(content, ctxOf(a)) : null;
      await a.write(r, (doc) => {
        const next = { ...doc };
        if (title != null) next.title = title.trim().slice(0, 300) || 'Untitled';
        if (accent != null) next.accent = accent;
        if (add != null) {
          const cur = /^(<p><br><\/p>)*$/.test(doc.html || '') ? '' : doc.html || '';
          next.html = mode === 'append' ? cur + add : mode === 'prepend' ? add + cur : add;
          if (!next.html) next.html = '<p><br></p>';
        }
        return next;
      });
      return ok(`Saved “${r.doc.title}” (id ${r.id}, now revision ${r.rev}).`, { id: r.id, rev: r.rev });
    }
    case 'edit_notepad': {
      const r = a.find(str(args.notepad, 'notepad'));
      const find = str(args.find, 'find'), repl = str(args.replace, 'replace') ?? '';
      if (!find) throw new SidenoteError('`find` can’t be empty.');
      if (isBoard(r)) throw noText(r);
      let count = 0;
      await a.write(r, (doc) => {
        const md = toMarkdown(doc.html);
        count = md.split(find).length - 1;
        if (!count) throw new SidenoteError(`Couldn’t find that text in “${doc.title}”. read_notepad shows the exact Markdown to match.`);
        if (count > 1 && !args.replace_all) throw new SidenoteError(`That text appears ${count} times in “${doc.title}”. Include more of the surrounding text, or set replace_all.`);
        const out = args.replace_all ? md.split(find).join(repl) : md.replace(find, () => repl);
        return { ...doc, html: toHTML(out, ctxOf(a)) || '<p><br></p>' };
      });
      return ok(`Replaced ${count === 1 ? 'it' : count + ' matches'} in “${r.doc.title}” (now revision ${r.rev}).`, { id: r.id, rev: r.rev, replaced: count });
    }
    case 'edit_whiteboard': {
      const r = a.find(str(args.notepad, 'notepad'));
      if (!isBoard(r)) throw new SidenoteError(`“${r.doc.title}” is a notepad, not a whiteboard: use edit_notepad or update_notepad.`);
      if (!args.add?.length && !args.update?.length && !args.remove?.length) throw new SidenoteError('Nothing to do: give add, update or remove.');
      let res;
      try {
        await a.write(r, (doc) => { res = applyEdits(parseBoard(doc.html), args, boardCtx(a)); return { ...doc, html: serializeBoard(res.items) }; });
      } catch (e) { throw e instanceof SidenoteError ? e : new SidenoteError(e.message); }
      const parts = [res.added.length && `added ${res.added.length}`, res.updated.length && `changed ${res.updated.length}`, res.removed && `removed ${res.removed}`].filter(Boolean);
      const ids = res.added.map((it) => `${itemData(it).type} ${it.id}${it.b === 'arrow' ? '' : ` at (${it.x}, ${it.y}) ${it.w}×${it.h}`}`);
      const said = parts.join(', ');
      return ok(`${said[0].toUpperCase() + said.slice(1)} on “${r.doc.title}” (now revision ${r.rev}).${ids.length ? '\nNew: ' + ids.join('; ') : ''}`, { id: r.id, rev: r.rev, added: res.added.map((it) => itemData(it, ctxOf(a))), updated: res.updated.map((it) => it.id), removed: res.removed });
    }
    case 'add_image': {
      const r = a.find(str(args.notepad, 'notepad'));
      if (r.view) throw new SidenoteError(`“${r.doc.title}” was shared with you view-only, so it can’t be changed.`);
      let src, im;
      try {
        if (args.data) src = { bytes: Uint8Array.from(atob(String(args.data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0)) };
        else if (args.url) src = { url: str(args.url, 'url') };
        else throw new Error('Give url (a web address of the image) or data (base64).');
        const pic = await (ctx.image || prepImage)(src);
        im = { ...(await putImage(a.send, pic.bytes, pic)), was: pic.was };
      } catch (e) { throw new SidenoteError(e.message === 'The string to be decoded is not correctly encoded.' ? 'data isn’t valid base64.' : e.message); }
      const kb = (n) => Math.max(1, Math.round(n / 1000));
      const sizeNote = `${im.w}×${im.h}, ${kb(im.size)} KB${im.was > im.size * 1.05 ? `, shrunk from ${im.was >= 1e6 ? (im.was / 1e6).toFixed(1) + ' MB' : kb(im.was) + ' KB'}` : ''}`;
      if (isBoard(r)) {
        const w = args.w != null ? Math.max(20, Math.round(+args.w)) : Math.min(im.w || 360, 360), h = im.w && im.h ? Math.round(w * im.h / im.w) : Math.round(w * 0.66);
        const spot = args.x != null && args.y != null ? { x: args.x, y: args.y } : {};
        let res;
        await a.write(r, (doc) => { res = applyEdits(parseBoard(doc.html), { add: [{ type: 'image', image: im.key, w, h, ...spot }] }, boardCtx(a)); return { ...doc, html: serializeBoard(res.items) }; });
        const it = res.added[0];
        return ok(`Added the image (${sizeNote}) to the whiteboard “${r.doc.title}” as image ${it.id} at (${it.x}, ${it.y}) ${it.w}×${it.h}. Image key: ${im.key}.`, { id: r.id, rev: r.rev, image: im.key, item: it.id });
      }
      const sz = { small: ' data-size="s"', medium: ' data-size="m"' }[args.size] || '';
      const fig = `<figure data-img="${im.key}"${im.w && im.h ? ` data-w="${im.w}" data-h="${im.h}"` : ''}${sz}></figure>`;
      const after = str(args.after, 'after');
      await a.write(r, (doc) => {
        const cur = /^(<p><br><\/p>)*$/.test(doc.html || '') ? '' : doc.html || '';
        if (!after) return { ...doc, html: cur + fig };
        const md = toMarkdown(cur), i = md.indexOf(after);
        if (i < 0) throw new SidenoteError(`Couldn’t find “${after}” in “${doc.title}”. read_notepad shows the exact text.`);
        const end = md.indexOf('\n', i + after.length);
        const line = toMarkdown(fig);
        return { ...doc, html: toHTML(end < 0 ? md + '\n\n' + line : md.slice(0, end) + '\n\n' + line + '\n\n' + md.slice(end + 1), ctxOf(a)) };
      });
      return ok(`Added the image (${sizeNote}) to “${r.doc.title}” (now revision ${r.rev}). In its Markdown it is: ${toMarkdown(fig)}`, { id: r.id, rev: r.rev, image: im.key });
    }
    case 'view_image': {
      const key = str(args.image, 'image')?.trim().replace(/^sidenote-image:/, '');
      if (!isImgKey(key)) throw new SidenoteError('That isn’t an image key: they look like img-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx (read_notepad shows them as sidenote-image:img-…).');
      const im = await getImage(a.send, key);
      if (!im) throw new SidenoteError('No image under that key yet. If it was just added in Sidenote, it goes up when that notepad syncs; try again in a moment.');
      let bin = ''; for (let i = 0; i < im.bytes.length; i += 0x8000) bin += String.fromCharCode(...im.bytes.subarray(i, i + 0x8000));
      return { content: [{ type: 'text', text: `Image ${key} (${im.type}, ${Math.max(1, Math.round(im.bytes.length / 1000))} KB).` }, { type: 'image', data: btoa(bin), mimeType: im.type }] };
    }
    case 'organize_notepad': {
      const r = a.find(str(args.notepad, 'notepad'));
      if (args.starred == null && args.archived == null) throw new SidenoteError('Say starred and/or archived.');
      await a.setFlags(r, { starred: args.starred, archived: args.archived });
      const f = flags(a, r);
      return ok(`“${r.doc.title}” is now ${f.length ? f.join(', ') : 'neither starred nor archived'}.`);
    }
  }
}
