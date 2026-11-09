// Notepad HTML <-> Markdown, for AI tools.
//
// Sidenote stores a notepad as HTML with a small, fixed vocabulary (see the extension's
// src/editor.js): p, h1-h3, ul/ol/ul.todo > li, blockquote, hr, pre, table, toggles
// (details > summary + div.dt), and inline b, i, u, s, code, mark, links, note links
// (a[data-note]), reminders (time[data-at]) and mentions (span[data-m]).
//
// The Markdown here is chosen so that HTML -> Markdown -> HTML gives the same note back,
// so an AI can read a notepad, change one line, and write it back without losing the
// rest. Things Markdown has no syntax for travel as the inline HTML GitHub also uses:
//   <font size="5">bigger</font>  text size 1–7 (3 is normal; 1 small, 7 huge)
//   <u>underline</u>  ==highlight==  [Title](sidenote:<id>) links another notepad
//   <time data-at="1767225600000">Jan 1, 9:00 AM</time>  a reminder (epoch ms)
//   <span data-m="person">Ana</span>  a mention (person or place)
//   <details><summary>Toggle</summary> … </details>  a toggle, Markdown inside
//   ## Heading <!--fold-->  a folded heading;  a line with just <br>  an empty line
//   ![image](sidenote-image:img-… "1600x1050")  an image (add " small" or " medium" to the title for its size)
//   ![YouTube](https://www.youtube.com/watch?v=…)  a video or Google Drive / Docs file shown in a frame
// Every line is its own paragraph (as when typing in Sidenote); blank lines only separate.
// No DOM needed: a small tokenizer, so this runs in Node, Deno and edge runtimes.

import { isImgKey, embedOf } from './media.js';

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'col', 'area', 'base', 'embed', 'source', 'track', 'param']);
const INLINE = new Set(['#text', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'code', 'mark', 'a', 'time', 'span', 'br', 'font', 'sub', 'sup', 'small', 'big', 'abbr', 'label', 'img']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decode(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
const escA = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');

// --- HTML: parse, clean, serialize ----------------------------------------------------
const TAG = /<!--[\s\S]*?(?:-->|$)|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+|</g;
function attrsOf(s) {
  const o = {}, re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s || ''))) { const k = m[1].toLowerCase(); if (!(k in o)) o[k] = decode(m[2] ?? m[3] ?? m[4] ?? ''); }
  return o;
}
export function parse(html) {
  const root = { tag: '#root', attrs: {}, kids: [] }, stack = [root];
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html || ''))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) { const i = stack.map((n) => n.tag).lastIndexOf(m[1].toLowerCase()); if (i > 0) stack.length = i; continue; }
    if (m[2]) {
      const n = { tag: m[2].toLowerCase(), attrs: attrsOf(m[3]), kids: [] };
      top.kids.push(n);
      if (!VOID.has(n.tag) && !m[4]) stack.push(n);
      continue;
    }
    const last = top.kids[top.kids.length - 1];
    if (last?.tag === '#text') last.text += decode(m[0]); else top.kids.push({ tag: '#text', text: decode(m[0]) });
  }
  return root;
}
export function serialize(node) {
  return node.kids.map((n) => n.tag === '#text' ? escT(n.text)
    : `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escA(v)}"`).join('')}>${VOID.has(n.tag) ? '' : serialize(n) + `</${n.tag}>`}`).join('');
}

// Keep only what the editor keeps (the same lists as its sanitize()).
const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'code', 'mark', 'a', 'time', 'span', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'div', 'pre', 'figure', 'font']);
const KEEP = { time: ['data-at', 'data-done'], span: ['data-m'], a: ['href', 'data-note', 'data-accent'], li: ['data-checked'], ul: ['class'], details: ['open'], div: ['class'], h1: ['data-fold'], h2: ['data-fold'], h3: ['data-fold'], figure: ['data-img', 'data-w', 'data-h', 'data-size', 'data-embed'], font: ['size'] };
const DROP = new Set(['script', 'style', 'img', 'iframe', 'svg', 'video', 'audio', 'object', 'embed', 'meta', 'link', 'input', 'button', 'select', 'textarea', 'canvas', 'template', 'noscript']);
function clean(node) {
  const out = [];
  for (const n of node.kids) {
    if (n.tag === '#text') { out.push(n); continue; }
    if (DROP.has(n.tag)) continue;
    n.kids = clean(n);
    let tag = { h4: 'h3', h5: 'h3', h6: 'h3', del: 'strike' }[n.tag] || n.tag;
    const ok = ALLOWED.has(tag)
      && !(tag === 'time' && !/^\d{10,}$/.test(n.attrs['data-at'] || ''))
      && !(tag === 'span' && !/^(person|place)$/.test(n.attrs['data-m'] || ''))
      && !(tag === 'font' && !/^[124567]$/.test(n.attrs.size || ''))
      && !(tag === 'a' && !n.attrs['data-note'] && !/^(https?:|mailto:)/i.test(n.attrs.href || ''))
      && !(tag === 'div' && n.attrs.class !== 'dt');
    if (!ok) { out.push(...n.kids); continue; }
    const attrs = {};
    for (const k of KEEP[tag] || []) if (k in n.attrs) attrs[k] = n.attrs[k];
    if (tag === 'a' && attrs['data-note']) delete attrs.href;
    if (tag === 'ul' && attrs.class !== 'todo') delete attrs.class;
    if (tag === 'li' && attrs['data-checked'] !== 'true') delete attrs['data-checked'];
    if (tag === 'figure') { // an image or an embed, always empty
      const emb = embedOf(attrs['data-embed']);
      if (attrs['data-img'] ? !isImgKey(attrs['data-img']) : !emb) continue;
      if (attrs['data-img']) delete attrs['data-embed']; else attrs['data-embed'] = emb.canon;
      for (const k of ['data-w', 'data-h']) if (k in attrs && !/^\d{1,5}$/.test(attrs[k])) delete attrs[k];
      if ('data-size' in attrs && !/^[sm]$/.test(attrs['data-size'])) delete attrs['data-size'];
      out.push({ tag, attrs, kids: [] });
      continue;
    }
    out.push({ tag, attrs, kids: n.kids });
  }
  return out;
}
export function sanitize(html) { const root = parse(html); root.kids = clean(root); return serialize(root); }

// Plain text of a notepad, one line per block (for search and previews).
export function textOf(html) {
  const out = [];
  const walk = (n) => {
    for (const k of n.kids) {
      if (k.tag === '#text') { out.push(k.text.replace(/\s+/g, ' ')); continue; }
      if (k.tag === 'br') { out.push('\n'); continue; }
      if (k.tag === 'figure') { const e = embedOf(k.attrs['data-embed']); out.push(k.attrs['data-img'] ? '\n[image]\n' : e ? `\n[${e.label}] ${e.canon}\n` : ''); continue; }
      const block = !INLINE.has(k.tag);
      if (block) out.push('\n');
      if (k.tag === 'li' && k.attrs['data-checked'] === 'true') out.push('[x] ');
      walk(k);
      if (block) out.push('\n');
    }
  };
  walk(parse(html));
  return out.join('').replace(/\u00a0/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

// --- HTML -> Markdown -------------------------------------------------------------------
const textIn = (n) => n.tag === '#text' ? n.text : n.tag === 'br' ? '\n' : n.kids.map(textIn).join('');
const isWord = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);

function escText(s) {
  let out = s
    .replace(/[\\`*[\]]/g, '\\$&')
    .replace(/~(?=~)/g, '\\~').replace(/=(?==)/g, '\\=')
    .replace(/<(?=[a-zA-Z/!])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&')
    .replace(/\b(https?):\/\//gi, '$1\\://');
  // An underscore only starts or ends italics at a word boundary, so only those need a backslash.
  out = out.replace(/_/g, (m, i, str) => (isWord(str[i - 1]) && isWord(str[i + 1]) ? '_' : '\\_'));
  return out;
}
// Emphasis hugs its text; the spaces at either end move outside the markers.
function wrap(d, s, d2 = d) {
  const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(s);
  return m[2] ? `${m[1]}${d}${m[2]}${d2}${m[3]}` : s;
}
function codeSpan(t) {
  if (!t) return '';
  const runs = t.match(/`+/g) || [], n = runs.length ? Math.max(...runs.map((r) => r.length)) + 1 : 1, f = '`'.repeat(n);
  return n > 1 || /^ | $/.test(t) ? `${f} ${t} ${f}` : `${f}${t}${f}`;
}
function urlOut(u) {
  u = u.replace(/ /g, '%20');
  return (u.match(/\(/g) || []).length === (u.match(/\)/g) || []).length ? u : u.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function inline(kids) {
  let s = '';
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.tag === '#text') { s += escText(n.text.replace(/[\n\t\r]+/g, ' ')); continue; }
    s += inlNode(n, s, kids[i + 1]);
  }
  return s;
}
function inlNode(n, before, next) {
  const inner = () => inline(n.kids);
  switch (n.tag) {
    case 'br': return '<br>';
    case 'b': case 'strong': return wrap('**', inner());
    case 'i': case 'em': {
      // _x_ unless a letter touches it from outside (then *x*): keeps **_x_** unambiguous.
      const after = next ? (next.tag === '#text' ? next.text[0] : 'x') : '';
      return wrap(isWord(before.slice(-1)) || isWord(after) ? '*' : '_', inner());
    }
    case 'u': { const x = inner(); return x ? `<u>${x}</u>` : ''; }
    case 'font': { const x = inner(); return !x ? '' : /^[124567]$/.test(n.attrs.size || '') ? `<font size="${n.attrs.size}">${x}</font>` : x; }
    case 's': case 'strike': case 'del': return wrap('~~', inner());
    case 'mark': return wrap('==', inner());
    case 'code': return codeSpan(textIn(n).replace(/\n/g, ' '));
    case 'a': {
      if (n.attrs['data-note']) return `[${escText(textIn(n).replace(/\s+/g, ' ').trim())}](sidenote:${n.attrs['data-note']})`;
      const href = n.attrs.href || '', x = inner();
      if (!/^(https?:|mailto:)/i.test(href)) return x;
      if (/^https?:\/\//i.test(href) && textIn(n) === href && !/[\s<]/.test(href)) return href;
      return `[${x || escText(href)}](${urlOut(href)})`;
    }
    case 'time':
      if (!/^\d{10,}$/.test(n.attrs['data-at'] || '')) return inner();
      return `<time data-at="${n.attrs['data-at']}"${'data-done' in n.attrs ? ` data-done="${escA(n.attrs['data-done'])}"` : ''}>${escT(textIn(n))}</time>`;
    case 'span':
      if (/^(person|place)$/.test(n.attrs['data-m'] || '')) return `<span data-m="${n.attrs['data-m']}">${escT(textIn(n))}</span>`;
      return inner();
    case 'img': return '';
    default: return INLINE.has(n.tag) ? inner() : blockInline(n.kids);
  }
}
// Inline content of something that may hold blocks (a list item or cell holding <p>s): blocks joined by <br>.
function blockInline(kids) {
  const parts = [];
  let run = [];
  const flush = () => { if (run.length) { parts.push(inline(run)); run = []; } };
  for (const k of kids) {
    if (INLINE.has(k.tag)) { run.push(k); continue; }
    flush();
    parts.push(blockInline(k.kids));
  }
  flush();
  return trimBr(parts.filter((p) => p !== '').join('<br>'));
}
const trimBr = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '').replace(/(?:<br>)+$/, '').replace(/[ \t]+$/, '');

// A paragraph's text can't start like another block, so that it reads back as a paragraph.
function para(s) {
  if (/^(#{1,6}([ \t]|$)|>|[-*+]([ \t]|$)|`{3}|~{3}|\|)/.test(s) || /^([-*_])([ \t]*\1){2,}[ \t]*$/.test(s)) return '\\' + s;
  const m = /^(\d{1,9})([.)])([ \t]|$)/.exec(s);
  return m ? m[1] + '\\' + s.slice(m[1].length) : s;
}

function blocks(kids) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const s = trimBr(inline(run));
    if (s.replace(/<br>/g, '').trim()) out.push({ p: true, s: para(s) });
    run = [];
  };
  for (const n of kids) {
    if (INLINE.has(n.tag) && n.tag !== 'br') { run.push(n); continue; }
    if (n.tag === 'br') { if (run.length) run.push(n); else out.push({ p: true, s: '<br>' }); continue; }
    flush();
    out.push(...block(n));
  }
  flush();
  return out;
}
const joinBlocks = (chunks) => chunks.map((c, i) => (i ? (c.p && chunks[i - 1].p ? '\n' : '\n\n') : '') + c.s).join('');
const hasBlocks = (n) => n.kids.some((k) => !INLINE.has(k.tag));

function block(n) {
  switch (n.tag) {
    case 'p': case 'div': {
      if (n.tag === 'div' && hasBlocks(n)) return blocks(n.kids);
      const s = blockInline(n.kids);
      return [{ p: true, s: s.replace(/<br>/g, '').replace(/\u00a0/g, ' ').trim() ? para(s) : '<br>' }];
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const lvl = Math.min(3, +n.tag[1]);
      return [{ s: `${'#'.repeat(lvl)} ${blockInline(n.kids)}${'data-fold' in n.attrs ? ' <!--fold-->' : ''}`.replace(/ $/, '') }];
    }
    case 'ul': case 'ol': { const lines = []; list(n, '', lines); return lines.length ? [{ s: lines.join('\n') }] : []; }
    case 'blockquote': {
      const s = hasBlocks(n) ? blockInline(n.kids) : trimBr(inline(n.kids));
      return [{ s: s.split('<br>').map((l) => ('> ' + l).replace(/[ \t]+$/, '')).join('\n') }];
    }
    case 'hr': return [{ s: '---' }];
    case 'pre': {
      const t = textIn(n).replace(/\n$/, ''), runs = t.match(/^`{3,}/gm) || [];
      const f = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
      return [{ s: `${f}\n${t}\n${f}` }];
    }
    case 'table': return table(n);
    case 'details': {
      const sum = n.kids.find((k) => k.tag === 'summary');
      const dt = n.kids.find((k) => k.tag === 'div' && k.attrs.class === 'dt');
      const body = dt ? dt.kids : n.kids.filter((k) => k !== sum);
      const inner = joinBlocks(blocks(body));
      return [{ s: `<details${'open' in n.attrs ? ' open' : ''}>\n<summary>${sum ? blockInline(sum.kids) : ''}</summary>\n${inner ? '\n' + inner + '\n' : ''}\n</details>` }];
    }
    case 'li': return [{ s: '- ' + blockInline(n.kids) }];
    case 'figure': {
      if (isImgKey(n.attrs['data-img'])) {
        const t = [n.attrs['data-w'] && n.attrs['data-h'] ? `${n.attrs['data-w']}x${n.attrs['data-h']}` : '', { s: 'small', m: 'medium' }[n.attrs['data-size']] || ''].filter(Boolean).join(' ');
        return [{ s: `![image](sidenote-image:${n.attrs['data-img']}${t ? ` "${t}"` : ''})` }];
      }
      const e = embedOf(n.attrs['data-embed']);
      return e ? [{ s: `![${e.label}](${urlOut(e.canon)})` }] : [];
    }
    default: return blocks(n.kids);
  }
}

// Lists: nested lists go one marker's width deeper. Chrome nests an indented list next to
// the item (<ul><li>a</li><ul>…</ul></ul>); a list inside the <li> reads the same. A list
// before any item skips a level (Tab twice: <ul><ul><li>) and goes 4 deeper, past the 2–5
// spaces one level takes, so toHTML can rebuild it.
function list(n, ind, lines) {
  const ordered = n.tag === 'ol', todo = !ordered && n.attrs.class === 'todo';
  let i = 0, width = 4;
  for (const c of n.kids) {
    if (c.tag === '#text') { if (c.text.trim()) { lines.push(ind + '- ' + escText(c.text.trim())); width = 2; } continue; }
    if (c.tag === 'ul' || c.tag === 'ol') { list(c, ind + ' '.repeat(width), lines); continue; }
    i++;
    const marker = ordered ? `${i}. ` : todo ? `- [${c.attrs['data-checked'] === 'true' ? 'x' : ' '}] ` : '- ';
    width = ordered ? marker.length : 2;
    const own = c.kids.filter((k) => k.tag !== 'ul' && k.tag !== 'ol');
    lines.push((ind + marker + blockInline(own)).replace(/[ \t]+$/, ''));
    for (const k of c.kids) if (k.tag === 'ul' || k.tag === 'ol') list(k, ind + ' '.repeat(width), lines);
  }
}

function table(n) {
  const rows = [];
  const walk = (x) => { for (const k of x.kids) { if (k.tag === 'tr') rows.push(k.kids.filter((c) => c.tag === 'td' || c.tag === 'th')); else if (k.tag !== '#text') walk(k); } };
  walk(n);
  const real = rows.filter((r) => r.length);
  if (!real.length) return [];
  const cols = Math.max(...real.map((r) => r.length));
  const cell = (c) => (c ? blockInline(c.kids).replace(/\|/g, '\\|') : '');
  const line = (r) => '| ' + Array.from({ length: cols }, (_, i) => cell(r[i])).join(' | ') + ' |';
  const out = [line(real[0]), '| ' + Array(cols).fill('---').join(' | ') + ' |', ...real.slice(1).map(line)];
  return [{ s: out.map((l) => l.replace(/ {2,}\|/g, ' |').replace(/\| {2,}/g, '| ')).join('\n') }];
}

export function toMarkdown(html) { return joinBlocks(blocks(parse(html || '').kids)); }

// --- Markdown -> HTML -------------------------------------------------------------------
const PUNCT = /[!-/:-@[-`{-~]/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(?:\[([ xX])\](?=[ \t]|$)[ \t]*)?(.*)|[ \t]*)$/;
const BARE_TODO = /^([ \t]*)\[([ xX])\](?:[ \t]+(.*)|[ \t]*)$/;
const DELIM = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

export function toHTML(md, ctx = {}) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  return sanitize(mdBlocks(lines, ctx));
}

function itemOf(l) {
  let m = ITEM.exec(l);
  if (m && !/^([-*_])([ \t]*\1){2,}[ \t]*$/.test(l.trim())) {
    const ol = /\d/.test(m[2]);
    return { ind: m[1].replace(/\t/g, '    ').length, w: ol ? m[2].length + 1 : 2, type: ol ? 'ol' : m[3] != null ? 'todo' : 'ul', checked: m[3] != null && m[3] !== ' ', text: m[4] || '' };
  }
  if ((m = BARE_TODO.exec(l))) return { ind: m[1].replace(/\t/g, '    ').length, w: 2, type: 'todo', checked: m[2] !== ' ', text: m[3] || '' };
  return null;
}

function mdBlocks(lines, ctx) {
  let out = '', i = 0, m;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if ((m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(l))) {
      const close = new RegExp(`^[ \\t]{0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}[ \\t]*$`), body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out += `<pre>${escT(body.join('\n'))}</pre>`;
      continue;
    }
    if ((m = /^[ \t]*<details(\s+open(?:="[^"]*")?)?\s*>(.*)$/i.exec(l))) { const r = details(lines, i, m, ctx); out += r.html; i = r.next; continue; }
    if ((m = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(l))) {
      let t = m[2] || '', fold = false;
      const f = /[ \t]*<!--[ \t]*fold[ \t]*-->$/i.exec(t);
      if (f) { fold = true; t = t.slice(0, f.index); }
      const n = Math.min(3, m[1].length);
      out += `<h${n}${fold ? ' data-fold=""' : ''}>${inl(t, ctx) || '<br>'}</h${n}>`;
      i++; continue;
    }
    if (/^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(l)) { out += '<hr>'; i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(l), rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      const cols = head.length, td = (tag, c) => `<${tag}>${inl(c || '', ctx) || '<br>'}</${tag}>`;
      out += '<table><tbody>' + [head, ...rows].map((r, j) => '<tr>' + Array.from({ length: cols }, (_, k) => td(j ? 'td' : 'th', r[k])).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    if (/^[ \t]{0,3}>/.test(l)) {
      const parts = [];
      for (; i < lines.length && /^[ \t]{0,3}>/.test(lines[i]); i++) parts.push(lines[i].replace(/^[ \t]{0,3}> ?/, '').replace(/[ \t]+$/, ''));
      out += `<blockquote>${parts.map((p) => inl(p, ctx)).join('<br>') || '<br>'}</blockquote>`;
      continue;
    }
    if (itemOf(l)) { const r = listBlock(lines, i, ctx); out += r.html; i = r.next; continue; }
    if (/^[ \t]*<br\s*\/?>[ \t]*$/i.test(l)) { out += '<p><br></p>'; i++; continue; }
    if ((m = /^[ \t]{0,3}!\[([^\]]*)\]\((\S+?)(?:[ \t]+"([^"]*)")?\)[ \t]*$/.exec(l))) { out += figure(m[1], m[2], m[3] || ''); i++; continue; }
    out += `<p>${inl(l.replace(/^[ \t]+|[ \t]+$/g, ''), ctx) || '<br>'}</p>`;
    i++;
  }
  return out;
}

// A line that is just ![alt](address): an image kept by Sidenote, or a video / Drive file in
// a frame. Any other picture address can't be shown (Sidenote keeps images itself), so it
// becomes a link.
function figure(alt, url, title) {
  const img = /^sidenote-image:(img-[\w-]+)$/.exec(url);
  if (img && isImgKey(img[1])) {
    const d = /(\d{1,5})\s*[x×]\s*(\d{1,5})/.exec(title), sz = /\bsmall\b/i.test(title) ? 's' : /\bmedium\b/i.test(title) ? 'm' : '';
    return `<figure data-img="${img[1]}"${d ? ` data-w="${d[1]}" data-h="${d[2]}"` : ''}${sz ? ` data-size="${sz}"` : ''}></figure>`;
  }
  const e = embedOf(url);
  if (e) return `<figure data-embed="${escA(e.canon)}"></figure>`;
  return /^https?:\/\//i.test(url) ? `<p><a href="${escA(url)}">${escT(alt.trim() || url)}</a></p>` : `<p>${escT(alt)}</p>`;
}

// trim() would also eat the &nbsp; Chrome leaves at the edge of a list item or cell.
const trimST = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '');

function cells(l) {
  let s = trimST(l);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { out.push(trimST(cur)); cur = ''; continue; }
    cur += s[i];
  }
  out.push(trimST(cur));
  return out;
}

function details(lines, i, m, ctx) {
  const open = !!m[1];
  let rest = m[2].trim(), summary = '', j = i + 1;
  const sm = /^<summary>([\s\S]*?)<\/summary>(.*)$/i.exec(rest);
  if (sm) { summary = sm[1]; rest = sm[2].trim(); }
  else {
    while (j < lines.length && !lines[j].trim()) j++;
    const s2 = j < lines.length && /^[ \t]*<summary>([\s\S]*?)<\/summary>[ \t]*$/i.exec(lines[j]);
    if (s2) { summary = s2[1]; j++; } else j = i + 1;
  }
  const body = [];
  let depth = 1;
  if (rest) {
    const end = rest.search(/<\/details>/i);
    if (end >= 0) { body.push(rest.slice(0, end)); depth = 0; } else body.push(rest);
  }
  for (; depth && j < lines.length; j++) {
    const l = lines[j];
    if (/^[ \t]*<details[\s>]/i.test(l)) depth++;
    if (/<\/details>[ \t]*$/i.test(l) && !--depth) { const before = l.replace(/<\/details>[ \t]*$/i, ''); if (before.trim()) body.push(before); j++; break; }
    body.push(l);
  }
  const inner = mdBlocks(body, ctx);
  return { html: `<details${open ? ' open=""' : ''}><summary>${inl(summary.trim(), ctx) || '<br>'}</summary><div class="dt">${inner || '<p><br></p>'}</div></details>`, next: j };
}

function listBlock(lines, i, ctx) {
  const items = [];
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { // a blank line ends the list unless another item follows it
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && itemOf(lines[j])) { i = j; continue; }
      break;
    }
    const it = itemOf(l);
    if (!it) {
      if (items.length && /^[ \t]+\S/.test(l) && !/^[ \t]*(```|~~~|<details|>|#{1,6}[ \t])/.test(l)) { items[items.length - 1].text += ' ' + l.trim(); i++; continue; }
      break;
    }
    items.push(it);
    i++;
  }
  let html = '';
  const stack = [];
  const open = (it) => { stack.push(it); html += it.type === 'ol' ? '<ol>' : it.type === 'todo' ? '<ul class="todo">' : '<ul>'; };
  const close = () => { html += stack.pop().type === 'ol' ? '</ol>' : '</ul>'; };
  for (const it of items) {
    while (stack.length > 1 && it.ind < stack[stack.length - 1].ind) close();
    const top = stack[stack.length - 1];
    if (!top || it.ind > top.ind) {
      // Each 4 spaces past one level's indent is a level list() skipped: open an empty list for it.
      const base = top ? top.ind + top.w : 0;
      for (let k = 0; k < Math.floor((it.ind - base) / 4); k++) open({ type: it.type, ind: base + 4 * k, w: 2 });
      open(it);
    } else if (it.type !== top.type) { close(); open({ ...it, ind: top.ind }); }
    stack[stack.length - 1].w = it.w;
    html += `<li${it.type === 'todo' && it.checked ? ' data-checked="true"' : ''}>${inl(trimST(it.text), ctx) || '<br>'}</li>`;
  }
  while (stack.length) close();
  return { html, next: i };
}

// Inline Markdown. Emphasis needs text right inside its markers (`2 * 3 * 4` stays as is);
// _x_ only at word boundaries, so snake_case stays.
function findClose(s, from, d) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { const run = /^`+/.exec(s.slice(j))[0], k = s.indexOf(run, j + run.length); if (k > 0) { j = k + run.length - 1; continue; } }
    if (!s.startsWith(d, j)) continue;
    if (d === '*' || d === '_') {
      if (s[j + 1] === d) { j++; continue; } // part of ** / __
      if (/\s/.test(s[j - 1])) continue;
      if (d === '_' && isWord(s[j + 1])) continue;
      return j;
    }
    let run = 0;
    while (s[j + run] === d[0]) run++;
    if (/\s/.test(s[j - 1])) { j += run - 1; continue; }
    return j + run - d.length; // ***: the last two close a bold that holds an italic
  }
  return -1;
}

const INLINE_TAG = [
  [/^<br\s*\/?>/i, () => '<br>'],
  [/^<!--[\s\S]*?-->/, () => ''],
  [/^<(\/?)(b|strong|i|em|u|s|strike|del|code|mark)\s*>/i, (m) => `<${m[1]}${m[2].toLowerCase()}>`],
  [/^<font\s+size="([124567])"\s*>/i, (m) => `<font size="${m[1]}">`],
  [/^<\/font\s*>/i, () => '</font>'],
  [/^<time\s+data-at="(\d{10,})"(?:\s+data-done(?:="([^"]*)")?)?\s*>([^<]*)<\/time>/i, (m) => `<time data-at="${m[1]}"${/data-done/i.test(m[0]) ? ` data-done="${escA(decode(m[2] || ''))}"` : ''}>${escT(decode(m[3]))}</time>`],
  [/^<span\s+data-m="(person|place)"\s*>([^<]*)<\/span>/i, (m) => `<span data-m="${m[1]}">${escT(decode(m[2]))}</span>`],
  [/^<a\s+href="((?:https?:|mailto:)[^"]*)"\s*>/i, (m) => `<a href="${escA(decode(m[1]))}">`],
  [/^<\/a\s*>/i, () => '</a>'],
];

function linkAt(s, i, ctx) {
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '[') depth++;
    else if (s[j] === ']' && !--depth) break;
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  let k = j + 2, par = 0, url = '';
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '(') par++;
    else if (c === ')') { if (!par) break; par--; }
    else if (/\s/.test(c)) break;
    url += c;
  }
  if (k >= s.length) return null;
  if (s[k] !== ')') { const t = /^\s+"[^"]*"\s*\)/.exec(s.slice(k)); if (!t) return null; k += t[0].length - 1; }
  const label = s.slice(i + 1, j);
  let html;
  const note = /^sidenote:([\w-]{1,64})$/.exec(url);
  if (note) {
    const acc = ctx.accentOf?.(note[1]);
    html = `<a data-note="${escA(note[1])}"${acc ? ` data-accent="${escA(acc)}"` : ''}>${escT(label.replace(/\\(.)/g, '$1')) || escT(ctx.titleOf?.(note[1]) || 'Untitled')}</a>`;
  } else if (/^(https?:|mailto:)/i.test(url)) html = `<a href="${escA(url)}">${inl(label, ctx, true) || escT(url)}</a>`;
  else html = inl(label, ctx, true);
  return { html, len: k + 1 - i };
}

function inl(s, ctx, inLink = false) {
  let out = '', i = 0;
  const pair = (d, tag) => {
    if (!s.startsWith(d, i) || /\s/.test(s[i + d.length] || ' ')) return false;
    if (d[0] === '_' && isWord(s[i - 1])) return false;
    const j = findClose(s, i + d.length, d);
    if (j <= i + d.length) return false;
    out += `<${tag}>${inl(s.slice(i + d.length, j), ctx, inLink)}</${tag}>`;
    i = j + d.length;
    return true;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { out += escT(s[i + 1]); i += 2; continue; }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))[0], j = s.indexOf(run, i + run.length);
      if (j > 0 && s[j + run.length] !== '`') {
        let code = s.slice(i + run.length, j);
        if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out += `<code>${escT(code)}</code>`;
        i = j + run.length;
      } else { out += run; i += run.length; }
      continue;
    }
    if (c === '<') {
      const rest = s.slice(i), hit = INLINE_TAG.find(([re]) => re.test(rest));
      if (hit && !(inLink && /^<\/?a/i.test(rest))) { const m = hit[0].exec(rest); out += hit[1](m); i += m[0].length; continue; }
      out += '&lt;'; i++; continue;
    }
    if (c === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/.exec(s.slice(i));
      if (m && decode(m[0]) !== m[0]) { out += escT(decode(m[0])); i += m[0].length; continue; }
      out += '&amp;'; i++; continue;
    }
    if (!inLink && (c === 'h' || c === 'H') && !isWord(s[i - 1]) && /^https?:\/\//i.test(s.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<]*[^\s<.,;:!?'"*_~)\]]/i.exec(s.slice(i));
      if (m) {
        let u = m[0];
        while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
        out += `<a href="${escA(u)}">${escT(u)}</a>`; i += u.length; continue;
      }
    }
    if (c === '[' && !inLink) { const l = linkAt(s, i, ctx); if (l) { out += l.html; i += l.len; continue; } }
    if (pair('**', 'b') || pair('__', 'b') || pair('~~', 'strike') || pair('==', 'mark')) continue;
    if ((c === '*' && s[i + 1] !== '*') || (c === '_' && s[i + 1] !== '_')) { if (pair(c, 'i')) continue; }
    out += escT(c);
    i++;
  }
  return out;
}
