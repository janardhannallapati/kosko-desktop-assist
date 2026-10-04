// OAuth 2.1 for a public client, as the MCP authorization spec describes it: discover the authorization server
// from the resource, register this install dynamically (no secret), sign in through the user's browser with PKCE,
// and receive the code on a loopback port.
//
// Tokens live in this process's memory only. Nothing here writes a token to disk or prints one.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// RFC 7636: the verifier is 43-128 unreserved characters; the S256 challenge is base64url(SHA-256(verifier)).
export function pkcePair(verifier = b64url(randomBytes(32))) {
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export const newState = () => b64url(randomBytes(16));

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
}

// The resource's protected-resource metadata names its authorization server (RFC 9728); that server's
// metadata names the endpoints (RFC 8414).
export async function discover(resourceOrigin, fetchImpl = fetch) {
  const prm = await getJson(fetchImpl, new URL('/.well-known/oauth-protected-resource', resourceOrigin));
  const issuer = prm.authorization_servers?.[0];
  if (!issuer) throw new Error('protected-resource metadata names no authorization server');
  const as = await getJson(fetchImpl, new URL('/.well-known/oauth-authorization-server', issuer));
  if (!as.code_challenge_methods_supported?.includes('S256')) throw new Error('authorization server lacks PKCE S256');
  if (!as.registration_endpoint) throw new Error('authorization server offers no dynamic client registration');
  return { resource: prm.resource, scopes: prm.scopes_supported ?? [], as };
}

// RFC 7591 dynamic client registration, as a public client (token_endpoint_auth_method "none").
export async function register(as, { redirectUri, clientName }, fetchImpl = fetch) {
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
  const reg = await getJson(fetchImpl, as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
  if (!reg.client_id) throw new Error('registration returned no client_id');
  return reg.client_id;
}

export function authorizeUrl(as, { clientId, redirectUri, challenge, state, scope, resource }) {
  const u = new URL(as.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope,
    resource
  }).toString();
  return u.toString();
}

// Decides what one request to the loopback port means. Pure, so the state and error rules are testable
// without a socket.
export function judgeCallback(rawUrl, expectedState) {
  const u = new URL(rawUrl, 'http://127.0.0.1');
  if (u.pathname !== '/callback') return { kind: 'ignore' };
  const p = u.searchParams;
  if (p.get('state') !== expectedState) return { kind: 'refuse', reason: 'state mismatch' };
  if (p.get('error')) return { kind: 'refuse', reason: `authorization error: ${p.get('error')}` };
  const code = p.get('code');
  if (!code) return { kind: 'refuse', reason: 'no code' };
  return { kind: 'code', code };
}

// Listens on 127.0.0.1 only, for one valid callback or until the timeout.
export function waitForCallback({ port, state, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const verdict = judgeCallback(req.url, state);
      if (verdict.kind === 'ignore') { res.writeHead(404).end(); return; }
      const ok = verdict.kind === 'code';
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(ok ? 'Signed in. You can close this tab and return to the terminal.' : `Sign-in refused: ${verdict.reason}`);
      if (ok) { finish(); resolve(verdict.code); } else if (verdict.reason !== 'state mismatch') { finish(); reject(new Error(verdict.reason)); }
    });
    const timer = setTimeout(() => { finish(); reject(new Error('no sign-in within the time limit')); }, timeoutMs);
    function finish() { clearTimeout(timer); server.close(); }
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
    server.listen(port, '127.0.0.1');
  });
}

async function tokenRequest(as, params, fetchImpl) {
  const t0 = Date.now();
  const tok = await getJson(fetchImpl, as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString()
  });
  if (!tok.access_token) throw new Error('token response has no access_token');
  return { ...tok, obtainedAt: t0 };
}

export const exchangeCode = (as, { clientId, code, verifier, redirectUri, resource }, fetchImpl = fetch) =>
  tokenRequest(as, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource }, fetchImpl);

export const refreshToken = (as, { clientId, refresh, resource }, fetchImpl = fetch) =>
  tokenRequest(as, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh, resource }, fetchImpl);
