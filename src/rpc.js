// MCP over JSON-RPC 2.0, without an SDK: initialize, ping, tools/list, tools/call. The
// same handler serves stdio (one message per line) and Streamable HTTP (one POST per message).

import { toolList, callTool, INSTRUCTIONS } from './tools.js';

export const VERSION = '1.2.0';
export const SERVER_INFO = { name: 'sidenote', title: 'Sidenote', version: VERSION, websiteUrl: 'https://github.com/ElMagoCT/sidenote-mcp' };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// ctx: { account: () => Promise<Account>, readOnly?: boolean }. Returns the response, or
// null for a notification.
export async function handle(msg, ctx) {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handle(m, ctx)))).filter(Boolean);
    return out.length ? out : null;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg && 'id' in msg && !('method' in msg) ? null : fail(msg?.id, -32600, 'Invalid request');
  }
  const { id, method, params = {} } = msg;
  const note = !('id' in msg);
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const want = params.protocolVersion;
        result = {
          protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: toolList(ctx.readOnly) }; break;
      case 'tools/call': {
        if (typeof params.name !== 'string') return fail(id, -32602, 'Missing tool name');
        if (!toolList(ctx.readOnly).some((t) => t.name === params.name)) return fail(id, -32602, `Unknown tool: ${params.name}`);
        result = await callTool(params.name, params.arguments || {}, ctx);
        break;
      }
      case 'resources/list': result = { resources: [] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      default:
        if (note || method.startsWith('notifications/')) return null;
        return fail(id, -32601, `Method not found: ${method}`);
    }
    return note ? null : reply(id, result);
  } catch (e) {
    return note ? null : fail(id, -32603, e?.message || 'Internal error');
  }
}
