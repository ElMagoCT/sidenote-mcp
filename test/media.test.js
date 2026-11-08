import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer, seedAccount } from './fake.js';
import { Account } from '../src/client.js';
import { handle } from '../src/rpc.js';
import { toMarkdown, toHTML, sanitize } from '../src/md.js';
import { parseBoard, serializeBoard } from '../src/board.js';
import { embedOf, dims, putImage, getImage } from '../src/media.js';

// A 3×2 PNG (red), made by hand.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8DAwMDAwMAAAAzSAgFHmzCaAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
const B64 = btoa(String.fromCharCode(...PNG));
// Whiteboard HTML exactly as the extension wrote it in its own test (board.js serializeBoard).
const BOARD = '<div data-b="sticky" data-id="a1b2c3" data-x="-140" data-y="20" data-w="200" data-h="160" data-c="amber"><p>Hello board again</p></div><div data-b="sticky" data-id="d4e5f6" data-x="220" data-y="80" data-w="200" data-h="160" data-c="rose"><p>Second</p></div><div data-b="ink" data-id="g7h8i9" data-x="20" data-y="270" data-w="240" data-h="80" data-c="ink" data-p="0,40 30.5,0 120,79.5 240,10" data-sw="3"></div><div data-b="img" data-id="j1k2l3" data-x="100" data-y="141" data-w="360" data-h="240" data-img="img-ne17s-n786q-r8m2g-jwgwj-cj4sk"></div><div data-b="arrow" data-id="m4n5o6" data-from="a1b2c3" data-to="d4e5f6" data-p="-40,100 320,160"></div><div data-b="text" data-id="p7q8r9" data-x="0" data-y="-80" data-w="240" data-h="37" data-c="sky" data-s="l"><p><b>Plan</b> &amp; notes</p></div><div data-b="embed" data-id="s1t2u3" data-x="500" data-y="0" data-w="420" data-h="270" data-embed="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=42s"></div><div data-b="note" data-id="v4w5x6" data-x="500" data-y="320" data-w="240" data-h="104" data-note="lq1aaaa"></div>';

test('embeds: links become the stored form', () => {
  assert.equal(embedOf('https://youtu.be/dQw4w9WgXcQ?t=1m2s').canon, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=62s');
  assert.equal(embedOf('https://www.youtube.com/shorts/dQw4w9WgXcQ').canon, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.equal(embedOf('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp').canon, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view');
  assert.equal(embedOf('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0').label, 'Google Sheets');
  assert.equal(embedOf('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(embedOf('javascript:alert(1)'), null);
});

test('figures round-trip through Markdown', () => {
  const h = '<p>a</p><figure data-img="img-ne17s-n786q-r8m2g-jwgwj-cj4sk" data-w="1600" data-h="1050" data-size="m"></figure><figure data-embed="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=42s"></figure><details open=""><summary>t</summary><div class="dt"><figure data-img="img-ne17s-n786q-r8m2g-jwgwj-cj4sk"></figure></div></details><p><br></p>';
  assert.equal(toHTML(toMarkdown(h)), sanitize(h));
  assert.match(toMarkdown(h), /!\[image\]\(sidenote-image:img-ne17s-n786q-r8m2g-jwgwj-cj4sk "1600x1050 medium"\)/);
  assert.equal(toHTML('![x](https://example.com/cat.png)'), '<p><a href="https://example.com/cat.png">x</a></p>');
  assert.equal(sanitize('<figure data-img="img-bad"></figure><figure data-embed="https://evil.com"><img src=x></figure>'), '');
});

test('the extension’s whiteboard HTML reads and writes back byte for byte', () => {
  const items = parseBoard(BOARD);
  assert.equal(items.length, 8);
  assert.equal(serializeBoard(items), BOARD);
  assert.deepEqual(items.find((i) => i.b === 'arrow'), { b: 'arrow', id: 'm4n5o6', from: 'a1b2c3', to: 'd4e5f6', p: [[-40, 100], [320, 160]] });
});

test('image bytes: dims, upload once, read back', async () => {
  assert.deepEqual(dims(PNG), { w: 3, h: 2 });
  const srv = fakeServer();
  const im = await putImage(srv.transport, PNG);
  assert.match(im.key, /^img-/);
  assert.equal(im.type, 'image/png');
  const back = await getImage(srv.transport, im.key);
  assert.deepEqual([...back.bytes], [...PNG]);
  const blob = [...srv.blobs.values()][0].data;
  assert.ok(!blob.includes(B64.slice(0, 20)), 'stored encrypted');
  // Someone who saw the key stores another picture under it first: readers refuse it.
  const { deriveImg } = await import('../src/media.js');
  const other = fakeServer(), d = await deriveImg(im.key), iv = new Uint8Array(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, d.k, new Uint8Array(40).fill(7)));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  await other.transport([{ id: d.id, rev: 0, put: { ifRev: 0, w: d.w, data: btoa(String.fromCharCode(...all)) } }]);
  await assert.rejects(getImage(other.transport, im.key), /doesn’t match/);
});

test('image addresses must be on the public web', async () => {
  const { fetchImage } = await import('../src/media.js');
  for (const u of ['http://localhost/x.png', 'http://127.0.0.1/x.png', 'http://192.168.1.4/x.png', 'http://[::1]/x.png', 'http://router.local/x.png', 'http://intranet/x.png', 'file:///etc/passwd']) await assert.rejects(fetchImage(u, () => { throw new Error('fetched'); }), /public web|http\(s\)/, u);
  const fake = async (href) => (href.startsWith('https://a.example') ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/secret' } }) : new Response(PNG));
  await assert.rejects(fetchImage('https://a.example/x.png', fake), /redirects off/);
  assert.equal((await fetchImage('https://b.example/x.png', fake)).length, PNG.length);
});

async function setup() {
  const srv = fakeServer();
  const { syncKey } = await seedAccount(srv.transport, [{ id: 'lq1aaaa', title: 'Groceries', html: '<p>milk</p>' }]);
  const acct = new Account(syncKey, srv.transport);
  const ctx = { account: async () => acct.refresh(), readOnly: false };
  let n = 0;
  const call = async (name, args) => (await handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, ctx)).result;
  return { srv, acct, call };
}
const text = (r) => r.content[0].text;

test('whiteboards: create with items and arrows, read, edit, refuse text edits', async () => {
  const { acct, call } = await setup();
  const c = await call('create_notepad', { title: 'Plan', kind: 'whiteboard', items: [
    { type: 'sticky', ref: 'a', text: 'Idea **one**' },
    { type: 'rectangle', ref: 'b', text: 'Build it', color: 'teal' },
    { type: 'arrow', from: 'a', to: 'b' },
    { type: 'notepad', notepad: 'Groceries' },
    { type: 'embed', url: 'https://youtu.be/dQw4w9WgXcQ' },
  ] });
  assert.ok(!c.isError, text(c));
  assert.match(text(c), /whiteboard “Plan”.*with 5 items/);
  await acct.refresh();
  const rec = acct.find('Plan');
  assert.equal(rec.doc.kind, 'board');
  const items = parseBoard(rec.doc.html);
  const [a, b, arrow, note, emb] = items;
  assert.deepEqual([a.b, b.b, arrow.b, note.b, emb.b], ['sticky', 'rect', 'arrow', 'note', 'embed']);
  assert.equal(arrow.from, a.id); assert.equal(arrow.to, b.id);
  assert.equal(note.note, 'lq1aaaa');
  assert.ok(b.x > a.x && a.y === b.y, 'laid out in a row');
  assert.equal(a.html, '<p>Idea <b>one</b></p>');
  const r = await call('read_notepad', { notepad: 'Plan' });
  assert.match(text(r), /Whiteboard · 5 items/);
  assert.match(text(r), new RegExp(`- sticky ${a.id} amber at \\(0, 0\\) 200×160: Idea \\*\\*one\\*\\*`));
  assert.match(text(r), new RegExp(`- arrow ${arrow.id} from ${a.id} to ${b.id}`));
  assert.match(text(r), /notepad “Groceries” \(id lq1aaaa\)/);
  assert.equal(r.structuredContent.kind, 'whiteboard');
  assert.equal(r.structuredContent.items[1].type, 'rectangle');
  const e = await call('edit_whiteboard', { notepad: 'Plan', update: [{ id: a.id, x: 400, y: -200, text: 'Moved', color: 'sky' }], remove: [b.id], add: [{ type: 'text', text: 'Title', size: 'xl', x: 0, y: -300 }] });
  assert.ok(!e.isError, text(e));
  await acct.refresh();
  const after = parseBoard(acct.find('Plan').doc.html);
  assert.equal(after.length, 4, 'b and its arrow gone, one text added');
  assert.deepEqual([after[0].x, after[0].y, after[0].c, after[0].html], [400, -200, 'sky', '<p>Moved</p>']);
  assert.equal(after[3].s, 'xl');
  assert.ok((await call('edit_notepad', { notepad: 'Plan', find: 'x', replace: 'y' })).isError);
  assert.ok((await call('update_notepad', { notepad: 'Plan', content: 'x' })).isError);
  assert.ok(!(await call('update_notepad', { notepad: 'Plan', title: 'Plan 2' })).isError, 'renaming still works');
  assert.match(text(await call('edit_whiteboard', { notepad: 'Plan 2', add: [{ type: 'arrow', from: 'nope', to: after[0].id }] })), /no item “nope”/);
  assert.match(text(await call('list_notepads', {})), /Plan 2 \(id [\w]+, whiteboard\)/);
});

test('add_image to a notepad and a whiteboard, then view it', async () => {
  const { acct, call } = await setup();
  const r1 = await call('add_image', { notepad: 'Groceries', data: B64, size: 'small' });
  assert.ok(!r1.isError, text(r1));
  const key = r1.structuredContent.image;
  await acct.refresh();
  assert.equal(acct.find('Groceries').doc.html, `<p>milk</p><figure data-img="${key}" data-w="3" data-h="2" data-size="s"></figure>`);
  const md = text(await call('read_notepad', { notepad: 'Groceries' }));
  assert.match(md, new RegExp(`!\\[image\\]\\(sidenote-image:${key} "3x2 small"\\)`));
  const v = await call('view_image', { image: 'sidenote-image:' + key });
  assert.equal(v.content[1].type, 'image');
  assert.equal(v.content[1].mimeType, 'image/png');
  assert.equal(v.content[1].data, B64);
  await call('create_notepad', { title: 'Board', kind: 'whiteboard' });
  const r2 = await call('add_image', { notepad: 'Board', data: 'data:image/png;base64,' + B64, w: 300 });
  assert.ok(!r2.isError, text(r2));
  await acct.refresh();
  const [img] = parseBoard(acct.find('Board').doc.html);
  assert.deepEqual([img.b, img.w, img.h, img.img], ['img', 300, 200, r2.structuredContent.image]);
  assert.match(text(await call('add_image', { notepad: 'Groceries', data: btoa('not an image') })), /isn’t a PNG/);
  assert.match(text(await call('view_image', { image: 'img-00000-00000-00000-00000-00000' })), /No image under that key/);
  // insert after a line
  await call('update_notepad', { notepad: 'Groceries', content: 'one\ntwo' });
  await call('add_image', { notepad: 'Groceries', data: B64, after: 'one' });
  await acct.refresh();
  assert.match(acct.find('Groceries').doc.html, /^<p>one<\/p><figure data-img="img-[^"]+" data-w="3" data-h="2"><\/figure><p>two<\/p>$/);
});
