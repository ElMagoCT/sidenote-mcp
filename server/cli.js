#!/usr/bin/env node
// sidenote: read and edit Sidenote notepads from a terminal. Built for AI agents with a
// shell (Claude Code, Codex, Gemini CLI, Cursor…) as much as for people: one command per
// action, plain-text output, Markdown in and out. Notes are decrypted on this computer.
//
// Download (single file, no install): https://sidenote-sync.netlify.app/sidenote.mjs
// Key: SIDENOTE_KEY, or saved once with `sidenote key sync-…` (~/.config/sidenote/key). A shared
// notepad's pad- or view- key works too, for that notepad and its subpads.

import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openKey, httpTransport, SidenoteError } from '../src/client.js';
import { parseKey } from '../src/keys.js';
import { callTool, dumpAll, INSTRUCTIONS } from '../src/tools.js';
import { VERSION } from '../src/rpc.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const HELP = `sidenote ${VERSION}: read and edit your Sidenote notepads.

Key: set SIDENOTE_KEY, or save it once in your own terminal with  sidenote key sync-…
(Sidenote → Settings → Sync & devices → Show), or a shared notepad's pad- or view- key.
Notes are decrypted on this computer.

  sidenote all [--archived]                every notepad in full (one call, all you need to read)
  sidenote list [--archived]               titles as a tree, with ids
  sidenote read <notepad> [--html]         one notepad as Markdown, with its revision
  sidenote search <words…> [--limit N]     notepads containing every word
  sidenote new <title> [--parent P] [--accent A] [text | -]
  sidenote new <title> --board [items-json | -]   a whiteboard (items as for sidenote board --add)
  sidenote append <notepad> [text]         add to the end (text, or piped in)
  sidenote prepend <notepad> [text]        add to the start
  sidenote write <notepad> [--rev N] [text]   replace everything (refused if changed since --rev)
  sidenote replace <notepad> <find> <with> [--all]   exact find and replace in the Markdown
  sidenote tick <notepad> <item>           tick a to-do (untick to undo); item is part of its text
  sidenote rename <notepad> <title>
  sidenote board <notepad> [json | -]      change a whiteboard: {"add":[…],"update":[…],"remove":[ids]}
  sidenote image <notepad> <file | url> [--after T] [--size small|medium]   add an image (≤1 MB)
  sidenote image-get <img-key> [--out file] save an image from a note to a file
  sidenote star | unstar | archive | unarchive <notepad>
  sidenote key [sync-… | --forget]         save or forget the key for this computer

<notepad> is an id or a title (exact, or a unique part; quote it if it has spaces).
Text comes from the arguments, or from stdin (heredoc or pipe; "-" for new).
Add --json for structured output. SIDENOTE_READ_ONLY=1 refuses every change.

${INSTRUCTIONS}`;

const env = process.env;
const keyFile = () => join(env.XDG_CONFIG_HOME || (process.platform === 'win32' && env.APPDATA) || join(homedir(), '.config'), 'sidenote', 'key');

function parseArgs(argv) {
  const opts = {}, pos = [];
  const valued = new Set(['limit', 'parent', 'accent', 'rev', 'after', 'size', 'out']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (/^--[a-z]/.test(a)) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (valued.has(k)) opts[k] = v ?? argv[++i];
      else opts[k] = true;
    } else pos.push(a);
  }
  return { opts, pos };
}

function json(t) {
  try { return JSON.parse(t); } catch { throw new SidenoteError('That isn’t valid JSON. Example: {"add":[{"type":"sticky","text":"Hi"}]}'); }
}

async function stdinText() {
  if (process.stdin.isTTY) throw new SidenoteError('Give the text as an argument, or pipe it in (for example with a heredoc).');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
}

function readKey() {
  const k = (env.SIDENOTE_KEY || env.SIDENOTE_SYNC_KEY || '').trim();
  if (k) return k;
  try { return readFileSync(keyFile(), 'utf8').trim(); } catch { return ''; }
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { opts, pos } = parseArgs(rest);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'version' || cmd === '--version') return console.log(VERSION);

  if (cmd === 'key') {
    const f = keyFile();
    if (opts.forget) { rmSync(f, { force: true }); return console.log('Forgot the key on this computer.'); }
    if (!pos[0]) {
      const k = readKey();
      return console.log(k ? `A key is set (${k.slice(0, 11)}…). sidenote key --forget removes the saved one.` : 'No key yet. Run: sidenote key sync-… (Sidenote → Settings → Sync & devices → Show).');
    }
    const k = parseKey(pos[0])?.key;
    if (!k) throw new SidenoteError('That isn’t a Sidenote key. It starts with “sync-”, “pad-” or “view-”.');
    const a = await openKey(k, transport()).refresh();
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, k + '\n', { mode: 0o600 });
    try { chmodSync(f, 0o600); } catch {}
    return console.log(`Saved. ${a.list().length} notepads in this account. The key is in ${f}.`);
  }

  const key = readKey();
  if (!key) throw new SidenoteError('No Sidenote key. Set SIDENOTE_KEY, or run: sidenote key sync-… (find it in Sidenote → Settings → Sync & devices → Show).');
  let acct = null;
  const ctx = { readOnly: /^(1|true|yes)$/i.test(env.SIDENOTE_READ_ONLY || ''), account: async () => (acct ||= await openKey(key, transport()).refresh()) };
  const need = (n, what) => { if (pos.length < n) throw new SidenoteError(`Missing ${what}. Run sidenote help.`); };
  const text = async (from) => (pos.length > from ? pos.slice(from).join(' ') : stdinText());

  let res;
  switch (cmd) {
    case 'all': {
      const a = await ctx.account();
      return process.stdout.write(dumpAll(a, { archived: !!opts.archived }) + '\n');
    }
    case 'list': res = await callTool('list_notepads', { include_archived: !!opts.archived }, ctx); break;
    case 'read': need(1, 'the notepad'); res = await callTool('read_notepad', { notepad: pos.join(' '), format: opts.html ? 'html' : 'markdown' }, ctx); break;
    case 'search': need(1, 'words to search for'); res = await callTool('search_notepads', { query: pos.join(' '), limit: opts.limit ? +opts.limit : undefined, include_archived: !!opts.archived }, ctx); break;
    case 'new': {
      need(1, 'a title');
      const content = pos[1] === '-' ? await stdinText() : pos.length > 1 ? pos.slice(1).join(' ') : undefined;
      if (opts.board) { res = await callTool('create_notepad', { title: pos[0], kind: 'whiteboard', items: content ? json(content).add || json(content) : undefined, parent: opts.parent, accent: opts.accent }, ctx); break; }
      res = await callTool('create_notepad', { title: pos[0], content, parent: opts.parent, accent: opts.accent }, ctx);
      break;
    }
    case 'board': {
      need(1, 'the whiteboard');
      const ops = json(await text(1));
      res = await callTool('edit_whiteboard', { notepad: pos[0], add: ops.add, update: ops.update, remove: ops.remove }, ctx);
      break;
    }
    case 'image': {
      need(2, 'the notepad and an image file or web address');
      const src = pos.slice(1).join(' '), args = { notepad: pos[0], after: opts.after, size: opts.size };
      if (/^https?:\/\//i.test(src)) args.url = src;
      else if (existsSync(src)) args.data = readFileSync(src).toString('base64');
      else throw new SidenoteError(`No file “${src}”. Give an image file or an http(s) address.`);
      res = await callTool('add_image', args, ctx);
      break;
    }
    case 'image-get': {
      need(1, 'the image key (img-…)');
      const r = await callTool('view_image', { image: pos[0] }, ctx);
      if (r.isError) { res = r; break; }
      const img = r.content[1], ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[img.mimeType] || 'bin';
      const out = opts.out || `${pos[0].replace(/^sidenote-image:/, '')}.${ext}`;
      writeFileSync(out, Buffer.from(img.data, 'base64'));
      return console.log(`${r.content[0].text} Saved to ${out}.`);
    }
    case 'append': case 'prepend': case 'write': {
      need(1, 'the notepad');
      const args = { notepad: pos[0], content: await text(1), mode: cmd === 'write' ? 'replace' : cmd };
      if (opts.rev != null) args.base_rev = +opts.rev;
      res = await callTool('update_notepad', args, ctx);
      break;
    }
    case 'rename': need(2, 'the notepad and its new title'); res = await callTool('update_notepad', { notepad: pos[0], title: pos.slice(1).join(' ') }, ctx); break;
    case 'replace': need(3, 'the notepad, the text to find and what to put instead'); res = await callTool('edit_notepad', { notepad: pos[0], find: pos[1], replace: pos[2], replace_all: !!opts.all }, ctx); break;
    case 'tick': case 'untick': {
      need(2, 'the notepad and the to-do');
      const r = await callTool('read_notepad', { notepad: pos[0] }, ctx);
      if (r.isError) { res = r; break; }
      const want = pos.slice(1).join(' ').toLowerCase(), from = cmd === 'tick' ? '[ ]' : '[x]', to = cmd === 'tick' ? '[x]' : '[ ]';
      const lines = r.structuredContent.content.split('\n').filter((l) => l.trimStart().startsWith('- ' + from + ' ') && l.toLowerCase().includes(want));
      if (!lines.length) throw new SidenoteError(`No ${cmd === 'tick' ? 'open' : 'ticked'} to-do in “${r.structuredContent.title}” contains “${pos.slice(1).join(' ')}”.`);
      if (new Set(lines).size > 1) throw new SidenoteError(`More than one to-do matches: ${lines.map((l) => l.trim()).join(' | ')}. Use more of its text.`);
      res = await callTool('edit_notepad', { notepad: r.structuredContent.id, find: lines[0], replace: lines[0].replace('- ' + from, '- ' + to), replace_all: true }, ctx);
      break;
    }
    case 'star': case 'unstar': res = await callTool('organize_notepad', { notepad: pos.join(' '), starred: cmd === 'star' }, ctx); break;
    case 'archive': case 'unarchive': res = await callTool('organize_notepad', { notepad: pos.join(' '), archived: cmd === 'archive' }, ctx); break;
    default: throw new SidenoteError(`Unknown command “${cmd}”. Run sidenote help.`);
  }
  if (res.isError) throw new SidenoteError(res.content[0].text);
  console.log(opts.json && res.structuredContent ? JSON.stringify(res.structuredContent, null, 2) : res.content[0].text);
}

const transport = () => httpTransport(env.SIDENOTE_ENDPOINT || undefined);

// The tools' messages name MCP tools; here the same things are commands.
const asCommands = (s) => s.replace(/\bedit_whiteboard\b/g, 'sidenote board').replace(/\badd_image\b/g, 'sidenote image').replace(/\b(list|read|search)_notepads?\b/g, 'sidenote $1').replace(/\bset replace_all\b/, 'add --all').replace(/\bbase_rev\b/g, '--rev');

main().catch((e) => {
  console.error(e instanceof SidenoteError ? asCommands(e.message) : `sidenote: ${e?.stack || e}`);
  process.exit(1);
});
