import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer, seedAccount } from './fake.js';
import { Account, openKey } from '../src/client.js';
import { viewKeyOf } from '../src/keys.js';

test('a shared notepad: a pad key edits, a view key reads, subpads come along', async () => {
  const srv = fakeServer();
  const { syncKey, lib } = await seedAccount(srv.transport, [{ id: 'lq1aaaa', title: 'Trip', html: '<p>Plan</p>' }, { id: 'lq2bbbb', title: 'Other', html: '<p>x</p>' }]);
  const acct = await new Account(syncKey, srv.transport).refresh();
  await acct.create({ title: 'Packing', html: '<p>socks</p>', parent: 'lq1aaaa' });

  const sh = await openKey(lib.lq1aaaa, srv.transport).refresh();
  assert.deepEqual(sh.list().map((r) => [r.rec.doc.title, r.depth]), [['Trip', 0], ['Packing', 1]], 'only the shared notepad and its subpad');
  await sh.write(sh.find('Packing'), (d) => ({ ...d, html: '<p>socks, hat</p>' }));
  await acct.refresh();
  assert.match(acct.find('Packing').doc.html, /hat/, 'the owner sees the edit');

  const view = await openKey(await viewKeyOf(lib.lq1aaaa), srv.transport).refresh();
  assert.equal(view.list().length, 2);
  assert.ok(view.find('Packing').view && view.find('Trip').view);
  await assert.rejects(view.write(view.find('Trip'), (d) => d), /view-only/);

  assert.throws(() => openKey('nope'), /isn’t a Sidenote key/);
  await assert.rejects(openKey('pad-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa', srv.transport).refresh(), /No notepad found/);
});
