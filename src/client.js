// A Sidenote account opened with its sync key: reads the encrypted index and notepads from
// the sync service, decrypts them here, and writes changes back the way the extension does
// (compare-and-swap on each blob's revision, retrying on a fresh copy when someone else
// wrote first). The extension picks the changes up on its next sync and merges them with
// anything typed meanwhile.

import { parseKey, derive, seal, open, sealFixed, kwOf, viewKeyOf, newKey } from './keys.js';

export const ENDPOINT = 'https://sidenote-sync.netlify.app/api/sync';
export const ACCENTS = ['coral', 'amber', 'olive', 'teal', 'sky', 'iris', 'rose', 'ink'];
const isAccent = (a) => ACCENTS.includes(a) || /^#[0-9a-f]{6}$/i.test(a || '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0');

export class SidenoteError extends Error {}

// transport(items) -> results, the /api/sync request shape. Over HTTPS for local use; the
// hosted connector passes one that talks to storage directly.
export function httpTransport(endpoint = ENDPOINT, { timeout = 20000 } = {}) {
  return async (items) => {
    const out = [];
    for (let i = 0; i < items.length; i += 300) {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
      let r;
      try {
        r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ items: items.slice(i, i + 300) }), signal: ac.signal });
      } catch (e) {
        throw new SidenoteError(e.name === 'AbortError' ? 'The Sidenote sync service took too long to answer. Try again.' : `Can’t reach the Sidenote sync service (${e.message}).`);
      } finally { clearTimeout(t); }
      if (r.status === 503 || r.status === 429) throw new SidenoteError('The Sidenote sync service is resting until tomorrow (its daily limit was reached). Notes are safe; try again later.');
      if (!r.ok) throw new SidenoteError('The Sidenote sync service answered HTTP ' + r.status + '.');
      out.push(...((await r.json()).items || []));
    }
    return out;
  };
}

export function keyFrom(text) {
  const k = parseKey(text);
  if (!k || k.kind !== 'sync') throw new SidenoteError('That isn’t a Sidenote sync key. It starts with “sync-”: in Sidenote, open Settings → Sync & devices → Show.');
  return k.key;
}

// A sync key or a notepad's share key ("pad-" to edit, "view-" to read), whichever it is.
export function openKey(text, transport = httpTransport()) {
  const k = parseKey(text);
  if (!k) throw new SidenoteError('That isn’t a Sidenote key. It starts with “sync-”, “pad-” or “view-”.');
  return k.kind === 'sync' ? new Account(k.key, transport) : new Shared(k.key, transport);
}

// What an account and a shared notepad have in common: records of notepads by id, read
// in sidebar order, written with compare-and-swap.
class Notes {
  constructor(transport) {
    this.send = transport;
    this.space = null;
    this.recs = new Map(); // padId -> { id, key, v, view, shared, bid, rev, doc }
  }

  // Apply one server answer to a record. Returns true when it points to a new key (fetch again).
  async take(rec, r) {
    if (!r || r.error || r.data == null) { if (r && r.rev < rec.rev) { rec.rev = r.rev; rec.doc = null; } return false; }
    let doc;
    try { doc = await open((await derive(rec.key, rec.v)).k, r.data); } catch { rec.doc = null; rec.rev = r.rev; return false; }
    rec.rev = r.rev;
    if (typeof doc.moved === 'string' && !rec.view && /^pad-/.test(doc.moved)) {
      rec.movedFrom = rec.key; rec.key = doc.moved; rec.v = 2; rec.rev = 0; rec.doc = null;
      rec.bid = 'p:' + (await derive(rec.key, 2)).id;
      return true;
    }
    rec.doc = doc.del ? null : doc;
    rec.deleted = !!doc.del;
    return false;
  }

  // --- reading ------------------------------------------------------------------------
  // Notepads in the order Sidenote shows them, each with depth and flags.
  list({ archived = false } = {}) {
    const pads = [...this.recs.values()].filter((r) => r.doc);
    const byId = new Map(pads.map((r) => [r.id, r]));
    const order = this.space.order || [], pos = new Map(order.map((id, i) => [id, i]));
    const arch = new Set(this.space.archived || []), star = new Set(this.space.starred || []);
    const parentOf = (r) => (r.doc.parent && byId.has(r.doc.parent) && r.doc.parent !== r.id ? r.doc.parent : null);
    const kids = new Map();
    for (const r of pads) { const p = parentOf(r); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); }
    for (const l of kids.values()) l.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || (a.doc.created || 0) - (b.doc.created || 0));
    const out = [], seen = new Set();
    const walk = (p, depth, hidden) => {
      for (const r of kids.get(p) || []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const isArch = hidden || arch.has(r.id);
        if (archived || !isArch) out.push({ rec: r, depth, starred: star.has(r.id), archived: isArch });
        walk(r.id, depth + 1, isArch);
      }
    };
    walk(null, 0, false);
    return out;
  }

  // A notepad by id, "sidenote:<id>", or title (exact, then unique partial match).
  find(ref) {
    const s = String(ref ?? '').trim().replace(/^sidenote:/, '');
    if (!s) throw new SidenoteError('Say which notepad: its id or its title.');
    const pads = [...this.recs.values()].filter((r) => r.doc);
    const byId = pads.find((r) => r.id === s);
    if (byId) return byId;
    const low = s.toLowerCase(), title = (r) => (r.doc.title || 'Untitled').trim().toLowerCase();
    let hits = pads.filter((r) => title(r) === low);
    if (!hits.length) hits = pads.filter((r) => title(r).includes(low));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new SidenoteError(`“${s}” matches ${hits.length} notepads: ${hits.slice(0, 12).map((r) => `“${r.doc.title}” (id ${r.id})`).join(', ')}. Use the id.`);
    throw new SidenoteError(`No notepad called “${s}”. Use list_notepads or search_notepads to find it.`);
  }
  get(id) { const r = this.recs.get(id); return r?.doc ? r : null; }
  isArchived(id) { return (this.space.archived || []).includes(id); }
  isStarred(id) { return (this.space.starred || []).includes(id); }

  // --- writing --------------------------------------------------------------------------
  // mutate(doc) -> the new doc (may be async). Runs again on the newer copy after a conflict.
  async write(rec, mutate) {
    if (rec.view) throw new SidenoteError(`“${rec.doc?.title}” was shared with you view-only, so it can’t be changed.`);
    const d = await derive(rec.key, rec.v);
    for (let tries = 0; tries < 5; tries++) {
      if (!rec.doc) throw new SidenoteError('That notepad was deleted.');
      const next = { ...(await mutate(rec.doc)), t: Date.now() };
      const [r] = await this.send([{ id: rec.bid, rev: rec.rev, put: { ifRev: rec.rev, w: d.w, data: await seal(d.k, next) } }]);
      if (r?.ok) { rec.rev = r.rev; rec.doc = next; return rec; }
      if (r?.conflict) {
        if (await this.take(rec, r)) throw new SidenoteError('That notepad just moved to a new key on another device. Read it again, then retry.');
        continue;
      }
      throw new SidenoteError({ denied: 'The sync service refused the write: this key can’t edit that notepad.', size: 'That would make the notepad too large to sync.' }[r?.error] || `The write failed (${r?.error || 'no answer'}).`);
    }
    throw new SidenoteError('The notepad kept changing while saving (someone is editing it right now). Try again.');
  }
}

// A whole account, opened with its sync key: the encrypted index lists every notepad's key.
export class Account extends Notes {
  constructor(key, transport = httpTransport()) {
    super(transport);
    this.key = keyFrom(key);
    this.srev = 0;
  }

  // Bring the index and every notepad up to date. Unchanged blobs come back without data,
  // so a refresh with nothing new costs one small request.
  async refresh() {
    const ad = await derive(this.key);
    const known = [...this.recs.values()];
    const res = await this.send([{ id: 's:' + ad.id, rev: this.srev }, ...known.map((r) => ({ id: r.bid, rev: r.rev }))]);
    const sp = res[0];
    if (sp?.data) {
      try { this.space = await open(ad.k, sp.data); } catch { throw new SidenoteError('That sync key doesn’t open a Sidenote account.'); }
      this.srev = sp.rev;
    } else if (!this.space) throw new SidenoteError('Nothing is synced under that key yet. In Sidenote, turn on sync (Settings → Sync & devices), then try again.');
    for (let i = 0; i < known.length; i++) await this.take(known[i], res[i + 1]);
    await this.reconcile();
    return this;
  }

  // Match the records to the index: add new notepads, drop removed ones, follow v1 -> v2 moves.
  async reconcile() {
    const lib = this.space.lib || {}, libx = this.space.libx || {}, gone = this.space.gone || {};
    for (const id of [...this.recs.keys()]) if (!lib[id] || gone[id]) this.recs.delete(id);
    const fresh = [];
    for (const [id, key] of Object.entries(lib)) {
      if (gone[id] || typeof key !== 'string') continue;
      const cur = this.recs.get(id);
      if (cur && (cur.key === key || cur.movedFrom === key)) continue;
      const f = libx[id] || '', view = f.includes('v') || key.startsWith('view-');
      const rec = { id, key, v: view || f.includes('2') ? 2 : 1, view, shared: f.includes('s'), own: !f.includes('r') && !view, rev: 0, doc: null };
      rec.bid = 'p:' + (await derive(rec.key, rec.v)).id;
      this.recs.set(id, rec);
      fresh.push(rec);
    }
    for (let round = 0; fresh.length && round < 3; round++) {
      const res = await this.send(fresh.map((r) => ({ id: r.bid, rev: 0 })));
      const moved = [];
      for (let i = 0; i < fresh.length; i++) if (await this.take(fresh[i], res[i])) moved.push(fresh[i]);
      fresh.splice(0, fresh.length, ...moved);
    }
  }

  // The account index: the same compare-and-swap. Only lib/libx/gone/starred/archived are touched.
  async writeSpace(mutate) {
    const ad = await derive(this.key);
    for (let tries = 0; tries < 5; tries++) {
      const next = structuredClone(this.space);
      next.lib ||= {}; next.libx ||= {};
      mutate(next);
      const [r] = await this.send([{ id: 's:' + ad.id, rev: this.srev, put: { ifRev: this.srev, w: ad.w, data: await seal(ad.k, next) } }]);
      if (r?.ok) { this.srev = r.rev; this.space = next; return; }
      if (r?.conflict && r.data) { this.space = await open(ad.k, r.data); this.srev = r.rev; continue; }
      throw new SidenoteError(`Updating the account index failed (${r?.error || 'no answer'}).`);
    }
    throw new SidenoteError('The account kept changing while saving. Try again.');
  }

  nextAccent(parent) {
    if (parent?.doc?.accent) return parent.doc.accent;
    const want = this.space.settings?.accent;
    if (want && want !== 'auto' && isAccent(want)) return want;
    const keys = ACCENTS.filter((k) => k !== 'ink'), counts = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const r of this.recs.values()) if (counts[r.doc?.accent] != null) counts[r.doc.accent]++;
    const min = Math.min(...keys.map((k) => counts[k]));
    return keys.find((k) => counts[k] === min);
  }

  async create({ title, html, parent = null, accent = null }) {
    const par = parent ? this.find(parent) : null;
    if (par?.view) throw new SidenoteError(`“${par.doc.title}” is view-only, so it can’t get a subpad.`);
    if (accent && !isAccent(accent)) throw new SidenoteError(`Accent must be one of ${ACCENTS.join(', ')} or a #rrggbb colour.`);
    const id = uid(), key = newKey('pad'), d = await derive(key, 2), now = Date.now();
    const doc = { v: 1, id, title: String(title || 'Untitled').slice(0, 300), accent: accent || this.nextAccent(par), html: html || '<p><br></p>', parent: par ? par.id : null, created: now, kids: [], t: now };
    const [r] = await this.send([{ id: 'p:' + d.id, rev: 0, put: { ifRev: 0, w: d.w, data: await seal(d.k, doc) } }]);
    if (!r?.ok) throw new SidenoteError(`Creating the notepad failed (${r?.error || (r?.conflict ? 'conflict' : 'no answer')}).`);
    const rec = { id, key, v: 2, view: false, own: true, shared: !!par?.shared, bid: 'p:' + d.id, rev: r.rev, doc };
    this.recs.set(id, rec);
    await this.writeSpace((sp) => { sp.lib[id] = key; sp.libx[id] = '2' + (rec.shared ? 's' : ''); if (sp.gone) delete sp.gone[id]; });
    // A subpad travels inside its parent (that is how a shared notepad brings its subpads),
    // in exactly the form the extension computes, so the two never disagree.
    if (par) {
      const entry = par.v === 2 ? [id, await viewKeyOf(key), await sealFixed(await kwOf(par.key), key, id + key)] : [id, key, 2];
      await this.write(par, (doc) => ({ ...doc, kids: [...(doc.kids || []).filter((k) => k[0] !== id), entry].sort((a, b) => (a[0] < b[0] ? -1 : 1)) }));
    }
    return rec;
  }

  async setFlags(rec, { starred, archived }) {
    await this.writeSpace((sp) => {
      const set = (name, on) => {
        if (on == null) return;
        const s = new Set(sp[name] || []);
        if (on) s.add(rec.id); else s.delete(rec.id);
        sp[name] = [...s].sort();
      };
      set('archived', archived);
      set('starred', archived ? false : starred); // as in Sidenote, archiving unstars
    });
  }
}

// A notepad someone shared, opened with its share key ("pad-" edits, "view-" only reads),
// together with its subpads, whose keys travel inside it. No account and no index: what
// the extension's "open a shared notepad" does, held in memory.
export class Shared extends Notes {
  constructor(key, transport = httpTransport()) {
    super(transport);
    const k = parseKey(key);
    if (!k || k.kind === 'sync') throw new SidenoteError('That isn’t a notepad key. It starts with “pad-” or “view-”.');
    this.key = k.key;
    this.view = k.kind === 'view';
    this.space = { order: [], starred: [], archived: [] };
    this.root = null;
  }

  async refresh() {
    if (!this.root) await this.openRoot();
    const known = [...this.recs.values()];
    const res = await this.send(known.map((r) => ({ id: r.bid, rev: r.rev })));
    for (let i = 0; i < known.length; i++) await this.take(known[i], res[i]);
    await this.addKids();
    return this;
  }

  async create() { throw new SidenoteError('New notepads need your sync key; this is a shared notepad’s key.'); }
  async setFlags() { throw new SidenoteError('Stars and the archive belong to your account; open it with your sync key.'); }

  // A pad key may be v2 or (from before 1.5) v1; ask for both, as the extension does.
  async openRoot() {
    const cands = this.view ? [2] : [2, 1], ds = await Promise.all(cands.map((v) => derive(this.key, v)));
    const res = await this.send(ds.map((d) => ({ id: 'p:' + d.id, rev: 0 })));
    const hit = res.findIndex((r) => r?.data);
    if (hit < 0) throw new SidenoteError('No notepad found for that key. Check it, or try again in a moment if it was shared just now.');
    const rec = { id: null, key: this.key, v: cands[hit], view: this.view, shared: true, own: false, bid: 'p:' + ds[hit].id, rev: 0, doc: null };
    let r = res[hit];
    for (let hop = 0; hop < 3 && (await this.take(rec, r)); hop++) [r] = await this.send([{ id: rec.bid, rev: 0 }]);
    if (!rec.doc) throw new SidenoteError(rec.deleted ? 'That notepad was deleted.' : 'That key doesn’t open a notepad.');
    if (typeof rec.doc.id !== 'string' || !/^[\w-]{4,40}$/.test(rec.doc.id)) throw new SidenoteError('That key doesn’t open a notepad.');
    rec.id = rec.doc.id;
    this.recs.set(rec.id, rec);
    this.root = rec.id;
  }

  // Subpads: a v2 parent lists [id, view key, full key sealed with the parent's key].
  async addKids() {
    for (let round = 0; round < 8; round++) {
      const fresh = [];
      for (const p of [...this.recs.values()]) {
        if (!p.doc) continue;
        for (const [kid, key, x] of p.doc.kids || []) {
          if (typeof kid !== 'string' || typeof key !== 'string' || this.recs.has(kid)) continue;
          let rec = null;
          if (key.startsWith('view-')) {
            let full = null;
            if (!p.view && typeof x === 'string') { try { full = await open(await kwOf(p.key), x); } catch {} }
            rec = typeof full === 'string' && /^pad-/.test(full) ? { key: full, view: false } : { key, view: true };
            rec.v = 2;
          } else if (!p.view && /^pad-/.test(key)) rec = { key, v: x === 2 ? 2 : 1, view: false };
          if (!rec) continue;
          Object.assign(rec, { id: kid, shared: true, own: false, rev: 0, doc: null, bid: 'p:' + (await derive(rec.key, rec.v)).id });
          this.recs.set(kid, rec);
          fresh.push(rec);
        }
      }
      if (!fresh.length) return;
      const res = await this.send(fresh.map((f) => ({ id: f.bid, rev: 0 })));
      for (let i = 0; i < fresh.length; i++) if (await this.take(fresh[i], res[i])) { const [again] = await this.send([{ id: fresh[i].bid, rev: 0 }]); await this.take(fresh[i], again); }
    }
  }
}
