import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUrl, judgeCallback, pkcePair, waitForCallback } from '../src/mcp/oauth.mjs';

test('PKCE challenge is base64url(SHA-256(verifier)) — RFC 7636 appendix B vector', () => {
  assert.equal(pkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('a generated verifier is 43 base64url characters', () => {
  assert.match(pkcePair().verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('callback with wrong state is refused', () => {
  assert.deepEqual(judgeCallback('/callback?code=abc&state=evil', 'good'), { kind: 'refuse', reason: 'state mismatch' });
  assert.equal(judgeCallback('/callback?code=abc', 'good').kind, 'refuse');
});

test('callback with error is refused', () => {
  assert.equal(judgeCallback('/callback?error=access_denied&state=s', 's').reason, 'authorization error: access_denied');
});

test('valid callback resolves the code', () => {
  assert.deepEqual(judgeCallback('/callback?code=abc&state=s', 's'), { kind: 'code', code: 'abc' });
  assert.equal(judgeCallback('/favicon.ico', 's').kind, 'ignore');
});

test('the loopback server answers on 127.0.0.1 and resolves on a valid callback only', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const p = waitForCallback({ port, state: 's1', timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  const bad = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=nope`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`http://127.0.0.1:${port}/callback?code=thecode&state=s1`);
  assert.equal(ok.status, 200);
  assert.equal(await p, 'thecode');
});

test('authorize URL carries S256, state, read scope and the resource', () => {
  const u = new URL(authorizeUrl({ authorization_endpoint: 'https://a.example/auth' }, { clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', challenge: 'ch', state: 'st', scope: 'read', resource: 'https://r' }));
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), 'read');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('resource'), 'https://r');
});
