// 512 — the formatted route's Evernote half: sign in to Evernote's MCP server (461's OAuth client), list every note,
// and fetch one note's ENML at a pace the server accepts.
//
// Rules this module owns (Kosko doc 512):
// - Tokens live in this process's memory only (461 rule 2). An expired access token is renewed with the refresh token,
//   never with a second browser sign-in.
// - Read tools only (461 rule 1, client.mjs's allowlist), and the run refuses to start without search_notes and get_note.
// - One request in flight, 1.1 calls a second steady, never climbing; a rate-limit answer (HTTP 429, or a tool result
//   with isError naming the limit, as 461 measured) waits as told and halves the rate (pacer.mjs).
// - A free-plan refusal is recognised, so the caller can say so in one sentence and carry on with plain text. Only an
//   explicit refusal that names a plan or subscription counts (review T4): a bare 401/403 is a sign-in that does not
//   work, and stops the run with that said.
//   NOT RECORDED: the free-plan refusal's exact shape was not captured on 2026-10-04 (ADR-0007 says only "refused on a
//   free account"). It is recognised as an HTTP 403 whose body names a plan or subscription, or a JSON-RPC error / tool
//   error whose text does. W7 records the real one and narrows this.
// - Every request has a deadline (review T1): CALL_TIMEOUT_MS per MCP or OAuth request, combined with the run's own
//   signal (Ctrl-C), so nothing waits forever and Ctrl-C reaches every wait — sign-in, listing, the pacer, downloads.
import { createHash } from 'node:crypto';
import { authorizeUrl, discover, exchangeCode, newState, pkcePair, refreshToken, register, waitForCallback } from './oauth.mjs';
import { McpClient, resultData } from './client.mjs';
import { Pacer, PacerGaveUp, RateLimitError } from './pacer.mjs';

export const EVERNOTE_MCP = 'https://mcp.evernote.com';
export const STEADY_RPS = 1.1; // 461's second run: the ceiling is 72-96 calls a minute; 1.1/s never met it
export const PAGE = 100; // search_notes' page, as 461 listed 175 of 175
// 461's slowest call was 1.4 s (get_note p95 0.9 s): a minute is forty times that, so only a hung connection meets it.
export const CALL_TIMEOUT_MS = 60_000;
// A download's deadline grows with its size: a floor of a minute, plus a second per 64 KB (a 64 KB/s line, slower than
// any 461 measured: 185 KB in a median 304 ms). A 200 MB file (Kosko's cap) gets about 54 minutes.
export const DOWNLOAD_FLOOR_MS = 60_000;
export const DOWNLOAD_BYTES_PER_SEC = 64 * 1024;
export const downloadTimeoutMs = (size, floorMs = DOWNLOAD_FLOOR_MS) => Math.max(floorMs, floorMs + Math.ceil(size / DOWNLOAD_BYTES_PER_SEC) * 1000);
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NEEDED = ['search_notes', 'get_note'];
const PLAN_TEXT = /\b(plan|plans|subscription|upgrade|premium)\b/i;

/** Evernote will not serve this account over MCP (a free plan). The run carries on as plain text. */
export class FreePlanRefused extends Error {}
/** get_note had no body for a note search_notes listed (deleted since, or an error that is not a rate limit). */
export class BodyMissing extends Error {}
/** 513: Evernote could not give this file's bytes, or gave bytes that are not the file. Its placeholder stays. */
export class AttachmentMissing extends Error {}

/** The Evernote sign-in stopped working mid-run: the refresh failed, or Evernote answered 401/403 after it. */
export class EvernoteAuthFailed extends Error {}

/** Only an explicit refusal that names a plan or subscription (review T4); a bare 403 is not one. */
export function isFreePlanRefusal(e) {
  if (e instanceof FreePlanRefused) return true;
  if (e instanceof RateLimitError) return false;
  return (e?.status === 403 || e?.rpcCode != null || e?.toolError === true) && PLAN_TEXT.test(String(e.detail ?? ''));
}

/** A sign-in that does not work: it would fail every note, so the run stops (review T3). */
export const isAuthFailure = (e) => e instanceof EvernoteAuthFailed || e?.status === 401 || e?.status === 403;

/**
 * A failure of one call that the next try may not meet (review T3): an undici network error, the per-call deadline, a
 * 5xx or 429, or a rate limit the pacer gave up on. Never the run's own abort, a sign-in failure, or a bug of ours.
 */
export function isTransient(e) {
  if (isAuthFailure(e)) return false;
  if (e instanceof PacerGaveUp) return true;
  if (e?.status >= 500 || e?.status === 429) return true;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true; // the per-call deadline (the run's abort is checked first)
  // undici's network failures only: "fetch failed", or a TypeError whose cause names a network code (a reset or cut-off
  // connection, a lookup that failed). A TypeError from this tool's own code is a bug and propagates (review follow-up).
  if (e instanceof TypeError && (e.message === 'fetch failed' || NET_CODE.test(String(e.cause?.code ?? '')))) return true;
  return false;
}
const NET_CODE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)$/;

/** The run's signal plus a per-request deadline. */
export const deadline = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** The browser step: print the address, wait for Evernote to send the person back to 127.0.0.1. */
export async function browserAuthorize({ url, port, state, log, signal }) {
  log(`Open this address in your browser and sign in to Evernote (read only):\n${url}`);
  return waitForCallback({ port, state, signal });
}

/** Signs in once and returns an MCP client whose token is renewed in memory. */
export async function signIn({ origin = EVERNOTE_MCP, fetchImpl = fetch, port = 8765, authorize = browserAuthorize, log = () => {}, signal }) {
  const { resource, as } = await discover(origin, fetchImpl);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const clientId = await register(as, { redirectUri, clientName: 'Kosko desktop assist' }, fetchImpl);
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const url = authorizeUrl(as, { clientId, redirectUri, challenge, state, scope: 'read', resource });
  const code = await authorize({ url, port, state, redirectUri, log, signal });
  let tok = await exchangeCode(as, { clientId, code, verifier, redirectUri, resource }, fetchImpl);
  const stats = { refreshes: 0 };
  const renew = async () => {
    if (!tok.refresh_token) throw new EvernoteAuthFailed('The Evernote sign-in expired and cannot be renewed.');
    let next;
    try {
      next = await refreshToken(as, { clientId, refresh: tok.refresh_token, resource }, fetchImpl);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new EvernoteAuthFailed('The Evernote sign-in could not be renewed.');
    }
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
  log = () => {}, sleep, now, signal, callTimeoutMs = CALL_TIMEOUT_MS } = {}) {
  const stats = { limits: 0, calls: 0, refreshes: 0 };
  // Every OAuth and MCP request carries the run's signal and its own deadline (review T1/T2).
  const timedFetch = (url, init = {}) => fetchImpl(url, { ...init, signal: deadline(signal, callTimeoutMs) });
  // The pacer's waits (a rate limit's 60 s, the steady gap) end at Ctrl-C too.
  const wait = async (ms) => {
    if (signal?.aborted) throw signal.reason;
    await (sleep ? sleep(ms, signal) : abortableWait(ms, signal));
    if (signal?.aborted) throw signal.reason;
  };
  try {
    const session = await signIn({ origin, fetchImpl: timedFetch, port, authorize, log, signal });
    const { client } = session;
    await client.initialize();
    await client.listTools();
    const missing = NEEDED.filter((t) => !client.tools.has(t));
    if (missing.length) throw new Error(`Evernote's server does not offer ${missing.join(' and ')}, so formatted notes cannot be fetched.`);
    // Never climbs (461's second run): not above 1.1/s, and after a limit it stays at the halved rate.
    const pacer = new Pacer({ rps: STEADY_RPS, maxRps: STEADY_RPS, cleanStretch: Infinity, sleep: wait, ...(now ? { now } : {}),
      onLimit: ({ waitedMs }) => { stats.limits += 1; log(`Evernote asked the tool to slow down; waiting ${Math.round(waitedMs / 1000)} s.`); } });
    const call = (name, args) => pacer.run(async () => {
      stats.calls += 1;
      return resultData((await client.callTool(name, args)).result);
    });
    const listed = await listNoteGuids(call);
    Object.defineProperty(stats, 'refreshes', { get: () => session.stats.refreshes, enumerable: true });
    return { freePlan: false, call, listed, stats, pacer, wait };
  } catch (e) {
    if (signal?.aborted) throw e;
    if (isFreePlanRefusal(e)) return { freePlan: true, stats };
    // Review T4: a 401/403 that names no plan is a sign-in that does not work, said so — never read as a free plan.
    if (isAuthFailure(e)) throw new Error(`Evernote refused the sign-in (${e.status ? `HTTP ${e.status}` : 'it could not be renewed'}). Run the same command again to sign in again.`);
    throw e;
  }
}

function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// 461: get_attachment's URL is "a short-lived, pre-signed HTTPS URL" (tools.json). Its host was NOT recorded on
// 2026-10-04 (the probe kept counts only), so the pin is Evernote's own domain: evernote.com and its subdomains. If W7
// records another host (a CDN), this list is widened to exactly that host. Plain HTTP on 127.0.0.1 is never allowed
// here: the fake server's real-HTTP proof injects its own rule (`signedUrlOk`), production never does (review T10).
export const SIGNED_URL_HOSTS = Object.freeze(['evernote.com']);
export function isSignedUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password
      && SIGNED_URL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
}

/**
 * The body, read as a stream with a running count: more bytes than the plan recorded abort the download at once, so
 * an endless or oversized answer is never held in memory (review T1). null when it was cut off or too long.
 */
async function readExactly(res, size) {
  if (!res.body) return size === 0 ? new Uint8Array(0) : null;
  const out = new Uint8Array(size);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > size) { await reader.cancel().catch(() => {}); return null; }
      out.set(value, got);
      got += value.length;
    }
  } finally { reader.releaseLock?.(); }
  return got === size ? out : null;
}

/**
 * 513 — one attachment's bytes, from get_attachment's signed URL (461: 300 s, no auth header, no follow-up call).
 * The URL is used at once. One already past its `expiresAt`, or a download answered 403 (an expired signature), is
 * replaced by a new URL ONCE. The bytes must be the size the plan recorded and hash to the resource's MD5, or nothing
 * is returned. A tool error (Evernote has no such file) and any failed download are AttachmentMissing; a failure of
 * the MCP call itself (network, a rate limit the pacer gave up on) is thrown as is, as get_note's is, and the caller
 * decides (512's route retries it, then gives the file up). The download follows no redirect, has a deadline scaled
 * to its size, and ends at Ctrl-C (`signal`): the run's abort is thrown as is, never read as a missing file.
 */
export async function fetchAttachment({ call, fetchImpl = fetch, now = Date.now, signal, signedUrlOk = isSignedUrl,
  downloadFloorMs = DOWNLOAD_FLOOR_MS }, { guid, md5, size }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let data;
    try {
      data = await call('get_attachment', { noteId: guid, hash: md5 });
    } catch (e) {
      if (e?.toolError) throw new AttachmentMissing('refused');
      throw e;
    }
    if (typeof data?.url !== 'string' || !signedUrlOk(data.url)) throw new AttachmentMissing('no_url');
    const expires = Date.parse(String(data.expiresAt ?? ''));
    if (Number.isFinite(expires) && now() >= expires) continue;
    let res;
    let bytes;
    try {
      // No Authorization header: the URL is the credential. No redirect: a hop could leave the pinned host.
      res = await fetchImpl(data.url, { method: 'GET', redirect: 'error', signal: deadline(signal, downloadTimeoutMs(size, downloadFloorMs)) });
      if (res.status === 403) { await res.body?.cancel?.(); continue; }
      if (!res.ok) { await res.body?.cancel?.(); throw new AttachmentMissing('download_failed'); }
      const declared = res.headers.get('content-length');
      if (declared !== null && Number(declared) !== size) { await res.body?.cancel?.(); throw new AttachmentMissing('wrong_size'); }
      bytes = await readExactly(res, size);
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e;
      if (e instanceof AttachmentMissing) throw e;
      throw new AttachmentMissing('download_failed');
    }
    if (!bytes) throw new AttachmentMissing('wrong_size');
    if (createHash('md5').update(bytes).digest('hex') !== md5) throw new AttachmentMissing('not_the_file');
    return bytes;
  }
  throw new AttachmentMissing('expired');
}
