import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeServer, seedAccount } from './fake.js';

const CLI = new URL('../server/cli.js', import.meta.url).pathname;

async function setup() {
  const srv = fakeServer();
  const { syncKey } = await seedAccount(srv.transport, [
    { id: 'lq1aaaa', title: 'Groceries', html: '<ul class="todo"><li>Milk</li><li data-checked="true">Eggs</li></ul>' },
    { id: 'lq2bbbb', title: 'Trip to Lisbon', html: '<p>Flights $420</p>' },
  ]);
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const items = await srv.transport(JSON.parse(body).items);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items }));
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${http.address().port}/api/sync`;
  const home = mkdtempSync(join(tmpdir(), 'sncli-'));
  const run = (args, { key = syncKey, input, env = {} } = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: home, SIDENOTE_ENDPOINT: endpoint, ...(key ? { SIDENOTE_KEY: key } : {}), ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });
  return { srv, syncKey, run, close: () => http.close() };
}

test('cli: read, write, tick, search, all, key file', async () => {
  const t = await setup();
  try {
    let r = await t.run(['list']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /2 notepads/);
    r = await t.run(['read', 'Trip', 'to', 'Lisbon']);
    assert.match(r.out, /Flights \$420/);
    r = await t.run(['append', 'Groceries'], { input: '- [ ] Lemons\n- [ ] Bread\n' });
    assert.equal(r.code, 0, r.err);
    r = await t.run(['tick', 'Groceries', 'lemon']);
    assert.equal(r.code, 0, r.err);
    r = await t.run(['untick', 'Groceries', 'eggs']);
    assert.equal(r.code, 0, r.err);
    r = await t.run(['read', 'groceries']);
    assert.match(r.out, /- \[ \] Milk\n- \[ \] Eggs\n- \[x\] Lemons\n- \[ \] Bread/);
    r = await t.run(['tick', 'Groceries', 'pears']);
    assert.equal(r.code, 1);
    assert.match(r.err, /No open to-do/);
    r = await t.run(['new', 'Packing', '--parent', 'Trip to Lisbon', '-'], { input: '# Bag\n- [ ] Camera' });
    assert.equal(r.code, 0, r.err);
    r = await t.run(['search', 'camera', '--json']);
    assert.equal(JSON.parse(r.out).results[0].title, 'Packing');
    r = await t.run(['replace', 'Trip to Lisbon', '$420', '$390']);
    assert.equal(r.code, 0, r.err);
    r = await t.run(['all']);
    assert.match(r.out, /===== Trip to Lisbon › Packing =====/);
    assert.match(r.out, /Flights \$390/);
    r = await t.run(['write', 'Groceries', '--rev', '1', 'x']);
    assert.equal(r.code, 1, 'a stale --rev is refused');
    r = await t.run(['append', 'Groceries', 'more'], { env: { SIDENOTE_READ_ONLY: '1' } });
    assert.match(r.err, /read-only/);
    r = await t.run(['list'], { key: '' });
    assert.match(r.err, /No Sidenote key/);
    r = await t.run(['key', t.syncKey], { key: '' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /3 notepads/);
    r = await t.run(['read', 'Packing'], { key: '' });
    assert.match(r.out, /Camera/);
    r = await t.run(['key', '--forget'], { key: '' });
    r = await t.run(['list'], { key: '' });
    assert.equal(r.code, 1);
  } finally { t.close(); }
});

test('cli: a shared notepad’s pad key reads and edits just that notepad', async () => {
  const t = await setup();
  try {
    const { Account } = await import('../src/client.js');
    const a = await new Account(t.syncKey, t.srv.transport).refresh();
    const padKey = a.find('Groceries').key;
    let r = await t.run(['list'], { key: padKey });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 notepad:\n- Groceries/);
    r = await t.run(['tick', 'Groceries', 'milk'], { key: padKey });
    assert.equal(r.code, 0, r.err);
    r = await t.run(['new', 'Nope'], { key: padKey });
    assert.match(r.err, /sync key/);
  } finally { t.close(); }
});
