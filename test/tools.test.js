import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer, seedAccount } from './fake.js';
import { Account } from '../src/client.js';
import { handle } from '../src/rpc.js';
import { derive, open } from '../src/keys.js';

async function setup() {
  const srv = fakeServer();
  const { syncKey, lib } = await seedAccount(srv.transport, [
    { id: 'lq1aaaa', title: 'Groceries', html: '<ul class="todo"><li>milk</li><li data-checked="true">eggs</li></ul>' },
    { id: 'lq2bbbb', title: 'Ideas', html: '<h2>Apps</h2><p>A side panel for <b>notes</b></p>' },
    { id: 'lq3cccc', title: 'Ideas archive', parent: 'lq2bbbb', html: '<p>old idea about snake_case</p>' },
  ]);
  const acct = new Account(syncKey, srv.transport);
  const ctx = { account: async () => acct.refresh(), readOnly: false };
  let n = 0;
  const call = async (name, args) => (await handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, ctx)).result;
  return { srv, syncKey, lib, acct, ctx, call };
}
const text = (r) => r.content[0].text;

test('initialize and list tools', async () => {
  const { ctx } = await setup();
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, ctx);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'sidenote');
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  assert.equal(list.result.tools.length, 7);
  const ro = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { ...ctx, readOnly: true });
  assert.deepEqual(ro.result.tools.map((t) => t.name), ['list_notepads', 'read_notepad', 'search_notepads']);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
});

test('list, read, search', async () => {
  const { call } = await setup();
  const l = text(await call('list_notepads', {}));
  assert.match(l, /3 notepads/);
  assert.match(l, /\n {2}- Ideas archive \(id lq3cccc\)/);
  const r = await call('read_notepad', { notepad: 'groceries' });
  assert.match(text(r), /- \[ \] milk\n- \[x\] eggs/);
  assert.equal(r.structuredContent.rev, 1);
  const s = text(await call('search_notepads', { query: 'snake_case' }));
  assert.match(s, /Ideas archive/);
  const amb = await call('read_notepad', { notepad: 'idea' });
  assert.equal(amb.isError, true);
  assert.match(text(amb), /matches 2 notepads/);
});

test('edit ticks a to-do and the stored HTML stays in the editor vocabulary', async () => {
  const { call, srv, lib } = await setup();
  const r = await call('edit_notepad', { notepad: 'Groceries', find: '- [ ] milk', replace: '- [x] milk' });
  assert.ok(!r.isError, text(r));
  const d = await derive(lib.lq1aaaa, 2), blob = srv.blobs.get('p:' + d.id);
  const doc = await open(d.k, blob.data);
  assert.equal(doc.html, '<ul class="todo"><li data-checked="true">milk</li><li data-checked="true">eggs</li></ul>');
  assert.equal(blob.rev, 2);
  assert.equal(doc.id, 'lq1aaaa');
  assert.ok(doc.t > 0);
});

test('update refuses a stale base_rev, append keeps the old text', async () => {
  const { call } = await setup();
  const stale = await call('update_notepad', { notepad: 'Ideas', content: '# New', base_rev: 0 });
  assert.equal(stale.isError, true);
  const r = await call('update_notepad', { notepad: 'Ideas', content: '- one more', mode: 'append' });
  assert.ok(!r.isError, text(r));
  const read = text(await call('read_notepad', { notepad: 'lq2bbbb' }));
  assert.match(read, /## Apps\n\nA side panel for \*\*notes\*\*\n\n- one more/);
});

test('create a subpad: blob, index entry and the parent’s kids', async () => {
  const { call, acct, syncKey } = await setup();
  const r = await call('create_notepad', { title: 'Plan', content: '# Week\n- [ ] ship', parent: 'Ideas' });
  assert.ok(!r.isError, text(r));
  const id = r.structuredContent.id;
  const fresh = new Account(syncKey, acct.send);
  await fresh.refresh();
  assert.equal(fresh.get(id).doc.html, '<h1>Week</h1><ul class="todo"><li>ship</li></ul>');
  assert.equal(fresh.get(id).doc.accent, 'sky'); // the parent's
  assert.equal(fresh.space.libx[id], '2');
  const kids = fresh.get('lq2bbbb').doc.kids;
  assert.equal(kids.length, 1);
  assert.equal(kids[0][0], id);
  assert.match(kids[0][1], /^view-/);
});

test('a conflicting write retries on the newer copy', async () => {
  const { call, srv, syncKey } = await setup();
  const other = new Account(syncKey, srv.transport);
  await other.refresh();
  await call('read_notepad', { notepad: 'Groceries' });
  await other.write(other.get('lq1aaaa'), (doc) => ({ ...doc, html: doc.html.replace('milk', 'oat milk') }));
  const r = await call('update_notepad', { notepad: 'Groceries', content: '- [ ] bread', mode: 'append' });
  assert.ok(!r.isError, text(r));
  const read = text(await call('read_notepad', { notepad: 'Groceries' }));
  assert.match(read, /oat milk[\s\S]*bread/);
});

test('organize, read-only and a wrong key', async () => {
  const { call, ctx, srv } = await setup();
  assert.match(text(await call('organize_notepad', { notepad: 'Ideas', starred: true })), /is now starred/);
  assert.match(text(await call('organize_notepad', { notepad: 'Ideas archive', archived: true, starred: true })), /is now archived/);
  assert.doesNotMatch(text(await call('list_notepads', {})), /Ideas archive/);
  assert.match(text(await call('list_notepads', { include_archived: true })), /Ideas archive/);
  const ro = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_notepad', arguments: { title: 'x' } } }, { ...ctx, readOnly: true });
  assert.equal(ro.error.code, -32602);
  const bad = new Account('sync-aaaaa-bbbbb-ccccc-ddddd-eeeee', srv.transport);
  await assert.rejects(() => bad.refresh(), /Nothing is synced/);
});
