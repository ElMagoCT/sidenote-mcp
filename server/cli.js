#!/usr/bin/env node
// sidenote: read and edit Sidenote notepads from a terminal. Built for AI agents with a
// shell (Claude Code, Codex, Gemini CLI, Cursor…) as much as for people: one command per
// action, plain-text output, Markdown in and out. Notes are decrypted on this computer.
//
// Download (single file, no install): https://sidenote-sync.netlify.app/sidenote.mjs
// Key: SIDENOTE_KEY, or saved once with `sidenote key sync-…` (~/.config/sidenote/key).

import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, httpTransport, keyFrom, SidenoteError } from '../src/client.js';
import { callTool, dumpAll, INSTRUCTIONS } from '../src/tools.js';
import { VERSION } from '../src/rpc.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const HELP = `sidenote ${VERSION}: read and edit your Sidenote notepads.

Key: set SIDENOTE_KEY, or save it once in your own terminal with  sidenote key sync-…
(Sidenote → Settings → Sync & devices → Show). Notes are decrypted on this computer.

  sidenote all [--archived]                every notepad in full (one call, all you need to read)
  sidenote list [--archived]               titles as a tree, with ids
  sidenote read <notepad> [--html]         one notepad as Markdown, with its revision
  sidenote search <words…> [--limit N]     notepads containing every word
  sidenote new <title> [--parent P] [--accent A] [text | -]
  sidenote append <notepad> [text]         add to the end (text, or piped in)
  sidenote prepend <notepad> [text]        add to the start
  sidenote write <notepad> [--rev N] [text]   replace everything (refused if changed since --rev)
  sidenote replace <notepad> <find> <with> [--all]   exact find and replace in the Markdown
  sidenote tick <notepad> <item>           tick a to-do (untick to undo); item is part of its text
  sidenote rename <notepad> <title>
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
  const valued = new Set(['limit', 'parent', 'accent', 'rev']);
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
    const k = keyFrom(pos[0]);
    const a = await new Account(k, transport()).refresh();
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, k + '\n', { mode: 0o600 });
    try { chmodSync(f, 0o600); } catch {}
    return console.log(`Saved. ${a.list().length} notepads in this account. The key is in ${f}.`);
  }

  const key = readKey();
  if (!key) throw new SidenoteError('No Sidenote key. Set SIDENOTE_KEY, or run: sidenote key sync-… (find it in Sidenote → Settings → Sync & devices → Show).');
  let acct = null;
  const ctx = { readOnly: /^(1|true|yes)$/i.test(env.SIDENOTE_READ_ONLY || ''), account: async () => (acct ||= await new Account(key, transport()).refresh()) };
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
      res = await callTool('create_notepad', { title: pos[0], content, parent: opts.parent, accent: opts.accent }, ctx);
      break;
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
const asCommands = (s) => s.replace(/\b(list|read|search)_notepads?\b/g, 'sidenote $1').replace(/\bset replace_all\b/, 'add --all').replace(/\bbase_rev\b/g, '--rev');

main().catch((e) => {
  console.error(e instanceof SidenoteError ? asCommands(e.message) : `sidenote: ${e?.stack || e}`);
  process.exit(1);
});
