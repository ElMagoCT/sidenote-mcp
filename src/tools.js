// The MCP tools: what an AI assistant can do with a Sidenote account. Shared by the local
// (stdio) server and the hosted connector.

import { SidenoteError, ACCENTS } from './client.js';
import { toMarkdown, toHTML, textOf } from './md.js';

export const INSTRUCTIONS = `Sidenote is a notes app (a Chrome side panel). Notes are "notepads"; a notepad can have subpads. Every tool that takes a notepad accepts its id or its title.
Content is Markdown, one block per line (each line is its own paragraph). Besides the usual headings (# to ###), **bold**, _italic_, ~~strike~~, \`code\`, [links](https://…), lists, "- [ ]" to-dos, > quotes, tables, --- and \`\`\` code blocks, Sidenote adds:
==highlight==, <u>underline</u>, [Title](sidenote:<id>) to link another notepad, <details><summary>Toggle</summary> … </details> for a toggle (Markdown inside), "## Heading <!--fold-->" for a folded heading, a line with only <br> for an empty line, <time data-at="EPOCH_MS">label</time> for a reminder and <span data-m="person|place">Name</span> for a mention.
To change part of a notepad, prefer edit_notepad (find and replace) over rewriting it; when you do rewrite it with update_notepad, pass the revision you read as base_rev.`;

const NOTEPAD = { type: 'string', description: 'The notepad’s id, or its title (exact or a unique part of it).' };
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
const flags = (a, r) => [a.isStarred(r.id) && 'starred', a.isArchived(r.id) && 'archived', r.shared && 'shared', r.view && 'view only'].filter(Boolean);
const ctxOf = (a) => ({ accentOf: (id) => a.get(id)?.doc.accent || null, titleOf: (id) => a.get(id)?.doc.title || null });
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

// ctx: { account: () => Promise<Account> (refreshed), readOnly }
export async function callTool(name, args = {}, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    if (tool.write && ctx.readOnly) throw new SidenoteError('This connection is read-only, so it can’t change notes.');
    const a = await ctx.account();
    return await run(name, args || {}, a);
  } catch (e) {
    return { content: [{ type: 'text', text: e instanceof SidenoteError ? e.message : `Something went wrong: ${e?.message || e}` }], isError: true };
  }
}

async function run(name, args, a) {
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
      const body = args.format === 'html' ? r.doc.html || '' : toMarkdown(r.doc.html);
      return ok(describe(a, r, body || '(empty)'), { id: r.id, title: r.doc.title || 'Untitled', rev: r.rev, parent: r.doc.parent || null, accent: r.doc.accent || null, updated: r.doc.t || null, flags: flags(a, r), format: args.format === 'html' ? 'html' : 'markdown', content: body });
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
      const html = args.content ? toHTML(str(args.content, 'content'), ctxOf(a)) : '';
      const r = await a.create({ title, html, parent: str(args.parent, 'parent') || null, accent: str(args.accent, 'accent') || null });
      return ok(`Created “${r.doc.title}” (id ${r.id}, revision ${r.rev})${r.doc.parent ? ` under “${a.get(r.doc.parent)?.doc.title}”` : ''}. It shows up in Sidenote on the next sync.`, { id: r.id, title: r.doc.title, rev: r.rev });
    }
    case 'update_notepad': {
      const r = a.find(str(args.notepad, 'notepad'));
      const mode = args.mode || 'replace', content = str(args.content, 'content'), title = str(args.title, 'title'), accent = str(args.accent, 'accent');
      if (content == null && title == null && accent == null) throw new SidenoteError('Nothing to change: give content, title or accent.');
      if (accent != null && !(ACCENTS.includes(accent) || /^#[0-9a-f]{6}$/i.test(accent))) throw new SidenoteError(`Accent must be one of ${ACCENTS.join(', ')} or a #rrggbb colour.`);
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
    case 'organize_notepad': {
      const r = a.find(str(args.notepad, 'notepad'));
      if (args.starred == null && args.archived == null) throw new SidenoteError('Say starred and/or archived.');
      await a.setFlags(r, { starred: args.starred, archived: args.archived });
      const f = flags(a, r);
      return ok(`“${r.doc.title}” is now ${f.length ? f.join(', ') : 'neither starred nor archived'}.`);
    }
  }
}
