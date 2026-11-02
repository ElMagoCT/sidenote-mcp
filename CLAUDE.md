# sidenote-mcp — notes for Claude

MCP server for the Sidenote Chrome extension (private repo ElMagoCT/sidenote, folder
`../sidenote`). Public repo, MIT, no dependencies, no build. Node 20+ / Deno (edge).

- `src/keys.js` must stay byte-for-byte compatible with the extension's `src/sync.js`
  key derivation and sealing; `src/client.js` mirrors its doc shape (`kids` canonical and
  sorted, `libx` flags) so the extension never ping-pongs. If the extension's sync format
  changes, change both.
- `src/md.js` round-trips the editor vocabulary (`sanitize()` in the extension's
  `src/editor.js`). Chrome nests indented lists as siblings (`<ul><li>a</li><ul>…`) and
  strikes with `<strike>`; md.js emits the same so unchanged notes stay byte-identical.
- One repo, many package formats, all at the root: Claude Code plugin + marketplace
  (`.claude-plugin/`, `.mcp.json`, `skills/`), OpenAI/Codex plugin (`plugin.json`,
  `mcp.json`, `.agents/plugins/`), Gemini CLI (`gemini-extension.json`, `GEMINI.md`),
  Antigravity (`.antigravity-plugin/`, `mcp_config.json`), Claude Desktop MCPB
  (`mcpb/manifest.json`, `scripts/build-mcpb.sh`), MCP Registry (`server.json`, published
  with `mcp-publisher` logged in as ElMagoCT; a GitHub Actions OIDC workflow needs the
  `gh` token's `workflow` scope first). Keep versions in step (package.json,
  rpc.js VERSION, every manifest). No top-level `bin/`: it blocks the plugin on claude.ai.
- Hosted connector: `src/remote.js` runs as the Netlify Edge Function
  `../sidenote/server/netlify/edge-functions/mcp.js` on site `sidenote-sync`; copy the code
  over with `../sidenote/server/vendor-mcp.sh`, then deploy from `../sidenote/server`
  (`netlify deploy --prod --dir public`). Env there: `MCP_SECRET` (changing it signs every
  AI app out), `MCP_DAILY_CAP`, `OPENAI_APPS_CHALLENGE`.
- Tests: `npm test` (in-memory sync service). Live e2e with the real extension + production
  sync: session 43ff0735 scratchpad `pup/e2e.mjs` (local server) and
  `MCP_URL=<deploy url> node e2e.mjs` (hosted, full OAuth).
