// Sidenote for AI: open your notepads with the sync key (decrypted in this tab, like the
// extension does) and make a read-only link for chat apps. Everything else on the page
// works without this script, so AI assistants that fetch it read the same instructions.

import { Account, httpTransport, keyFrom, SidenoteError } from '../src/client.js';
import { sanitize, textOf } from '../src/md.js';

const BASE = location.hostname.endsWith('sidenote-sync.netlify.app') ? location.origin : 'https://sidenote-sync.netlify.app'; // drafts are <id>--sidenote-sync…
const PALETTE = { ink: '#45454d', coral: '#e0624c', amber: '#d9962b', olive: '#7c9a3e', teal: '#2f9c8f', sky: '#3d8bd9', iris: '#7b6fd6', rose: '#d6609a' };
const colour = (a) => PALETTE[a] || (/^#[0-9a-f]{6}$/i.test(a || '') ? a : PALETTE.sky);
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

document.documentElement.classList.add('js');

// --- page bits that work without a key ---------------------------------------------------------
for (const t of document.querySelectorAll('.tabs button')) {
  t.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b === t));
    for (const w of document.querySelectorAll('.way')) w.classList.toggle('on', w.id === 'way-' + t.dataset.way);
  });
}
function copyButton(getText) {
  const b = el('button', { className: 'copy', type: 'button', textContent: 'Copy' });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getText()); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => (b.textContent = 'Copy'), 1600);
  });
  return b;
}
for (const pre of document.querySelectorAll('pre.cmd')) {
  const text = [...pre.childNodes].filter((n) => !(n.classList?.contains('c'))).map((n) => n.textContent).join('').replace(/\n{2,}/g, '\n').trim();
  pre.append(copyButton(() => text));
}

// --- the viewer ----------------------------------------------------------------------------------
let acct = null, key = '', current = null;

$('#keyform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = $('#hint'), btn = $('#open');
  btn.disabled = true; btn.textContent = 'Opening…'; hint.classList.remove('err');
  try {
    key = keyFrom($('#key').value);
    acct = await new Account(key, httpTransport(BASE + '/api/sync')).refresh();
    $('#key').value = '';
    showViewer();
  } catch (err) {
    hint.textContent = err instanceof SidenoteError ? err.message : 'Couldn’t reach Sidenote just now. Try again.';
    hint.classList.add('err');
  } finally { btn.disabled = false; btn.textContent = 'Open'; }
});

function showViewer() {
  const rows = acct.list();
  $('#count').textContent = `${rows.length} notepad${rows.length === 1 ? '' : 's'}`;
  $('#viewer').hidden = false;
  $('#share').classList.remove('on');
  $('#filter').value = '';
  renderList(true);
  const first = rows.find((r) => r.starred) || rows[0];
  if (first) show(first.rec.id); else $('#doc').replaceChildren(el('p', { className: 'empty', textContent: 'No notepads yet.' }));
  $('#viewer').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function renderList(enter = false) {
  const q = $('#filter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = acct.list().filter(({ rec: r }) => !q.length || q.every((w) => ((r.doc.title || '') + '\n' + textOf(r.doc.html)).toLowerCase().includes(w)));
  $('#pads').replaceChildren(...rows.map(({ rec: r, depth }, i) => {
    const b = el('button', { type: 'button' }, el('i'), el('span', { textContent: r.doc.title || 'Untitled' }));
    b.dataset.id = r.id;
    b.style.paddingLeft = 10 + (q.length ? 0 : depth * 16) + 'px';
    b.querySelector('i').style.setProperty('--a', colour(r.doc.accent));
    if (r.id === current) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => show(r.id));
    const li = el('li', {}, b);
    if (enter) li.style.animation = `rise .3s ease ${Math.min(i, 12) * 0.025}s both`;
    return li;
  }));
}
$('#filter').addEventListener('input', () => renderList());

function show(id) {
  const r = acct.get(id);
  if (!r?.doc) return;
  current = id;
  const note = el('div', { className: 'note' });
  note.style.setProperty('--a', colour(r.doc.accent));
  note.innerHTML = sanitize(r.doc.html || '');
  for (const a of note.querySelectorAll('a[data-note]')) {
    a.style.setProperty('--chip', colour(a.dataset.accent || acct.get(a.dataset.note)?.doc.accent));
    a.textContent = acct.get(a.dataset.note)?.doc.title || a.textContent;
    a.addEventListener('click', () => show(a.dataset.note));
  }
  for (const a of note.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  const parent = r.doc.parent && acct.get(r.doc.parent);
  const meta = [parent && 'in ' + (parent.doc.title || 'Untitled'), when(r.doc.t) && 'updated ' + when(r.doc.t), r.view && 'view only'].filter(Boolean).join(' · ');
  const doc = $('#doc');
  doc.replaceChildren(el('h2', { className: 'title', textContent: r.doc.title || 'Untitled' }), el('div', { className: 'meta', textContent: meta }), note);
  doc.animate?.([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220, easing: 'ease-out' });
  doc.scrollTop = 0;
  for (const b of document.querySelectorAll('.pads button')) b.toggleAttribute('aria-current', b.dataset.id === id);
}

// --- a read-only link for chat apps --------------------------------------------------------------
$('#mklink').addEventListener('click', async () => {
  const box = $('#share'), btn = $('#mklink');
  btn.disabled = true;
  try {
    const r = await fetch(BASE + '/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    const out = await r.json();
    if (!r.ok) throw new SidenoteError(out.error || 'Couldn’t make a link just now.');
    const copy = el('button', { className: 'btn', type: 'button', textContent: 'Copy link' });
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(out.url); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select it above'; } });
    box.replaceChildren(
      el('b', { textContent: 'Paste this into ChatGPT, Claude or Gemini' }),
      el('code', { textContent: out.url }),
      el('div', { className: 'row' }, copy, el('a', { className: 'btn ghost', href: out.turn_off, textContent: 'Turn links off' })),
      el('p', { className: 'fine', textContent: 'Read only. Anyone with the link can read these notes until you turn links off. Making it sent your key to Sidenote’s server once, sealed inside the link; the server opens it only while a chat reads your notes.' }),
    );
    box.classList.add('on');
  } catch (err) {
    box.replaceChildren(el('p', { className: 'err', textContent: err instanceof SidenoteError ? err.message : 'Couldn’t reach Sidenote just now. Try again.' }));
    box.classList.add('on');
  } finally { btn.disabled = false; }
});

$('#close').addEventListener('click', () => {
  acct = null; key = ''; current = null;
  $('#viewer').hidden = true;
  $('#pads').replaceChildren(); $('#doc').replaceChildren(); $('#share').replaceChildren();
  window.scrollTo({ top: 0 });
  $('#key').focus();
});
