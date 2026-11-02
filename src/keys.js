// Sidenote keys and sealing: the same scheme as the extension's src/sync.js, so a notepad
// written here opens there and the other way round. Web Crypto only, so it runs in Node
// 20+, Deno and Netlify Edge alike.
//
// sync-…  account key: opens the small encrypted index (which notepad keys you have,
//         stars, archive, order, look settings)
// pad-…   a notepad's edit key       view-…  its read-only key
// v1 keys (before Sidenote 1.5) derive id, write token and AES key from the pad key; v2
// keys derive id and AES key from the view key and only the write token from the pad key.

const ALPHA = '0123456789abcdefghjkmnpqrstvwxyz';
const te = new TextEncoder(), td = new TextDecoder();

const fmt = (kind, body) => `${kind}-${body.match(/.{1,5}/g).join('-')}`;
function b32(bytes) {
  let s = '', val = 0, bits = 0;
  for (const x of bytes) {
    val = ((val << 8) | x) & 0xffff; bits += 8;
    while (bits >= 5) { s += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return s.slice(0, 25);
}
export const newKey = (kind) => fmt(kind, b32(crypto.getRandomValues(new Uint8Array(16))));

// Finds a key anywhere in pasted text; forgives case, spaces and look-alike letters.
export function parseKey(text) {
  const m = /\b(pad|sync|view)[\s-]*((?:[0-9a-z][\s-]?){25})/i.exec(text || '');
  if (!m) return null;
  const body = m[2].toLowerCase().replace(/[\s-]/g, '').replace(/o/g, '0').replace(/[il]/g, '1').replace(/u/g, 'v');
  if (body.length !== 25 || [...body].some((c) => !ALPHA.includes(c))) return null;
  return { kind: m[1].toLowerCase(), key: fmt(m[1].toLowerCase(), body) };
}

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha = (s) => crypto.subtle.digest('SHA-256', typeof s === 'string' ? te.encode(s) : s);
const aes = async (seed) => crypto.subtle.importKey('raw', await sha(seed), 'AES-GCM', false, ['encrypt', 'decrypt']);
export async function viewKeyOf(key) { return fmt('view', b32(new Uint8Array(await sha('sn2:r:' + key)).subarray(0, 16))); }
export const kwOf = (key) => aes('sn2:kw:' + key);

// { id: 40 hex (the server's name for the blob), w: write token or null, k: AES key }
const derived = new Map();
export async function derive(key, v = 1) {
  const c = v + key;
  if (derived.has(c)) return derived.get(c);
  let d;
  if (key.startsWith('view-')) d = { id: hex(await sha('sn2:id:' + key)).slice(0, 40), w: null, k: await aes('sn2:k:' + key) };
  else if (v === 2) d = { ...(await derive(await viewKeyOf(key))), w: hex(await sha('sn2:w:' + key)) };
  else d = { id: hex(await sha('sn1:id:' + key)).slice(0, 40), w: hex(await sha('sn1:w:' + key)), k: await aes('sn1:k:' + key) };
  if (derived.size > 2000) derived.clear();
  derived.set(c, d);
  return d;
}

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function sealWith(k, obj, iv) {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(JSON.stringify(obj))));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return toB64(all);
}
export const seal = (k, obj) => sealWith(k, obj, crypto.getRandomValues(new Uint8Array(12)));
// Deterministic sealing for subpad keys inside a doc, so the same tree gives the same doc.
export async function sealFixed(k, obj, seed) { return sealWith(k, obj, new Uint8Array(await sha('sn2:iv:' + seed)).subarray(0, 12)); }
export async function open(k, b64) {
  const all = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, k, all.subarray(12))));
}
