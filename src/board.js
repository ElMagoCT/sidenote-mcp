// Whiteboards: a notepad whose doc has kind "board" holds a canvas of items instead of text.
// Same format as the extension's src/board.js (keep the two in step): one element per item,
// attributes in ORDER, later items on top.
//   <div data-b="sticky" data-id="k3x9q2" data-x="120" data-y="80" data-w="200" data-h="160" data-c="amber"><p>…</p></div>
//   sticky, text, rect, ellipse, diamond  hold text (editor HTML; text items have data-s = s|m|l|xl)
//   arrow  data-from / data-to (item ids), data-p "x1,y1 x2,y2" for loose ends
//   ink    data-p "x,y x,y …" relative to data-x/data-y, data-sw stroke width
//   img    data-img (an image key)   embed  data-embed (a link)   note  data-note (a notepad id)

import { parse, serialize, sanitize, toMarkdown, toHTML, textOf } from './md.js';
import { isImgKey, embedOf } from './media.js';

export const TEXT = new Set(['sticky', 'text', 'rect', 'ellipse', 'diamond']);
const BOXES = new Set([...TEXT, 'img', 'embed', 'note']);
const KINDS = new Set([...BOXES, 'arrow', 'ink']);
const ORDER = ['b', 'id', 'x', 'y', 'w', 'h', 'c', 's', 'from', 'to', 'p', 'sw', 'img', 'embed', 'note'];
export const COLORS = ['ink', 'coral', 'amber', 'olive', 'teal', 'sky', 'iris', 'rose'];
const SIZES = { s: 14, m: 18, l: 28, xl: 44 };
const DEF = { sticky: [200, 160, 'amber'], text: [240, 30, 'ink'], rect: [180, 110, 'sky'], ellipse: [170, 120, 'teal'], diamond: [150, 150, 'iris'], note: [240, 104, null], img: [360, 240, null], embed: [420, 270, null] };
// What an AI calls each kind, and back.
export const TYPES = { sticky: 'sticky', text: 'text', rect: 'rectangle', ellipse: 'ellipse', diamond: 'diamond', arrow: 'arrow', ink: 'drawing', img: 'image', embed: 'embed', note: 'notepad' };
const FROM_TYPE = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
Object.assign(FROM_TYPE, { rect: 'rect', note: 'note', img: 'img', ink: 'ink', shape: 'rect', box: 'rect', circle: 'ellipse', 'sticky note': 'sticky', connector: 'arrow', line: 'arrow', video: 'embed' });

const uid = () => Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const int = (v) => { const n = Math.round(+v); return Number.isFinite(n) ? clamp(n, -1e6, 1e6) : 0; };
const r1 = (n) => Math.round(n * 10) / 10;
const colorOk = (c) => COLORS.includes(c) || /^#[0-9a-f]{6}$/i.test(c || '');
const ptsOf = (s) => String(s || '').trim().split(/\s+/).map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)).slice(0, 5000);
const cleanText = (h) => sanitize(h).replace(/<figure\b[^>]*><\/figure>/g, '');

export function parseBoard(html) {
  const out = [], seen = new Set();
  for (const e of parse(html || '').kids) {
    const d = e.attrs || {}, b = d['data-b'];
    if (e.tag !== 'div' || !KINDS.has(b)) continue;
    const id = /^[\w-]{1,24}$/.test(d['data-id'] || '') ? d['data-id'] : uid();
    if (seen.has(id)) continue;
    seen.add(id);
    const it = b === 'arrow' ? { b, id } : { b, id, x: int(d['data-x']), y: int(d['data-y']), w: Math.max(0, int(d['data-w'])), h: Math.max(0, int(d['data-h'])) };
    if (colorOk(d['data-c'])) it.c = d['data-c'];
    if (TEXT.has(b)) { it.html = cleanText(serialize(e)); if (b === 'text' && SIZES[d['data-s']]) it.s = d['data-s']; }
    else if (b === 'arrow') {
      if (/^[\w-]{1,24}$/.test(d['data-from'] || '')) it.from = d['data-from'];
      if (/^[\w-]{1,24}$/.test(d['data-to'] || '')) it.to = d['data-to'];
      const p = ptsOf(d['data-p']);
      if (p.length >= 2) it.p = p.slice(0, 2);
      if (!it.p && !(it.from && it.to)) continue;
    } else if (b === 'ink') { it.p = ptsOf(d['data-p']); if (it.p.length < 2) continue; it.sw = clamp(+d['data-sw'] || 3, 1, 40); }
    else if (b === 'img') { if (!isImgKey(d['data-img'])) continue; it.img = d['data-img']; }
    else if (b === 'embed') { const em = embedOf(d['data-embed']); if (!em) continue; it.embed = em.canon; }
    else if (b === 'note') { if (!/^[\w-]{1,40}$/.test(d['data-note'] || '')) continue; it.note = d['data-note']; }
    out.push(it);
  }
  return out;
}
const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export function itemHTML(it) {
  const v = { ...it, p: it.p ? it.p.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ') : null };
  const attrs = ORDER.filter((k) => v[k] != null && v[k] !== '').map((k) => ` data-${k}="${escA(v[k])}"`).join('');
  return `<div${attrs}>${TEXT.has(it.b) ? it.html || '' : ''}</div>`;
}
export const serializeBoard = (items, area = null) => (area ? itemHTML({ b: 'area', x: area.x, y: area.y, w: area.w, h: area.h }) : '') + items.map(itemHTML).join('');
// The board's area (its first line, <div data-b="area" data-x data-y data-w data-h>): the room it
// has, which the extension grows to fit its items. Copies from a merge give their union.
export function areaOf(html) {
  let a = null;
  for (const [tag] of String(html || '').matchAll(/<div\b[^>]*\bdata-b="area"[^>]*>/g)) {
    const v = {};
    for (const k of ['x', 'y', 'w', 'h']) { const m = new RegExp(`\\bdata-${k}="(-?\\d+)"`).exec(tag); v[k] = m ? Math.round(+m[1]) : NaN; }
    if (![v.x, v.y, v.w, v.h].every(Number.isFinite) || v.w < 100 || v.h < 100) continue;
    a = a ? { x: Math.min(a.x, v.x), y: Math.min(a.y, v.y), w: Math.max(a.x + a.w, v.x + v.w) - Math.min(a.x, v.x), h: Math.max(a.y + a.h, v.y + v.h) - Math.min(a.y, v.y) } : v;
  }
  return a;
}

const boxOf = (it) => ({ x: it.x, y: it.y, w: it.w || 1, h: it.h || 1 });
export function bounds(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) { if (it.b === 'arrow') continue; const b = boxOf(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// --- for an AI -----------------------------------------------------------------------------------
// One item as plain data: { id, type, x, y, w, h, color, text (Markdown), … }.
export function itemData(it, ctx = {}) {
  const o = { id: it.id, type: TYPES[it.b] };
  if (it.b !== 'arrow') Object.assign(o, { x: it.x, y: it.y, w: it.w, h: it.h });
  if (it.c) o.color = it.c;
  if (TEXT.has(it.b)) { o.text = toMarkdown(it.html || ''); if (it.s) o.size = it.s; }
  if (it.b === 'arrow') { if (it.from) o.from = it.from; if (it.to) o.to = it.to; if (it.p) o.points = it.p; }
  if (it.b === 'ink') o.points = it.p.length;
  if (it.b === 'img') o.image = it.img;
  if (it.b === 'embed') { o.url = it.embed; o.label = embedOf(it.embed)?.label; }
  if (it.b === 'note') { o.notepad = it.note; const t = ctx.titleOf?.(it.note); if (t) o.title = t; }
  return o;
}
export function describeBoard(html, ctx = {}) {
  const items = parseBoard(html);
  if (!items.length) return 'Whiteboard, empty. Add items with edit_whiteboard.';
  const b = bounds(items);
  const ar = areaOf(html);
  const lines = [`Whiteboard · ${items.length} item${items.length === 1 ? '' : 's'}${b ? `, spanning (${b.x}, ${b.y}) to (${b.x + b.w}, ${b.y + b.h})` : ''}${ar ? `; its area runs from (${ar.x}, ${ar.y}) to (${ar.x + ar.w}, ${ar.y + ar.h}) and grows to fit items placed past it` : ''}. Board pixels: x grows to the right, y downward; later items sit on top.`];
  for (const it of items) {
    const d = itemData(it, ctx), at = it.b === 'arrow' ? '' : ` at (${it.x}, ${it.y}) ${it.w}×${it.h}`, c = it.c ? ' ' + it.c : '';
    let what = '';
    if (TEXT.has(it.b)) what = d.text ? ': ' + d.text.replace(/\n+/g, ' / ') : ' (no text)';
    else if (it.b === 'arrow') what = ` from ${it.from || (it.p ? `(${it.p[0].map(Math.round)})` : '?')} to ${it.to || (it.p ? `(${it.p[1].map(Math.round)})` : '?')}`;
    else if (it.b === 'ink') what = ` (a hand-drawn line, ${it.p.length} points)`;
    else if (it.b === 'img') what = `: sidenote-image:${it.img}`;
    else if (it.b === 'embed') what = `: ${d.label} ${it.embed}`;
    else if (it.b === 'note') what = `: notepad “${d.title || 'deleted'}” (id ${it.note})`;
    lines.push(`- ${TYPES[it.b]} ${it.id}${c}${it.s ? ' size ' + it.s : ''}${at}${what}`);
  }
  return lines.join('\n');
}

// Changes from an AI: add (with optional `ref` names so new arrows can point at new items),
// update by id, remove by id. Items without x/y go in rows under what is already there.
// ctx: { resolveNote(ref) -> id, toHTML ctx }. Returns { items, added, updated, removed }.
export function applyEdits(items, { add = [], update = [], remove = [] } = {}, ctx = {}) {
  const out = items.map((it) => ({ ...it })), refs = new Map(), byId = (id) => out.find((x) => x.id === id);
  const fail = (m) => { throw new Error(m); };
  const textHTML = (t) => cleanText(toHTML(String(t ?? ''), ctx.md || {}));
  const color = (c, what) => { if (c == null) return undefined; if (!colorOk(c)) fail(`${what}: color must be one of ${COLORS.join(', ')} or #rrggbb.`); return c; };
  const target = (r, what) => { if (r == null) return undefined; const s = String(r); if (refs.has(s)) return refs.get(s); if (byId(s)) return s; fail(`${what}: no item “${s}” on this board (use an id from read_notepad or a ref given earlier in add).`); };
  const estimate = (b, w, html, s) => {
    const text = textOf(html || ''), size = b === 'text' ? SIZES[s || 'm'] : 15, per = Math.max(4, Math.floor((w - (b === 'text' ? 0 : 32)) / (size * 0.55)));
    const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0) || 1;
    return Math.ceil(lines * size * (b === 'text' ? 1.3 : 1.4) + (b === 'text' ? 4 : b === 'diamond' ? 70 : 30));
  };
  // Where loose new items go: rows of up to four under the board's current content.
  const b0 = bounds(out);
  let cx = b0 ? b0.x : 0, cy = b0 ? b0.y + b0.h + 80 : 0, rowH = 0, inRow = 0;
  const place = (w, h) => { if (inRow >= 4) { cx = b0 ? b0.x : 0; cy += rowH + 48; rowH = 0; inRow = 0; } const p = { x: cx, y: cy }; cx += w + 48; rowH = Math.max(rowH, h); inRow++; return p; };
  const added = [];
  const arrows = [];
  for (const [i, a] of add.entries()) {
    const what = `add[${i}]`;
    const b = FROM_TYPE[String(a?.type || '').toLowerCase()];
    if (!b) fail(`${what}: type must be one of ${Object.values(TYPES).filter((t) => t !== 'drawing').join(', ')}.`);
    if (b === 'ink') fail(`${what}: drawings can’t be added here; use shapes, stickies and arrows.`);
    const it = { b, id: uid() };
    while (byId(it.id)) it.id = uid();
    if (a.ref != null) refs.set(String(a.ref), it.id);
    if (b === 'arrow') { arrows.push([it, a, what]); out.push(it); added.push(it); continue; }
    const [dw, dh, dc] = DEF[b];
    if (TEXT.has(b)) { it.html = textHTML(a.text); if (b === 'text' && a.size && a.size !== 'm') { if (!SIZES[a.size]) fail(`${what}: size is s, m, l or xl.`); it.s = a.size; } }
    if (b === 'img') { if (!isImgKey(a.image)) fail(`${what}: image needs an image key (img-…) from add_image, or use add_image with the whiteboard directly.`); it.img = a.image; }
    if (b === 'embed') { const e = embedOf(a.url); if (!e) fail(`${what}: url must be a YouTube or Google Drive / Docs / Sheets / Slides / Forms link.`); it.embed = e.canon; }
    if (b === 'note') { const id = ctx.resolveNote?.(a.notepad); if (!id) fail(`${what}: notepad must name an existing notepad (id or title).`); it.note = id; }
    it.w = a.w != null ? clamp(int(a.w), 20, 4000) : b === 'embed' && embedOf(it.embed).ratio < 1 ? 260 : dw;
    const auto = b === 'embed' ? Math.round(it.w / embedOf(it.embed).ratio) + 34 : TEXT.has(b) ? Math.max(b === 'text' ? 0 : dh, estimate(b, it.w, it.html, it.s)) : dh;
    it.h = a.h != null ? clamp(int(a.h), 20, 4000) : auto;
    const c = color(a.color, what) ?? dc;
    if (c && b !== 'img' && b !== 'embed' && b !== 'note') it.c = c;
    if (a.x != null && a.y != null) { it.x = int(a.x); it.y = int(a.y); } else Object.assign(it, place(it.w, it.h));
    out.push(it); added.push(it);
  }
  for (const [it, a, what] of arrows) {
    const from = target(a.from, what), to = target(a.to, what);
    if (!from || !to) fail(`${what}: an arrow needs from and to (item ids or refs).`);
    it.from = from; it.to = to;
    const c = color(a.color, what); if (c && c !== 'ink') it.c = c;
    const A = byId(from), B = byId(to);
    if (A && B) it.p = [[A.x + A.w / 2, A.y + A.h / 2], [B.x + B.w / 2, B.y + B.h / 2]].map(([x, y]) => [r1(x), r1(y)]);
  }
  const updated = [];
  for (const [i, u] of update.entries()) {
    const what = `update[${i}]`, it = byId(String(u?.id || ''));
    if (!it) fail(`${what}: no item “${u?.id}” on this board.`);
    for (const k of ['x', 'y', 'w', 'h']) if (u[k] != null && it.b !== 'arrow') it[k] = k === 'w' || k === 'h' ? clamp(int(u[k]), 8, 4000) : int(u[k]);
    if (u.color != null && !['img', 'embed', 'note'].includes(it.b)) it.c = color(u.color, what);
    if (u.text != null) { if (!TEXT.has(it.b)) fail(`${what}: a ${TYPES[it.b]} has no text.`); it.html = textHTML(u.text); if (u.h == null && it.b !== 'text') it.h = Math.max(it.h, estimate(it.b, it.w, it.html, it.s)); }
    if (u.size != null) { if (it.b !== 'text') fail(`${what}: only text items have a size.`); if (!SIZES[u.size]) fail(`${what}: size is s, m, l or xl.`); if (u.size === 'm') delete it.s; else it.s = u.size; }
    if (u.type != null) { const nb = FROM_TYPE[String(u.type).toLowerCase()]; if (!(TEXT.has(nb) && TEXT.has(it.b) && nb !== 'text' && it.b !== 'text')) fail(`${what}: only a rectangle, ellipse, diamond or sticky can change into one another.`); it.b = nb; }
    if (it.b === 'arrow') { if (u.from != null) it.from = target(u.from, what); if (u.to != null) it.to = target(u.to, what); }
    updated.push(it);
  }
  const gone = new Set();
  for (const id of remove) { if (!byId(String(id))) fail(`remove: no item “${id}” on this board.`); gone.add(String(id)); }
  const kept = out.filter((it) => !gone.has(it.id) && !(it.b === 'arrow' && (gone.has(it.from) || gone.has(it.to))));
  return { items: kept, added, updated, removed: out.length - kept.length };
}
