// Sidenote for AI: the key box opens Sidenote on the web (/notes, the key in the address
// after #, which never reaches a server) or makes a read-only link for chat apps.
// Everything else on the page works without this script, so AI assistants that fetch it
// read the same instructions.

import { SidenoteError } from '../src/client.js';
import { parseKey } from '../src/keys.js';

const BASE = location.hostname.endsWith('sidenote-sync.netlify.app') ? location.origin : 'https://sidenote-sync.netlify.app'; // drafts are <id>--sidenote-sync…
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

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

// --- the key box ---------------------------------------------------------------------------------
const keyOf = (kinds) => {
  const k = parseKey($('#key').value);
  if (k && kinds.includes(k.kind)) return k.key;
  const hint = $('#hint');
  hint.textContent = kinds.length > 1 ? 'That isn’t a Sidenote key. It starts with “sync-”, “pad-” or “view-”.' : 'A chat link needs your sync key (it starts with “sync-”).';
  hint.classList.add('err');
  return null;
};

$('#keyform').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = keyOf(['sync', 'pad', 'view']);
  if (key) location.assign('/notes/#' + key);
});

$('#mklink').addEventListener('click', async () => {
  const key = keyOf(['sync']), box = $('#share'), btn = $('#mklink');
  if (!key) return;
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
  } catch (err) {
    box.replaceChildren(el('p', { className: 'err', textContent: err instanceof SidenoteError ? err.message : 'Couldn’t reach Sidenote just now. Try again.' }));
  } finally { btn.disabled = false; box.classList.add('on'); }
});
