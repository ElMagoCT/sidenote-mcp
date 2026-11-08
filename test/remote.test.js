import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer, seedAccount } from './fake.js';
import { createRemote } from '../src/remote.js';
import { sha } from '../src/keys.js';

const BASE = 'https://sn.test';
const b64u = (b) => Buffer.from(b).toString('base64url');
function memStore() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, setIfNew: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)) };
}
async function setup(opts = {}) {
  const srv = fakeServer();
  const { syncKey } = await seedAccount(srv.transport, [{ id: 'lq1aaaa', title: 'Groceries', html: '<ul class="todo"><li>milk</li></ul>' }]);
  const store = memStore();
  const cimd = { client_id: 'https://app.test/client.json', client_name: 'Test App', redirect_uris: ['https://app.test/cb'] };
  const fetchImpl = async (u) => (u === cimd.client_id ? new Response(JSON.stringify(cimd)) : new Response('no', { status: 404 }));
  const app = createRemote({ transport: srv.transport, secret: 'test-secret', store, fetchImpl, challenge: 'tok123', ...opts });
  const req = (path, init = {}) => app(new Request(BASE + path, init));
  return { srv, syncKey, store, req };
}
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const rpc = (token, method, params = {}) => ({ method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

async function connect(t, { client_id, redirect_uri, access = 'rw', scope } = {}) {
  const verifier = 'v'.repeat(50), challenge = b64u(new Uint8Array(await sha(verifier)));
  const q = { response_type: 'code', client_id, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', ...(scope ? { scope } : {}) };
  const page = await t.req('/oauth/authorize?' + new URLSearchParams(q));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Connect Sidenote/);
  const res = await t.req('/oauth/authorize', form({ ...q, sync_key: t.syncKey.toUpperCase(), access }));
  assert.equal(res.status, 302, await res.clone().text());
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'st8');
  assert.equal(loc.searchParams.get('iss'), BASE);
  const code = loc.searchParams.get('code');
  const tok = await t.req('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri, client_id, code_verifier: verifier }));
  assert.equal(tok.status, 200);
  const body = await tok.json();
  const again = await t.req('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri, client_id, code_verifier: verifier }));
  assert.equal(again.status, 400, 'a code works once');
  return body;
}

test('discovery and the 401 challenge', async () => {
  const t = await setup();
  const prm = await (await t.req('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(prm.resource, BASE + '/mcp');
  assert.deepEqual(prm.authorization_servers, [BASE]);
  const as = await (await t.req('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
  const r = await t.req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/sn\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal(await (await t.req('/.well-known/openai-apps-challenge')).text(), 'tok123');
});

test('DCR client: consent, code, tokens, tools, refresh, disconnect', async () => {
  const t = await setup();
  const reg = await t.req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const bad = await t.req('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://evil.test/cb', code_challenge: 'x', code_challenge_method: 'S256' }));
  assert.equal(bad.status, 400, 'an unregistered redirect is refused without redirecting');
  const tok = await connect(t, { client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
  assert.ok(tok.access_token.startsWith('sna.') && tok.refresh_token.startsWith('snr.'));
  assert.ok(!tok.access_token.includes(t.syncKey.slice(5, 15)));
  const init = await (await t.req('/mcp', rpc(tok.access_token, 'initialize', { protocolVersion: '2025-06-18' }))).json();
  assert.equal(init.result.serverInfo.name, 'sidenote');
  const ed = await (await t.req('/mcp', rpc(tok.access_token, 'tools/call', { name: 'edit_notepad', arguments: { notepad: 'Groceries', find: '- [ ] milk', replace: '- [x] milk' } }))).json();
  assert.ok(!ed.result.isError, JSON.stringify(ed));
  const rd = await (await t.req('/mcp', rpc(tok.access_token, 'tools/call', { name: 'read_notepad', arguments: { notepad: 'Groceries' } }))).json();
  assert.match(rd.result.content[0].text, /- \[x\] milk/);
  const ref = await t.req('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id }));
  assert.equal(ref.status, 200);
  const tok2 = await ref.json();
  assert.equal((await t.req('/mcp', rpc(tok2.access_token, 'tools/list'))).status, 200);
  const dis = await t.req('/oauth/disconnect', form({ sync_key: t.syncKey }));
  assert.match(await dis.text(), /Turned off/);
  await new Promise((r) => setTimeout(r, 5));
  const ref2 = await t.req('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tok2.refresh_token, client_id }));
  assert.equal(ref2.status, 400);
  assert.equal((await ref2.json()).error, 'invalid_grant');
});

test('CIMD client, read-only access, wrong key, raw key bearer', async () => {
  const t = await setup();
  const tok = await connect(t, { client_id: 'https://app.test/client.json', redirect_uri: 'https://app.test/cb', access: 'r' });
  assert.equal(tok.scope, 'notes:read');
  const list = await (await t.req('/mcp', rpc(tok.access_token, 'tools/list'))).json();
  assert.deepEqual(list.result.tools.map((x) => x.name), ['list_notepads', 'read_notepad', 'search_notepads', 'view_image']);
  const q = { response_type: 'code', client_id: 'https://app.test/client.json', redirect_uri: 'https://app.test/cb', code_challenge: 'abc', code_challenge_method: 'S256' };
  const wrong = await t.req('/oauth/authorize', form({ ...q, sync_key: 'sync-aaaaa-bbbbb-ccccc-ddddd-eeeee' }));
  assert.equal(wrong.status, 200);
  assert.match(await wrong.text(), /Nothing is synced under that key/);
  const raw = await (await t.req('/mcp', rpc(t.syncKey, 'tools/call', { name: 'list_notepads', arguments: {} }))).json();
  assert.match(raw.result.content[0].text, /Groceries/);
  const garbage = await t.req('/mcp', rpc('sna.garbage', 'tools/list'));
  assert.equal(garbage.status, 401);
  const note = await t.req('/mcp', { ...rpc(tok.access_token, 'x'), body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
  assert.equal(note.status, 202);
});

test('the consent page warns about apps it does not recognise', async () => {
  const t = await setup();
  const reg = async (uri) => (await (await t.req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [uri] }) })).json()).client_id;
  const page = async (uri) => (await t.req('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: await reg(uri), redirect_uri: uri, code_challenge: 'x', code_challenge_method: 'S256' }))).text();
  assert.doesNotMatch(await page('https://chatgpt.com/connector_platform_oauth_redirect'), /isn’t an AI app/);
  assert.doesNotMatch(await page('http://127.0.0.1:5555/callback'), /isn’t an AI app/);
  assert.match(await page('https://chatgpt.com.evil.test/cb'), /chatgpt\.com\.evil\.test isn’t an AI app Sidenote recognises/);
});

test('chat links: make, read as text, refuse bad and turned-off links', async () => {
  let admitted = 0;
  const t = await setup({ admit: () => (admitted++, true) });
  const bad = await t.req('/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'nope' }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /sync key/);
  const made = await t.req('/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: t.syncKey }) });
  assert.equal(made.status, 200);
  const { url, read_only } = await made.json();
  assert.equal(read_only, true);
  assert.match(url, /^https:\/\/sn\.test\/r\/snl\./);
  assert.ok(!url.includes(t.syncKey.slice(5)), 'the key itself is not in the link');
  const r = await t.req(url.slice(BASE.length));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  const body = await r.text();
  assert.match(body, /===== Groceries =====/);
  assert.match(body, /- \[ \] milk/);
  assert.equal(admitted, 1);
  assert.equal((await t.req('/r/snl.garbage')).status, 404);
  assert.equal((await t.req('/r/' + url.split('/r/')[1].replace('snl.', 'sna.'))).status, 404, 'other token kinds are not links');
  await new Promise((res) => setTimeout(res, 5));
  await t.req('/oauth/disconnect', form({ sync_key: t.syncKey }));
  const off = await t.req(url.slice(BASE.length));
  assert.equal(off.status, 410);
  assert.equal(admitted, 1, 'refused links cost nothing');
});

test('the daily budget is only spent on signed-in requests', async () => {
  let admitted = 0, open = true;
  const t = await setup({ admit: () => (admitted++, open) });
  assert.equal((await t.req('/mcp', rpc('junk', 'tools/list'))).status, 401);
  assert.equal((await t.req('/mcp', { method: 'POST', body: '{}' })).status, 401);
  assert.equal(admitted, 0);
  assert.equal((await t.req('/mcp', rpc(t.syncKey, 'tools/list'))).status, 200);
  assert.equal(admitted, 1);
  open = false;
  const shut = await t.req('/mcp', rpc(t.syncKey, 'tools/list'));
  assert.equal(shut.status, 503);
  assert.match((await shut.json()).error.message, /resting/);
});
