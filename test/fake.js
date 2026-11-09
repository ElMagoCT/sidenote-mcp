// An in-memory copy of the sync service's rules (server/netlify/edge-functions/sync.js in the
// extension repo): compare-and-swap on rev, and the first write token sticks to the blob.
import { webcrypto } from 'node:crypto';
import { newKey, derive, seal, sha, hex } from '../src/keys.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

export function fakeServer() {
  const blobs = new Map();
  const transport = async (items) => Promise.all(items.map(async (it) => {
    const cur = blobs.get(it.id), rev = cur?.rev || 0;
    if (it.put) {
      const wh = hex(await sha(it.put.w));
      if (cur?.wh && cur.wh !== wh) return { id: it.id, error: 'denied' };
      if ((it.put.ifRev | 0) !== rev) return { id: it.id, conflict: true, rev, data: cur?.data ?? null };
      blobs.set(it.id, { rev: rev + 1, data: it.put.data, wh: cur?.wh || wh });
      return { id: it.id, ok: true, rev: rev + 1 };
    }
    if ((it.rev | 0) === rev) return { id: it.id, rev };
    return { id: it.id, rev, data: cur?.data ?? null };
  }));
  return { blobs, transport };
}

// An account as the extension leaves it: a sync key, v2 notepads, the index.
export async function seedAccount(transport, pads) {
  const syncKey = newKey('sync'), lib = {}, libx = {}, order = [];
  for (const p of pads) {
    const key = newKey('pad'), d = await derive(key, 2);
    lib[p.id] = key; libx[p.id] = '2'; order.push(p.id);
    const doc = { v: 1, id: p.id, title: p.title, accent: p.accent || 'sky', html: p.html || '<p><br></p>', parent: p.parent || null, created: 1, kids: [], t: Date.now(), ...(p.kind && { kind: p.kind }) };
    await transport([{ id: 'p:' + d.id, rev: 0, put: { ifRev: 0, w: d.w, data: await seal(d.k, doc) } }]);
  }
  const ad = await derive(syncKey);
  const space = { v: 1, lib, libx, gone: {}, starred: [], archived: [], order, orderT: 1, settings: { accent: 'auto' } };
  await transport([{ id: 's:' + ad.id, rev: 0, put: { ifRev: 0, w: ad.w, data: await seal(ad.k, space) } }]);
  return { syncKey, lib };
}
