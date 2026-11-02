#!/usr/bin/env node
// Sidenote MCP server over stdio. Notes are decrypted on this computer; the sync key never
// leaves it (only the hashes and ciphertext the extension itself sends go to the sync service).
//
//   SIDENOTE_SYNC_KEY=sync-… npx -y github:ElMagoCT/sidenote-mcp
//   SIDENOTE_READ_ONLY=1      read and search only
//   SIDENOTE_ENDPOINT=…       another sync service (tests)

import { webcrypto } from 'node:crypto';
import { createInterface } from 'node:readline';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { Account, httpTransport, SidenoteError } = await import('../src/client.js');
const { handle, VERSION } = await import('../src/rpc.js');

if (process.argv.includes('--version')) { console.log(VERSION); process.exit(0); }
if (process.argv.includes('--help')) {
  console.log('sidenote-mcp: MCP server for Sidenote notes.\nSet SIDENOTE_SYNC_KEY to your sync key (Sidenote → Settings → Sync & devices → Show).\nOptional: SIDENOTE_READ_ONLY=1.');
  process.exit(0);
}

const env = process.env;
const rawKey = (env.SIDENOTE_SYNC_KEY || env.SIDENOTE_KEY || '').trim();
const readOnly = /^(1|true|yes)$/i.test(env.SIDENOTE_READ_ONLY || '');
const transport = httpTransport(env.SIDENOTE_ENDPOINT || undefined);

let acct = null, last = 0;
async function account() {
  if (!rawKey || /^\$\{/.test(rawKey)) throw new SidenoteError('No Sidenote sync key is set. Add SIDENOTE_SYNC_KEY (find it in Sidenote → Settings → Sync & devices → Show) to this server’s settings.');
  acct ||= new Account(rawKey, transport);
  // A burst of tool calls shares one refresh; anything older looks again (cheap when nothing changed).
  if (Date.now() - last > 1500) { await acct.refresh(); last = Date.now(); }
  return acct;
}

const ctx = { account, readOnly };
console.error(`[sidenote-mcp] ${VERSION} ready: ${rawKey && !/^\$\{/.test(rawKey) ? 'sync key set' : 'no sync key yet'}${readOnly ? ', read only' : ''}`);
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const res = await handle(msg, ctx);
    if (res) out(res);
  }).catch((e) => console.error('[sidenote-mcp]', e));
});
rl.on('close', () => queue.finally(() => process.exit(0)));
