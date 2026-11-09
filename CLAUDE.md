# sidenote-mcp — notes for Claude

MCP server for the Sidenote Chrome extension (private repo ElMagoCT/sidenote, folder
`../sidenote`). Public repo, MIT, no dependencies, no build. Node 20+ / Deno (edge).

- `src/keys.js` must stay byte-for-byte compatible with the extension's `src/sync.js`
  key derivation and sealing; `src/client.js` mirrors its doc shape (`kids` canonical and
  sorted, `libx` flags) so the extension never ping-pongs. If the extension's sync format
  changes, change both.
- `src/media.js` mirrors the extension's `src/media.js` (`embedOf`, image key derivation, the `i:` blob format);
  `src/board.js` mirrors its `src/board.js` whiteboard format (attribute ORDER, arrows without x/y/w/h). `src/shrink.js`
  shrinks what an AI adds the way the extension shrinks pasted images (≤ 1600 px, ~250 KB), in plain JS
  (vendored jpeg-js in `src/vendor/`, its own PNG codec), so it runs in Node, Deno and browsers. The hosted
  connector can't spend that CPU in an edge function (50 ms), so `shrinkVia()` sends the work to the
  sync site's `netlify/functions/shrink.mjs` (guarded by a header derived from `MCP_SECRET`).
- `src/md.js` round-trips the editor vocabulary (`sanitize()` in the extension's
  `src/editor.js`). Chrome nests indented lists as siblings (`<ul><li>a</li><ul>…`) and
  strikes with `<strike>`; md.js emits the same so unchanged notes stay byte-identical.
- One repo, many package formats, all at the root: Claude Code plugin + marketplace
  (`.claude-plugin/`, `.mcp.json`, `skills/`), OpenAI/Codex plugin (`plugin.json`,
  `mcp.json`, `.agents/plugins/`), Gemini CLI (`gemini-extension.json`, `GEMINI.md`),
  Antigravity (`.antigravity-plugin/`, `mcp_config.json`), Claude Desktop MCPB
  (`mcpb/manifest.json`, `scripts/build-mcpb.sh`), MCP Registry (`server.json`, listed as
  `io.github.ElMagoCT/sidenote` since 2026-11-02; `.github/workflows/publish-mcp.yml`
  republishes on every `v*` tag via GitHub OIDC, and the registry rejects a version it already
  has, so bump `server.json` with the tag). Keep versions in step (package.json,
  rpc.js VERSION, every manifest). No top-level `bin/`: it blocks the plugin on claude.ai.
- Hosted connector: `src/remote.js` runs as the Netlify Edge Function
  `../sidenote/server/netlify/edge-functions/mcp.js` on site `sidenote-sync`; copy the code
  over with `../sidenote/server/vendor-mcp.sh`, then deploy from `../sidenote/server`
  (`netlify deploy --prod --dir public`). Env there: `MCP_SECRET` (changing it signs every
  AI app out), `MCP_DAILY_CAP`, `OPENAI_APPS_CHALLENGE`.
- No-account route (Micah, 2026-11-03: "I don't want to need an account for this"): the page
  at https://sidenote-sync.netlify.app/ (`web/index.html` + `web/app.js`, which imports `src/`
  in the browser and decrypts there), `web/llms.txt` (instructions for AIs), chat links
  (`/link` seals the key into `/r/snl.…`, plain text from `dumpAll`; Disconnect turns them
  off) and the CLI (`server/cli.js` → `dist/sidenote.mjs` via `scripts/build-cli.sh`, served at
  /sidenote.mjs). `../sidenote/server/vendor-mcp.sh` builds and copies all of it into
  `public/`. Every page and link is static or text so AI fetchers read it without JS.
- Sidenote on the web (`/notes`, built from the private extension repo's `web/` by
  `../sidenote/server/build-web.sh`) opens any key through `openKey()`: `Account` for sync
  keys, `Shared` (a pad-/view- key plus subpads from `kids`) otherwise. The hub's Open
  button goes there; the CLI takes shared keys the same way.
- Tests: `npm test` (in-memory sync service). Live e2e with the real extension + production
  sync: session 43ff0735 scratchpad `pup/e2e.mjs` (local server) and
  `MCP_URL=<deploy url> node e2e.mjs` (hosted, full OAuth).
