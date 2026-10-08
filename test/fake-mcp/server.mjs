// A fake of Evernote's MCP server for 512–515 (Kosko docs 461 and 512), replaying the shapes recorded on the paid trial
// account on 2026-10-04 (Kosko docs/research/reports/mcp-probe-2026-10-04/): tools.json is the recorded tools/list,
// verbatim; search_notes, get_note and get_attachment answer in the recorded result shapes (samples-*-shapes.json).
//
// It is one request handler, reachable two ways: `fake.fetch` (in memory, for most tests) and `fake.listen()` (real
// HTTP on 127.0.0.1, for the end-to-end proof). Both carry the same state.
//
// What it models, and what it only assumes:
// - OAuth exactly as 461 measured: protected-resource metadata → authorization-server metadata (S256 only, `none`
//   auth, dynamic registration at /auth/register) → authorize (PKCE, state echoed, 302 to the loopback) → token
//   (code + verifier; refresh_token grant). An access token can be expired on demand (`fake.expireAccess()`), and the
//   MCP endpoint then answers 401 as Evernote does.
// - Streamable HTTP: JSON-RPC 2.0 POSTs, an `mcp-session-id`, answers as JSON or (`sse: true`) as an event stream.
// - Rate limit: 461 recorded it as a tool result with isError whose text names the limit and a 60 s retry, not an HTTP
//   429. `limitOn` (get_note call ordinals) answers exactly that. The words are not recorded; the sentence is ours.
// - Free plan: NOT RECORDED (ADR-0007: "refused on a free account"; no shape was kept). `freePlan` models the three
//   plausible places: 'http403' (the MCP endpoint refuses a signed-in bearer), 'rpc' (initialize answers a JSON-RPC
//   error naming the plan) and 'tool' (a tool call answers isError naming the plan). W7 records the real one.
//   'http403bare' is NOT a free plan: a 403 whose body names no plan, which the tool must stop on (review T4).
// - A note listed but missing (`missing`: get_note answers isError "not found") and listed notes the plan does not
//   hold (`extra`).
// - 513: get_attachment's signed URL, 300 s, no auth header (461). `staleUrls` answers that many URLs already expired;
//   `forbidDownloads` answers that many downloads 403, as an expired signature does. Every download is recorded with
//   whether it carried an Authorization header (`state.downloads`).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const TOOLS = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8')).tools;
const b64url = (b) => Buffer.from(b).toString('base64url');
const tokenOf = () => b64url(randomBytes(24));
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const iso = (ms) => new Date(ms).toISOString(); // 24 characters, ms precision, as recorded

/**
 * notes: [{ guid, title, enml, created (ms), updated (ms), resources: [{ hash, mime, name, sizeBytes }], tasks }]
 * files: Map md5 -> Uint8Array, served by get_attachment's signed URL.
 */
export function createFakeMcp({ notes = [], files = new Map(), extra = [], missing = [], freePlan = null, limitOn = [],
  sse = false, accessTtl = 3600, origin = 'https://mcp.evernote.test', now = Date.now, omitTools = [], staleUrls = 0, forbidDownloads = 0 } = {}) {
  const state = {
    notes: new Map(notes.map((n) => [n.guid, n])), files, extra: [...extra], missing: new Set(missing), freePlan,
    limitOn: new Set(limitOn), sse,
    clients: new Map(), codes: new Map(), access: new Map(), refresh: new Set(), sessions: new Set(),
    authorizations: 0, tokenGrants: { authorization_code: 0, refresh_token: 0 }, unauthorized: 0,
    calls: [], getNoteCalls: 0, rpc: [], staleUrls, forbidDownloads, downloads: []
  };
  const fake = { state, origin };

  const listing = () => [
    ...[...state.notes.values()].filter((n) => n.active !== false),
    ...state.extra.map((guid, i) => ({ guid, title: `Extra ${i}`, enml: '<en-note/>', created: 0, updated: 0 }))
  ].sort((a, b) => a.created - b.created || (a.guid < b.guid ? -1 : 1));

  const toolResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
  const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

  function callTool(name, args = {}) {
    state.calls.push({ tool: name, at: now(), noteId: args?.noteId ?? null, hash: args?.hash ?? null });
    if (state.freePlan === 'tool') return toolError('MCP access requires an Evernote Personal or Professional plan. Upgrade to continue.');
    if (name === 'search_notes') {
      const all = listing();
      const start = Number.isInteger(args.startIndex) ? args.startIndex : 0;
      const max = Math.min(100, Number.isInteger(args.maxResults) ? args.maxResults : 20);
      const page = all.slice(start, start + max);
      return toolResult({ hits: page.map((n) => ({ noteId: n.guid, title: n.title, snippet: '', createdAt: iso(n.created), updatedAt: iso(n.updated), score: 0 })),
        totalResultCount: all.length, startIndex: start, isLastPage: start + page.length >= all.length });
    }
    if (name === 'get_note') {
      state.getNoteCalls += 1;
      if (state.limitOn.has(state.getNoteCalls)) return toolError('Rate limit exceeded for get_note. Please retry after 60 seconds.');
      const n = state.notes.get(args.noteId);
      if (!n || state.missing.has(args.noteId)) return toolError(`Note not found: ${args.noteId}`);
      return toolResult({ id: n.guid, title: n.title, version: 1, updateSequenceNumber: 1, notebookId: '00000000-0000-4000-8000-000000000000',
        content: n.enml, created: iso(n.created), updated: iso(n.updated), active: true, deleted: null, tasks: n.tasks ?? [],
        tags: [], resources: (n.resources ?? []).map((r, i) => ({ id: `${n.guid.slice(0, 24)}${String(i).padStart(12, '0')}`, ...r })),
        attributes: { author: null, sourceUrl: null, sourceApplication: null, placeName: null, reminderTime: null, reminderDoneTime: null, isTemplate: false } });
    }
    if (name === 'get_attachment') {
      const n = state.notes.get(args.noteId);
      if (!n || !(n.resources ?? []).some((r) => r.hash === args.hash)) return toolError('Attachment not found');
      const exp = state.staleUrls > 0 ? (state.staleUrls--, now() - 1000) : now() + 300_000;
      const sig = createHash('sha256').update(`${args.hash}|${exp}`).digest('hex').slice(0, 16);
      return toolResult({ url: `${fake.origin}/files/${args.hash}?exp=${exp}&sig=${sig}`, expiresAt: iso(exp) });
    }
    return toolError(`Unknown tool: ${name}`);
  }

  async function rpc(msg) {
    state.rpc.push(msg.method);
    if (msg.method === 'initialize') {
      if (state.freePlan === 'rpc') return { error: { code: -32001, message: 'Evernote MCP is not available on your current plan. Upgrade to Personal or Professional.' } };
      return { result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'evernote-mcp', version: '0.1.0' } } };
    }
    if (msg.method === 'tools/list') return { result: { tools: TOOLS.filter((t) => !omitTools.includes(t.name)) } };
    if (msg.method === 'tools/call') return { result: callTool(msg.params?.name, msg.params?.arguments) };
    return { error: { code: -32601, message: 'Method not found' } };
  }

  async function handle(req) {
    const origin = fake.origin; // after listen(), the real address
    const u = new URL(req.url);
    const path = u.pathname;
    if (req.method === 'GET' && path === '/.well-known/oauth-protected-resource') {
      return json(200, { resource: origin, authorization_servers: [origin], scopes_supported: ['read'], bearer_methods_supported: ['header'] });
    }
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: origin, authorization_endpoint: `${origin}/auth/authorize`, token_endpoint: `${origin}/auth/token`,
        registration_endpoint: `${origin}/auth/register`, code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'], scopes_supported: ['read'] });
    }
    if (req.method === 'POST' && path === '/auth/register') {
      const body = await req.json();
      if (body.token_endpoint_auth_method !== 'none' || !Array.isArray(body.redirect_uris)) return json(400, { error: 'invalid_client_metadata' });
      const clientId = `client-${state.clients.size + 1}`;
      state.clients.set(clientId, { redirectUris: body.redirect_uris });
      return json(201, { client_id: clientId, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    if (req.method === 'GET' && path === '/auth/authorize') {
      const p = u.searchParams;
      const client = state.clients.get(p.get('client_id'));
      if (!client || !client.redirectUris.includes(p.get('redirect_uri')) || p.get('response_type') !== 'code'
        || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('state')) return json(400, { error: 'invalid_request' });
      state.authorizations += 1;
      const code = tokenOf();
      state.codes.set(code, { clientId: p.get('client_id'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') });
      const back = new URL(p.get('redirect_uri'));
      back.search = new URLSearchParams({ code, state: p.get('state') }).toString();
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (req.method === 'POST' && path === '/auth/token') {
      const p = new URLSearchParams(await req.text());
      const issue = () => {
        const access = tokenOf();
        state.access.set(access, { expired: false });
        return access;
      };
      if (p.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(p.get('code'));
        state.codes.delete(p.get('code')); // one use
        const verified = c && c.clientId === p.get('client_id') && c.redirectUri === p.get('redirect_uri')
          && b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest()) === c.challenge;
        if (!verified) return json(400, { error: 'invalid_grant' });
        state.tokenGrants.authorization_code += 1;
        const refresh = tokenOf();
        state.refresh.add(refresh);
        return json(200, { access_token: issue(), token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, scope: 'read' });
      }
      if (p.get('grant_type') === 'refresh_token' && state.refresh.has(p.get('refresh_token'))) {
        state.tokenGrants.refresh_token += 1;
        return json(200, { access_token: issue(), token_type: 'Bearer', expires_in: accessTtl, scope: 'read' });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (req.method === 'GET' && path.startsWith('/files/')) {
      const hash = path.slice('/files/'.length);
      const exp = Number(u.searchParams.get('exp'));
      const sig = createHash('sha256').update(`${hash}|${exp}`).digest('hex').slice(0, 16);
      state.downloads.push({ hash, at: now(), auth: req.headers.has('authorization') });
      if (state.forbidDownloads > 0) { state.forbidDownloads -= 1; return new Response(null, { status: 403 }); }
      if (u.searchParams.get('sig') !== sig || now() > exp || !state.files.has(hash)) return new Response(null, { status: 403 });
      return new Response(state.files.get(hash), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    if (req.method === 'POST' && path === '/mcp') {
      const auth = req.headers.get('authorization') ?? '';
      const tok = state.access.get(auth.replace(/^Bearer /, ''));
      if (!tok || tok.expired) {
        state.unauthorized += 1;
        return json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      }
      if (state.freePlan === 'http403') return json(403, { error: 'insufficient_plan', error_description: 'MCP access requires a paid Evernote plan.' });
      // Review T4: a 403 that names no plan (a revoked grant, a blocked client). Not a free plan: the run must stop.
      if (state.freePlan === 'http403bare') return json(403, { error: 'forbidden' });
      const msg = await req.json();
      if (msg.id == null) return new Response(null, { status: 202 });
      const answer = { jsonrpc: '2.0', id: msg.id, ...(await rpc(msg)) };
      const headers = {};
      if (msg.method === 'initialize') { const sid = tokenOf(); state.sessions.add(sid); headers['mcp-session-id'] = sid; }
      if (state.sse) {
        return new Response(`event: message\ndata: ${JSON.stringify(answer)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
      }
      return json(200, answer, headers);
    }
    return json(404, { error: 'not_found' });
  }

  fake.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin !== new URL(fake.origin).origin) throw new TypeError(`fetch failed: ${u.origin} is not the fake`);
    return handle(new Request(u, { method: init.method ?? 'GET', headers: init.headers, body: init.body, redirect: 'manual' }));
  };
  /**
   * The signed-URL rule a test injects (evernote.signedUrlOk): this fake's own origin, read at call time (after
   * listen() it is http://127.0.0.1:<port>). Production pins https on evernote.com (src/mcp/evernote.mjs isSignedUrl).
   */
  fake.signedUrlOk = (url) => { try { return new URL(url).origin === new URL(fake.origin).origin; } catch { return false; } };
  /** Every access token issued so far stops working: the next MCP call answers 401, as an expired token does. */
  fake.expireAccess = () => { for (const t of state.access.values()) t.expired = true; };
  /** Real HTTP on 127.0.0.1:<random port>; `origin` becomes that address. Returns a close function. */
  fake.listen = () => new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const out = await handle(new Request(`${fake.origin}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
    server.listen(0, '127.0.0.1', () => {
      fake.origin = `http://127.0.0.1:${server.address().port}`;
      resolve(() => new Promise((r) => server.close(r)));
    });
  });
  return fake;
}

/**
 * The browser step for tests: follow the authorize address to its 302 and read the code off the loopback address, as
 * the person's browser and waitForCallback would. `seen` counts sign-ins (a refresh must never need another).
 */
export function autoAuthorize(fetchImpl, seen = { count: 0 }) {
  return async ({ url, state }) => {
    seen.count += 1;
    const res = await fetchImpl(url, { redirect: 'manual' });
    const back = new URL(res.headers.get('location'));
    if (back.searchParams.get('state') !== state) throw new Error('state mismatch');
    return back.searchParams.get('code');
  };
}
