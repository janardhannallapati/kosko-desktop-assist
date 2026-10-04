import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, parseRpcBody } from '../src/mcp/client.mjs';
import { RateLimitError } from '../src/mcp/pacer.mjs';

function fakeServer(handler) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ body, headers: init.headers });
    const { status = 200, json, headers = {} } = (await handler(body)) ?? {};
    return new Response(json === undefined ? '' : JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetchImpl, seen };
}
const ok = (id, result) => ({ json: { jsonrpc: '2.0', id, result } });
const client = (fetchImpl, extra = {}) => new McpClient({ url: 'https://m/mcp', getToken: async () => 'T', fetchImpl, ...extra });

test('refuses to call a tool not on the read allowlist', async () => {
  const { fetchImpl, seen } = fakeServer(() => ok(1, {}));
  await assert.rejects(client(fetchImpl).callTool('delete_note', { id: 'x' }), /not a read tool/);
  assert.equal(seen.length, 0);
});

test('refuses a read tool the server does not offer', async () => {
  const { fetchImpl } = fakeServer((b) => ok(b.id, { tools: [{ name: 'search_notes' }] }));
  const c = client(fetchImpl);
  await c.listTools();
  await assert.rejects(c.callTool('get_note', { id: 'x' }), /does not offer get_note/);
});

test('calls get_note when tools/list offers it, with bearer and session headers', async () => {
  const { fetchImpl, seen } = fakeServer((b) => {
    if (b.method === 'tools/list') return { ...ok(b.id, { tools: [{ name: 'get_note' }] }), headers: { 'mcp-session-id': 'S1' } };
    if (b.method === 'tools/call') return ok(b.id, { content: [{ type: 'text', text: '{"guid":"g"}' }] });
  });
  const c = client(fetchImpl);
  await c.listTools();
  const r = await c.callTool('get_note', { noteGuid: 'g' });
  assert.equal(r.result.content[0].text, '{"guid":"g"}');
  assert.equal(seen[1].headers.authorization, 'Bearer T');
  assert.equal(seen[1].headers['mcp-session-id'], 'S1');
});

test('HTTP 429 becomes a RateLimitError carrying Retry-After', async () => {
  const { fetchImpl } = fakeServer(() => ({ status: 429, json: {}, headers: { 'retry-after': '12' } }));
  await assert.rejects(client(fetchImpl).callTool('get_note', {}), (e) => e instanceof RateLimitError && e.retryAfterSec === 12);
});

test('a tool error that names a rate limit becomes a RateLimitError', async () => {
  const { fetchImpl } = fakeServer((b) => ok(b.id, { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded, retry in 30 seconds' }] }));
  await assert.rejects(client(fetchImpl).callTool('get_note', {}), (e) => e instanceof RateLimitError && e.retryAfterSec === 30);
});

test('401 refreshes once and retries', async () => {
  let n = 0;
  let refreshed = 0;
  const { fetchImpl } = fakeServer((b) => (n++ === 0 ? { status: 401, json: {} } : ok(b.id, { tools: [] })));
  await client(fetchImpl, { onUnauthorized: async () => { refreshed++; } }).listTools();
  assert.equal(refreshed, 1);
});

test('an SSE response is read to the event with our id', () => {
  const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseRpcBody(body, 'text/event-stream', 4).result, { ok: true });
});
