// The hosted connector: MCP over Streamable HTTP, with OAuth 2.1 so ChatGPT, claude.ai,
// the Gemini app and other clients can connect by URL.
//
// No accounts and no database. When someone connects, the consent page asks for their
// Sidenote sync key; the authorization code and the tokens carry that key sealed with the
// server's secret (AES-GCM), so the AI app never sees the key itself and nothing is stored.
// Each MCP request opens the key, reads or writes the notes it needs, and forgets them.
// That means notes are decrypted on this server while a request runs; the local server
// (server/index.js) keeps them on your computer instead.
//
// Clients register with a Client ID Metadata Document (an https client_id) or dynamic
// client registration (the client_id is itself a sealed record of the redirect URIs).
// Tokens: access 1 hour, refresh 180 days and rotated. "Disconnect" records a time per
// key; refresh tokens issued before it stop working.
//
// Links for chat apps: POST /link with a sync key returns a read-only URL (/r/<sealed key>)
// that any chat app able to open web pages can read, as plain text. Disconnect turns
// those off too.
//
// createRemote({ transport, secret, store, base?, admit? }) -> (Request) => Response
//   transport: the /api/sync items function (see client.js)
//   store: { get(key) -> string|null, set(key, value), setIfNew(key, value) -> boolean }
//   admit: () -> boolean|Promise, asked once per signed-in request (the host's daily budget)

import { Account, keyFrom, SidenoteError } from './client.js';
import { derive, open as openBlob, hex, sha } from './keys.js';
import { handle as rpc, SERVER_INFO } from './rpc.js';
import { dumpAll } from './tools.js';

const te = new TextEncoder(), td = new TextDecoder();
const ACCESS_TTL = 3600, REFRESH_TTL = 180 * 86400, CODE_TTL = 300;
const SCOPES = ['notes:read', 'notes:write'];
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'Access-Control-Expose-Headers': 'www-authenticate, mcp-session-id',
  'Access-Control-Max-Age': '86400',
};
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status);
const RESTING = 'Sidenote’s connector is resting until tomorrow (its daily limit was reached). Notes are safe; try again later.';

// Loopback redirect URIs match whatever port the app picked (RFC 8252).
function sameRedirect(registered, given) {
  if (registered === given) return true;
  try {
    const a = new URL(registered), b = new URL(given);
    const loop = (u) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return loop(a) && loop(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}
// Where the well-known AI apps send people back. Anything else gets a warning on the
// consent page, since a sign-in link can be sent by anyone.
const KNOWN = /^(claude\.ai|claude\.com|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|[\w-]+\.gemini\.google\.com|vertexaisearch\.cloud\.google\.com|vscode\.dev|insiders\.vscode\.dev|localhost|127\.0\.0\.1|\[::1\])$/;
const knownApp = (uri) => { try { const u = new URL(uri); return KNOWN.test(u.hostname) || /^(cursor|vscode|vscode-insiders|windsurf|zed):$/.test(u.protocol); } catch { return false; } };
function okRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    if (x.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
    return /^[a-z][a-z0-9+.-]*:$/.test(x.protocol) && !/^(javascript|data|file|vbscript|blob):$/.test(x.protocol); // app schemes (cursor://, vscode://)
  } catch { return false; }
}

export function createRemote({ transport, secret, store, base: fixedBase = null, challenge = null, fetchImpl = fetch, admit = () => true }) {
  let kp = null;
  const key = () => (kp ||= sha('sidenote-mcp:' + secret).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])));
  async function sealTok(prefix, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(prefix) }, await key(), te.encode(JSON.stringify(obj))));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return prefix + b64u(all);
  }
  async function openTok(prefix, s) {
    if (typeof s !== 'string' || !s.startsWith(prefix)) return null;
    try {
      const all = unb64u(s.slice(prefix.length));
      return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: te.encode(prefix) }, await key(), all.subarray(12))));
    } catch { return null; }
  }
  const keyId = async (k) => hex(await sha('sidenote-mcp-key:' + k)).slice(0, 32);
  const clientSecretOf = async (cid) => b64u(new Uint8Array(await sha('sidenote-mcp-cs:' + secret + ':' + cid)));

  // --- clients ---------------------------------------------------------------------------
  async function clientOf(cid) {
    if (typeof cid !== 'string' || !cid) return null;
    if (cid.startsWith('https://')) { // Client ID Metadata Document
      try {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
        const r = await fetchImpl(cid, { headers: { accept: 'application/json' }, signal: ac.signal, redirect: 'error' }).finally(() => clearTimeout(t));
        if (!r.ok) return null;
        let txt = '';
        const reader = r.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; txt += td.decode(value, { stream: true }); if (txt.length > 65536) { reader.cancel(); return null; } }
        const doc = JSON.parse(txt);
        if (doc.client_id !== cid || !Array.isArray(doc.redirect_uris)) return null;
        return { id: cid, name: String(doc.client_name || new URL(cid).hostname).slice(0, 80), redirects: doc.redirect_uris.filter((u) => typeof u === 'string'), confidential: false };
      } catch { return null; }
    }
    const c = await openTok('snc.', cid);
    return c && c.t === 'c' ? { id: cid, name: c.n, redirects: c.r, confidential: !!c.m } : null;
  }
  async function register(req) {
    let body;
    try { body = await req.json(); } catch { return oauthError('invalid_client_metadata', 'Send the client metadata as JSON.'); }
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string').slice(0, 10) : [];
    if (!uris.length || !uris.every(okRedirect)) return oauthError('invalid_redirect_uri', 'redirect_uris must be https, loopback http, or an app scheme, without a fragment.');
    const method = ['client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'none';
    const name = String(body.client_name || 'An AI app').replace(/\s+/g, ' ').trim().slice(0, 80);
    const client_id = await sealTok('snc.', { t: 'c', r: uris, n: name, m: method === 'none' ? 0 : 1 });
    const out = { client_id, client_id_issued_at: now(), client_name: name, redirect_uris: uris, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
    if (method !== 'none') { out.client_secret = await clientSecretOf(client_id); out.client_secret_expires_at = 0; }
    return json(out, 201);
  }

  // --- consent page ----------------------------------------------------------------------------
  const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f7f6f3;--card:#fff;--ink:#1c1c1f;--mute:#6b6b73;--line:#e4e2dd;--acc:#2f7bc8;--on:#fff;--err:#c2412d}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--card:#1f1f22;--ink:#ececef;--mute:#9a9aa3;--line:#333338;--acc:#6aa8e8;--on:#0d1a27;--err:#ee7b65}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:440px;margin:9vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px 24px}
h1{font-size:19px;margin:0 0 6px;letter-spacing:-.01em}p{margin:10px 0;color:var(--mute)}b{color:var(--ink);font-weight:600}
label{display:block;font-size:13px;font-weight:600;margin:18px 0 6px}input[type=password],input[type=text]{width:100%;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink)}
input:focus{outline:2px solid var(--acc);outline-offset:1px}.opts{display:flex;gap:8px;margin-top:6px}.opts label{flex:1;margin:0;font-weight:500;border:1px solid var(--line);border-radius:9px;padding:9px 10px;cursor:pointer;font-size:14px}
.opts input{margin-right:6px}button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:9px;background:var(--acc);color:var(--on);font:600 15px system-ui,sans-serif;cursor:pointer}
.err{color:var(--err);font-size:14px}.fine{font-size:12.5px}.mark{display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--acc);margin-right:8px}a{color:var(--acc)}
</style><main><div class="card">${body}</div></main></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' } });

  function consent(base, p, client, error = '') {
    const host = (() => { try { return new URL(p.redirect_uri).host || p.redirect_uri; } catch { return p.redirect_uri; } })();
    const write = p.scopeKind !== 'r';
    const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
      .map((k) => (p[k] != null ? `<input type="hidden" name="${k}" value="${esc(p[k])}">` : '')).join('');
    return page('Connect Sidenote', `<h1><span class="mark"></span>Connect Sidenote</h1>
<p><b>${esc(client.name)}</b> wants to use the notepads in your Sidenote account. It will send you back to <b>${esc(host)}</b>.</p>
${knownApp(p.redirect_uri) ? '' : `<p class="err">${esc(host)} isn’t an AI app Sidenote recognises. Don’t continue unless you set this connection up yourself.</p>`}
<form method="post" action="${esc(base)}/oauth/authorize" autocomplete="off">${hidden}
<label for="k">Your sync key</label>
<input id="k" name="sync_key" type="password" placeholder="sync-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx" required autofocus spellcheck="false">
<p class="fine">In Sidenote: Settings → Sync &amp; devices → Show. Turn sync on there first if it’s off.</p>
<label>Access</label><div class="opts"><label><input type="radio" name="access" value="rw"${write ? ' checked' : ''}>Read and edit</label><label><input type="radio" name="access" value="r"${write ? '' : ' checked'}>Read only</label></div>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<button type="submit">Connect</button>
<p class="fine">Only continue if you started this from ${esc(client.name)} just now. Your key is sealed into the sign-in it gets (${esc(client.name)} never sees the key). While it works with your notes, Sidenote’s connector decrypts them in memory and stores nothing. You can <a href="${esc(base)}/oauth/disconnect">disconnect every AI app</a> at any time. <a href="https://elmagoct.github.io/sidenote-privacy/">Privacy</a></p>
</form>`);
  }

  // Shared by GET (show the page) and POST (the form): everything the client sent, checked.
  async function authRequest(params) {
    const p = Object.fromEntries(['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].map((k) => [k, params.get(k) ?? undefined]));
    const client = await clientOf(p.client_id);
    if (!client) return { fatal: 'This sign-in link isn’t valid (the app that sent you here isn’t registered). Start again from the app.' };
    if (!p.redirect_uri && client.redirects.length === 1) p.redirect_uri = client.redirects[0];
    if (!p.redirect_uri || !client.redirects.some((r) => sameRedirect(r, p.redirect_uri))) return { fatal: 'This sign-in link sends you somewhere the app didn’t register. Start again from the app.' };
    const back = (error, description) => ({ redirect: withParams(p.redirect_uri, { error, error_description: description, state: p.state }) });
    if (p.response_type !== 'code') return back('unsupported_response_type', 'Only the code flow is supported.');
    if (!p.code_challenge || (p.code_challenge_method || 'plain') !== 'S256') return back('invalid_request', 'PKCE with S256 is required.');
    const sc = String(p.scope || '').split(/\s+/);
    p.scopeKind = sc.includes('notes:write') || !sc.includes('notes:read') ? 'rw' : 'r';
    return { p, client };
  }
  const withParams = (uri, o) => { const u = new URL(uri); for (const [k, v] of Object.entries(o)) if (v != null) u.searchParams.set(k, v); return u.toString(); };
  const redirect = (to) => new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });

  // Is there a Sidenote account behind this key? (One small read of the encrypted index.)
  async function checkKey(k) {
    const d = await derive(k);
    const [r] = await transport([{ id: 's:' + d.id, rev: 0 }]);
    if (!r?.data) throw new SidenoteError('Nothing is synced under that key. Turn sync on in Sidenote (Settings → Sync & devices) and copy the key from there.');
    try { await openBlob(d.k, r.data); } catch { throw new SidenoteError('That key doesn’t open a Sidenote account.'); }
  }

  async function authorize(req, base) {
    if (req.method === 'GET') {
      const a = await authRequest(new URL(req.url).searchParams);
      if (a.fatal) return page('Sidenote', `<h1>Can’t connect</h1><p>${esc(a.fatal)}</p>`, 400);
      if (a.redirect) return redirect(a.redirect);
      return consent(base, a.p, a.client);
    }
    const form = new URLSearchParams(await req.text());
    const a = await authRequest(form);
    if (a.fatal) return page('Sidenote', `<h1>Can’t connect</h1><p>${esc(a.fatal)}</p>`, 400);
    if (a.redirect) return redirect(a.redirect);
    let k;
    try { k = keyFrom(form.get('sync_key')); await checkKey(k); } catch (e) {
      return consent(base, a.p, a.client, e instanceof SidenoteError ? e.message : 'Couldn’t check that key just now. Try again.');
    }
    const s = form.get('access') === 'r' ? 'r' : a.p.scopeKind === 'r' ? 'r' : 'rw';
    const code = await sealTok('snx.', { t: 'code', k, s, c: a.client.id, r: a.p.redirect_uri, cc: a.p.code_challenge, e: now() + CODE_TTL, n: hex(crypto.getRandomValues(new Uint8Array(12))) });
    return redirect(withParams(a.p.redirect_uri, { code, state: a.p.state, iss: base }));
  }

  // --- token endpoint ----------------------------------------------------------------------------
  async function token(req, base) {
    const ct = req.headers.get('content-type') || '';
    const raw = await req.text();
    let f;
    if (ct.includes('application/json')) { try { f = new URLSearchParams(Object.entries(JSON.parse(raw)).map(([k, v]) => [k, String(v)])); } catch { return oauthError('invalid_request', 'Bad JSON body.'); } }
    else f = new URLSearchParams(raw);
    let cid = f.get('client_id'), csec = f.get('client_secret');
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.get('authorization') || '');
    if (basic) { try { const [u, pw] = atob(basic[1]).split(':'); cid = decodeURIComponent(u); csec = decodeURIComponent(pw || ''); } catch {} }
    const client = await clientOf(cid);
    if (!client) return oauthError('invalid_client', 'Unknown client.', 401);
    if (client.confidential && csec !== (await clientSecretOf(client.id))) return oauthError('invalid_client', 'Wrong client secret.', 401);
    const grant = f.get('grant_type');
    let k, s, issued;
    if (grant === 'authorization_code') {
      const c = await openTok('snx.', f.get('code'));
      if (!c || c.t !== 'code' || c.e < now() || c.c !== client.id) return oauthError('invalid_grant', 'The code is invalid or has expired.');
      if (f.get('redirect_uri') && !sameRedirect(c.r, f.get('redirect_uri'))) return oauthError('invalid_grant', 'redirect_uri doesn’t match.');
      const v = f.get('code_verifier') || '';
      if (b64u(new Uint8Array(await sha(v))) !== c.cc) return oauthError('invalid_grant', 'PKCE check failed.');
      if (store && !(await store.setIfNew('mcp-code/' + c.n, '1'))) return oauthError('invalid_grant', 'The code was already used.');
      ({ k, s } = c); issued = Date.now();
    } else if (grant === 'refresh_token') {
      const r = await openTok('snr.', f.get('refresh_token'));
      if (!r || r.t !== 'rt' || r.e < now() || r.c !== client.id) return oauthError('invalid_grant', 'The refresh token is invalid or has expired. Connect again.');
      const cut = store ? +(await store.get('mcp-revoked/' + (await keyId(r.k)))) || 0 : 0;
      if (r.i < cut) return oauthError('invalid_grant', 'This connection was disconnected. Connect again.');
      ({ k, s } = r); issued = r.i;
      if (f.get('scope') && !f.get('scope').includes('notes:write')) s = 'r';
    } else return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    const access_token = await sealTok('sna.', { t: 'at', k, s, c: client.id.slice(0, 64), e: now() + ACCESS_TTL, a: base + '/mcp' });
    const refresh_token = await sealTok('snr.', { t: 'rt', k, s, c: client.id, i: issued, e: now() + REFRESH_TTL });
    return json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token, scope: s === 'r' ? 'notes:read' : 'notes:read notes:write' });
  }

  async function disconnect(req, base) {
    const intro = `<h1><span class="mark"></span>Turn off AI access</h1><p>Turn off every chat link you made and sign out every AI app (ChatGPT, Claude, Gemini and others) connected to this Sidenote account. Links stop at once, apps within an hour. Notes and Sidenote itself are not affected.</p>`;
    const form = (msg = '') => `<form method="post" action="${esc(base)}/oauth/disconnect" autocomplete="off"><label for="k">Your sync key</label><input id="k" name="sync_key" type="password" required autofocus spellcheck="false" placeholder="sync-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx">${msg ? `<p class="err">${esc(msg)}</p>` : ''}<button type="submit">Turn off all</button></form>`;
    if (req.method === 'GET') return page('Turn off AI access · Sidenote', intro + form());
    const f = new URLSearchParams(await req.text());
    let k;
    try { k = keyFrom(f.get('sync_key')); await checkKey(k); } catch (e) { return page('Turn off AI access · Sidenote', intro + form(e instanceof SidenoteError ? e.message : 'Couldn’t check that key just now. Try again.')); }
    await store.set('mcp-revoked/' + (await keyId(k)), String(Date.now()));
    return page('Turned off · Sidenote', `<h1><span class="mark"></span>Turned off</h1><p>Your chat links no longer work, and every AI app connected to this account will be signed out within an hour. Make a new link or connect again whenever you like.</p><p><a href="${esc(base)}/">Back to Sidenote for AI</a></p>`);
  }

  // --- links for chat apps ---------------------------------------------------------------------
  async function makeLink(req, base) {
    let k;
    try {
      const raw = await req.text();
      const v = (req.headers.get('content-type') || '').includes('json') ? JSON.parse(raw)?.key : new URLSearchParams(raw).get('key');
      k = keyFrom(v);
      await checkKey(k);
    } catch (e) { return json({ error: e instanceof SidenoteError ? e.message : 'Send {"key": "sync-…"} as JSON.' }, 400); }
    const t = await sealTok('snl.', { t: 'l', k, i: Date.now() });
    return json({ url: `${base}/r/${t}`, read_only: true, turn_off: `${base}/oauth/disconnect` });
  }
  async function readLink(tok, base) {
    const text = (s, status = 200) => new Response(s, { status, headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' } });
    const l = await openTok('snl.', tok);
    if (!l || l.t !== 'l') return text(`This Sidenote link isn’t valid. Make a new one at ${base}/`, 404);
    const cut = store ? +(await store.get('mcp-revoked/' + (await keyId(l.k)))) || 0 : 0;
    if (l.i < cut) return text('Its owner turned this Sidenote link off.', 410);
    if (!(await admit())) return text(RESTING, 503);
    const a = await new Account(l.k, transport).refresh();
    return text(`Sidenote notepads, shared read-only through a private link. Sidenote is a notes app in Chrome’s side panel; each notepad’s content below is Markdown. This link can’t change anything; to edit, see ${base}/llms.txt\n\n${dumpAll(a)}\n`);
  }

  // --- MCP endpoint ----------------------------------------------------------------------------
  async function mcp(req, base) {
    const challenge401 = (err) => json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: err ? 'Sign in again: ' + err : 'Connect your Sidenote account first.' } }, 401, {
      'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${SCOPES.join(' ')}"${err ? `, error="invalid_token", error_description="${err}"` : ''}`,
    });
    if (req.method === 'GET' || req.method === 'DELETE') return new Response(null, { status: 405, headers: { ...CORS, allow: 'POST, OPTIONS' } });
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
    if (!bearer) return challenge401();
    let auth = null;
    if (bearer.startsWith('sna.')) {
      const t = await openTok('sna.', bearer);
      if (!t || t.t !== 'at') return challenge401('the token is not valid');
      if (t.e < now()) return challenge401('the token has expired');
      auth = { k: t.k, readOnly: t.s === 'r' };
    } else {
      // A raw sync key as the bearer (for clients that take a header): CLI tools, scripts.
      try { auth = { k: keyFrom(decodeURIComponent(bearer)), readOnly: /^(1|true)$/i.test(req.headers.get('x-sidenote-read-only') || '') }; } catch { return challenge401('not a Sidenote token or sync key'); }
    }
    if (!(await admit())) return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: RESTING } }, 503);
    let msg;
    try { const t = await req.text(); if (t.length > 2_000_000) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }, 413); msg = JSON.parse(t); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    let acct = null;
    const ctx = { readOnly: auth.readOnly, account: async () => (acct ||= await new Account(auth.k, transport).refresh()) };
    const out = await rpc(msg, ctx);
    return out ? json(out) : new Response(null, { status: 202, headers: CORS });
  }

  const prm = (base) => json({ resource: base + '/mcp', authorization_servers: [base], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Sidenote', resource_documentation: 'https://github.com/ElMagoCT/sidenote-mcp' });
  const asMeta = (base) => json({
    issuer: base,
    authorization_endpoint: base + '/oauth/authorize',
    token_endpoint: base + '/oauth/token',
    registration_endpoint: base + '/oauth/register',
    revocation_endpoint: base + '/oauth/revoke',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/ElMagoCT/sidenote-mcp',
  });

  return async function (req) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
    const base = fixedBase || url.origin;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (path === '/mcp') return await mcp(req, base);
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return prm(base);
      if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp' || path === '/.well-known/openid-configuration') return asMeta(base);
      if (path === '/.well-known/openai-apps-challenge') return challenge ? new Response(challenge, { headers: { 'content-type': 'text/plain' } }) : new Response('Not found', { status: 404 });
      if (!secret) return oauthError('temporarily_unavailable', 'Sign-in is not set up on this server.', 503);
      if (path === '/oauth/register' && req.method === 'POST') return await register(req);
      if (path === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) return await authorize(req, base);
      if (path === '/oauth/token' && req.method === 'POST') return await token(req, base);
      if (path === '/oauth/revoke' && req.method === 'POST') return new Response(null, { status: 200, headers: CORS }); // tokens are stateless; Disconnect revokes per key
      if (path === '/oauth/disconnect' && (req.method === 'GET' || req.method === 'POST')) return await disconnect(req, base);
      if (path === '/link' && req.method === 'POST') return await makeLink(req, base);
      if (path.startsWith('/r/') && (req.method === 'GET' || req.method === 'HEAD')) return await readLink(path.slice(3), base);
      return json({ error: 'not_found', server: SERVER_INFO.name }, 404);
    } catch (e) {
      return json({ error: 'server_error', error_description: e instanceof SidenoteError ? e.message : 'Something went wrong.' }, 500);
    }
  };
}
