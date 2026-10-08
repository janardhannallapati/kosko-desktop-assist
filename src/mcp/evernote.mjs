// 512 — the formatted route's Evernote half: sign in to Evernote's MCP server (461's OAuth client), list every note,
// and fetch one note's ENML at a pace the server accepts.
//
// Rules this module owns (Kosko doc 512):
// - Tokens live in this process's memory only (461 rule 2). An expired access token is renewed with the refresh token,
//   never with a second browser sign-in.
// - Read tools only (461 rule 1, client.mjs's allowlist), and the run refuses to start without search_notes and get_note.
// - One request in flight, 1.1 calls a second steady, never climbing; a rate-limit answer (HTTP 429, or a tool result
//   with isError naming the limit, as 461 measured) waits as told and halves the rate (pacer.mjs).
// - A free-plan refusal is recognised, so the caller can say so in one sentence and carry on with plain text.
//   NOT RECORDED: the free-plan refusal's exact shape was not captured on 2026-10-04 (ADR-0007 says only "refused on a
//   free account"). It is recognised as an HTTP 403 from the MCP endpoint once signed in, or a JSON-RPC error / tool
//   error whose text names a plan or subscription. W7 records the real one and narrows this.
import { authorizeUrl, discover, exchangeCode, newState, pkcePair, refreshToken, register, waitForCallback } from './oauth.mjs';
import { McpClient, resultData } from './client.mjs';
import { Pacer, RateLimitError } from './pacer.mjs';

export const EVERNOTE_MCP = 'https://mcp.evernote.com';
export const STEADY_RPS = 1.1; // 461's second run: the ceiling is 72-96 calls a minute; 1.1/s never met it
export const PAGE = 100; // search_notes' page, as 461 listed 175 of 175
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NEEDED = ['search_notes', 'get_note'];
const PLAN_TEXT = /\b(plan|plans|subscription|upgrade|premium)\b/i;

/** Evernote will not serve this account over MCP (a free plan). The run carries on as plain text. */
export class FreePlanRefused extends Error {}
/** get_note had no body for a note search_notes listed (deleted since, or an error that is not a rate limit). */
export class BodyMissing extends Error {}

export function isFreePlanRefusal(e) {
  if (e instanceof FreePlanRefused) return true;
  if (e instanceof RateLimitError) return false;
  if (e?.status === 403) return true;
  return (e?.rpcCode != null || e?.toolError === true) && PLAN_TEXT.test(String(e.detail ?? ''));
}

/** The browser step: print the address, wait for Evernote to send the person back to 127.0.0.1. */
export async function browserAuthorize({ url, port, state, log }) {
  log(`Open this address in your browser and sign in to Evernote (read only):\n${url}`);
  return waitForCallback({ port, state });
}

/** Signs in once and returns an MCP client whose token is renewed in memory. */
export async function signIn({ origin = EVERNOTE_MCP, fetchImpl = fetch, port = 8765, authorize = browserAuthorize, log = () => {} }) {
  const { resource, as } = await discover(origin, fetchImpl);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const clientId = await register(as, { redirectUri, clientName: 'Kosko desktop assist' }, fetchImpl);
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const url = authorizeUrl(as, { clientId, redirectUri, challenge, state, scope: 'read', resource });
  const code = await authorize({ url, port, state, redirectUri, log });
  let tok = await exchangeCode(as, { clientId, code, verifier, redirectUri, resource }, fetchImpl);
  const stats = { refreshes: 0 };
  const renew = async () => {
    if (!tok.refresh_token) throw new Error('The Evernote sign-in expired and cannot be renewed; run the command again.');
    const next = await refreshToken(as, { clientId, refresh: tok.refresh_token, resource }, fetchImpl);
    tok = { refresh_token: tok.refresh_token, ...next };
    stats.refreshes += 1;
  };
  const getToken = async () => {
    if (tok.expires_in && Date.now() > tok.obtainedAt + (tok.expires_in - 60) * 1000) await renew();
    return tok.access_token;
  };
  const client = new McpClient({ url: new URL('/mcp', origin).toString(), getToken, onUnauthorized: renew, fetchImpl });
  return { client, stats };
}

/** Every active note's GUID, by search_notes pages of 100 (startIndex), oldest first. */
export async function listNoteGuids(call) {
  const guids = [];
  const seen = new Set();
  for (let start = 0; ;) {
    const data = await call('search_notes', { query: '', maxResults: PAGE, startIndex: start, sortBy: 'created', ascending: true });
    if (!Array.isArray(data?.hits)) throw new Error('Evernote answered search_notes in a way this tool does not understand.');
    let fresh = 0;
    for (const h of data.hits) {
      const id = String(h?.noteId ?? '').toLowerCase();
      if (GUID_RE.test(id) && !seen.has(id)) { seen.add(id); guids.push(id); fresh += 1; }
    }
    start += data.hits.length;
    if (data.isLastPage === true || data.hits.length === 0) break;
    // A page of nothing new that still says "more" would page forever: the listing cannot be trusted, so stop.
    if (fresh === 0) throw new Error('Evernote\'s note list repeated itself instead of moving on, so it cannot be checked against the plan.');
  }
  return guids;
}

/** One note's ENML, or BodyMissing. A rate limit the pacer gave up on, or a network failure, is thrown as is. */
export async function fetchNoteBody(call, guid) {
  let data;
  try {
    data = await call('get_note', { noteId: guid });
  } catch (e) {
    if (e?.toolError) throw new BodyMissing('get_note returned an error');
    throw e;
  }
  if (typeof data?.content !== 'string' || String(data.id ?? '').toLowerCase() !== guid.toLowerCase()) throw new BodyMissing('get_note returned no body');
  return { enml: data.content, resources: Array.isArray(data.resources) ? data.resources : [] };
}

/**
 * Signs in, checks the tools, and lists every note. { freePlan: true } when Evernote refuses this account; otherwise
 * { call, listed, stats }. Any other failure is thrown: the person asked for formatted notes, so the run stops.
 */
export async function openEvernote({ origin = EVERNOTE_MCP, fetchImpl = fetch, port = 8765, authorize = browserAuthorize,
  log = () => {}, sleep, now } = {}) {
  const stats = { limits: 0, calls: 0, refreshes: 0 };
  try {
    const session = await signIn({ origin, fetchImpl, port, authorize, log });
    const { client } = session;
    await client.initialize();
    await client.listTools();
    const missing = NEEDED.filter((t) => !client.tools.has(t));
    if (missing.length) throw new Error(`Evernote's server does not offer ${missing.join(' and ')}, so formatted notes cannot be fetched.`);
    // Never climbs (461's second run): not above 1.1/s, and after a limit it stays at the halved rate.
    const pacer = new Pacer({ rps: STEADY_RPS, maxRps: STEADY_RPS, cleanStretch: Infinity, ...(sleep ? { sleep } : {}), ...(now ? { now } : {}),
      onLimit: ({ waitedMs }) => { stats.limits += 1; log(`Evernote asked the tool to slow down; waiting ${Math.round(waitedMs / 1000)} s.`); } });
    const call = (name, args) => pacer.run(async () => {
      stats.calls += 1;
      return resultData((await client.callTool(name, args)).result);
    });
    const listed = await listNoteGuids(call);
    Object.defineProperty(stats, 'refreshes', { get: () => session.stats.refreshes, enumerable: true });
    return { freePlan: false, call, listed, stats, pacer };
  } catch (e) {
    if (isFreePlanRefusal(e)) return { freePlan: true, stats };
    throw e;
  }
}
