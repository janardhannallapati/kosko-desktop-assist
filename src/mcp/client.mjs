// A minimal MCP client over Streamable HTTP: JSON-RPC 2.0 POSTs, answered either as JSON or as a short SSE
// stream. Only read tools may be called (rule 1): the allowlist is checked before anything is sent.
import { RateLimitError } from './pacer.mjs';

export const READ_TOOLS = new Set([
  'get_note', 'search_notes', 'search_notebooks', 'search_tags', 'get_attachment',
  'search_spaces', 'get_space', 'get_task', 'search_tasks'
]);

const LIMIT_TEXT = /rate.?limit|too many requests|throttl/i;

function parseRetryAfter(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null;
}

// An SSE body carries one or more "data:" lines per event; the JSON-RPC response is the event with our id.
export function parseRpcBody(text, contentType, id) {
  if (!contentType?.includes('text/event-stream')) return JSON.parse(text);
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    const msg = JSON.parse(data);
    if (msg.id === id) return msg;
  }
  throw new Error('event stream ended without a response');
}

export class McpClient {
  constructor({ url, getToken, onUnauthorized, fetchImpl = fetch, protocolVersion = '2025-06-18' }) {
    Object.assign(this, { url, getToken, onUnauthorized, fetchImpl, protocolVersion });
    this.sessionId = null;
    this.nextId = 1;
    this.tools = null;
  }

  async post(payload, { retried = false } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${await this.getToken()}`,
      'mcp-protocol-version': this.protocolVersion
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const t0 = performance.now();
    const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const ms = performance.now() - t0;
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 401 && !retried && this.onUnauthorized) {
      await res.text();
      await this.onUnauthorized();
      return this.post(payload, { retried: true });
    }
    if (res.status === 429) {
      await res.text();
      throw new RateLimitError('HTTP 429', parseRetryAfter(res.headers.get('retry-after')), 429);
    }
    const text = await res.text();
    if (payload.id == null) return { ms, status: res.status };
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const msg = parseRpcBody(text, res.headers.get('content-type'), payload.id);
    if (msg.error) {
      if (LIMIT_TEXT.test(msg.error.message ?? '')) throw new RateLimitError(`rpc ${msg.error.code}`, null, 'rpc');
      throw Object.assign(new Error(`rpc error ${msg.error.code}`), { rpcCode: msg.error.code });
    }
    return { ms, status: res.status, result: msg.result };
  }

  rpc(method, params) {
    return this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
  }

  async initialize() {
    const r = await this.rpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: 'kosko-desktop-assist', version: '0.0.1' }
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r.result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {});
      tools.push(...(r.result.tools ?? []));
      cursor = r.result.nextCursor;
    } while (cursor);
    this.tools = new Map(tools.map((t) => [t.name, t]));
    return tools;
  }

  async callTool(name, args) {
    if (!READ_TOOLS.has(name)) throw new Error(`refused: ${name} is not a read tool`);
    if (this.tools && !this.tools.has(name)) throw new Error(`refused: the server does not offer ${name}`);
    const r = await this.rpc('tools/call', { name, arguments: args });
    const res = r.result;
    if (res?.isError) {
      const text = (res.content ?? []).map((c) => c.text ?? '').join(' ');
      if (LIMIT_TEXT.test(text)) {
        const m = text.match(/(\d+)\s*(?:s\b|sec|second)/i);
        throw new RateLimitError('tool rate limit', m ? Number(m[1]) : null, 'tool');
      }
      throw Object.assign(new Error(`tool ${name} returned an error`), { toolError: true });
    }
    return { ms: r.ms, result: res };
  }
}

// A tool result as data: structuredContent if present, else the first text block parsed as JSON, else the text.
export function resultData(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}
