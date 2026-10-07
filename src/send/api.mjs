// 466 rules 3-5 and 8 — the tool's ONE way to talk to Kosko: the 13 routes an import token may call (Kosko's
// lib/bearer-scope.js IMPORT_BEARER_ROUTES), on one checked origin, plus PUTs to presigned upload URLs.
//
// Every request: `Authorization: Bearer <token>`, `cache: no-store`, `redirect: 'error'` (a token never follows a
// redirect to another host), a timeout. Every non-2xx answer becomes an ImportApiError of one kind (errors.mjs); a
// 2xx that is not JSON is `invalid`, never read as success (a sign-in page answering 200 is not an import).
// Uploads carry exactly the headers Kosko signed (type and exact length, Kosko 257) and NO Authorization.
import { ImportApiError, kindOf } from './errors.mjs';

export const DEFAULT_APP = 'https://kosko.app';
const TIMEOUT_MS = 60_000;
const LEAVE_TIMEOUT_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const IMPORT_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', route: '/api/import/jobs' }),
  Object.freeze({ method: 'POST', route: '/api/import/jobs' }),
  Object.freeze({ method: 'DELETE', route: '/api/import/jobs' }),
  Object.freeze({ method: 'PATCH', route: '/api/import/jobs/[id]' }),
  Object.freeze({ method: 'GET', route: '/api/import/jobs/[id]/receipt' }),
  Object.freeze({ method: 'GET', route: '/api/import/allowance' }),
  Object.freeze({ method: 'POST', route: '/api/import/notebooks' }),
  Object.freeze({ method: 'POST', route: '/api/import/note-ids' }),
  Object.freeze({ method: 'POST', route: '/api/import/notes/batch' }),
  Object.freeze({ method: 'POST', route: '/api/import/attachments/batch' }),
  Object.freeze({ method: 'POST', route: '/api/import/refusals' }),
  Object.freeze({ method: 'POST', route: '/api/import/tags' }),
  Object.freeze({ method: 'POST', route: '/api/import/ocr/batch' }) // 501/504: Evernote's image text
]);

// https, or plain http to 127.0.0.1 only (a local Kosko, or the local object store); never `localhost`, which from
// Windows into WSL resolves to ::1 first and stalls ~21 s before falling back (Kosko CLAUDE.md, environment hazards).
function checkedUrl(raw, what) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error(`${what} is not a web address.`); }
  if (u.username || u.password) throw new Error(`${what} must not carry a user name or password.`);
  if (u.hostname === 'localhost') throw new Error(`${what}: use http://127.0.0.1:<port>, not localhost.`);
  const local = u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) throw new Error(`${what} must start with https:// (or be http://127.0.0.1:<port>).`);
  return u;
}

export const appOrigin = (raw) => checkedUrl(raw ?? DEFAULT_APP, 'The Kosko address').origin;

function retryAfterOf(res, body) {
  const header = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  if (Number.isFinite(header)) return header;
  return Number.isFinite(body?.retryAfterSeconds) ? body.retryAfterSeconds : null;
}

// A thrown fetch: the run was stopped (aborted — stop, never wait), a redirect `redirect: 'error'` refused (invalid —
// resending cannot help), or a network failure or the timeout (transient — the request may be sent again). The
// error's cause is dropped: it can carry the URL and headers.
function failed(e, runSignal) {
  if (runSignal?.aborted) return new ImportApiError({ status: 0, kind: 'aborted', code: 'aborted', message: 'Stopped.' });
  if (/redirect/i.test(String(e?.cause?.message ?? ''))) {
    return new ImportApiError({ status: 0, kind: 'invalid', code: 'redirect', message: 'Kosko answered with a redirect, which the tool does not follow.' });
  }
  const code = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network';
  return new ImportApiError({ status: 0, kind: 'transient', code, message: `Kosko could not be reached (${code}).` });
}
const bodyLost = (status) => new ImportApiError({ status, kind: 'transient', code: 'body_read', message: 'Kosko\'s answer was cut off.' });

export function createImportApi({ app, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, signal } = {}) {
  const origin = appOrigin(app);
  const signalFor = (ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

  // `detached`: the request leaves the busy gate's line AFTER the run was stopped, so it must not carry the run's
  // (already aborted) signal — only its own short timeout (466 review H1).
  async function request(method, path, body, { detached = false } = {}) {
    const route = path.replace(UUID_IN_PATH, '[id]');
    if (!IMPORT_ROUTES.some((r) => r.method === method && r.route === route)) {
      throw new ImportApiError({ status: 0, kind: 'invalid', code: 'not_an_import_route', message: `${method} ${route} is not an import route.` });
    }
    let res;
    try {
      res = await fetchImpl(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        redirect: 'error',
        signal: detached ? AbortSignal.timeout(LEAVE_TIMEOUT_MS) : signalFor(timeoutMs)
      });
    } catch (e) {
      throw failed(e, detached ? null : signal);
    }
    if (res.status === 204) return null;
    let text;
    try { text = await res.text(); } catch { throw bodyLost(res.status); } // a 2xx whose write may have landed: resend
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
    if (res.ok) {
      if (json === undefined || json === null) throw new ImportApiError({ status: res.status, kind: 'invalid', code: 'not_json' });
      return json;
    }
    // The server's own `error` sentence is never kept: it is not ours to word, and it may echo what we sent.
    const code = typeof json?.code === 'string' && /^[a-z_]{1,40}$/.test(json.code) ? json.code : `http_${res.status}`;
    throw new ImportApiError({ status: res.status, kind: kindOf(res.status, code), code, retryAfterSeconds: retryAfterOf(res, json),
      position: Number.isInteger(json?.position) ? json.position : null, etaMinutes: Number.isInteger(json?.etaMinutes) ? json.etaMinutes : null });
  }

  const job = (id) => {
    if (!UUID_RE.test(String(id))) throw new ImportApiError({ status: 0, kind: 'invalid', code: 'invalid', message: 'A job id must be a UUID.' });
    return String(id).toLowerCase();
  };

  return {
    origin,
    newestJob: () => request('GET', '/api/import/jobs'),
    startJob: (body) => request('POST', '/api/import/jobs', body),
    leaveLine: () => request('DELETE', '/api/import/jobs', undefined, { detached: true }),
    finishJob: async (id, body) => request('PATCH', `/api/import/jobs/${job(id)}`, body),
    receipt: async (id) => request('GET', `/api/import/jobs/${job(id)}/receipt`),
    allowance: () => request('GET', '/api/import/allowance'),
    notebooks: (body) => request('POST', '/api/import/notebooks', body),
    noteIds: (body) => request('POST', '/api/import/note-ids', body),
    notesBatch: (body) => request('POST', '/api/import/notes/batch', body),
    attachmentsBatch: (body) => request('POST', '/api/import/attachments/batch', body),
    refusal: (body) => request('POST', '/api/import/refusals', body),
    tags: (body) => request('POST', '/api/import/tags', body),
    ocrBatch: (body) => request('POST', '/api/import/ocr/batch', body),

    /** PUT one file to a presigned URL from attachments/batch: exactly the signed headers, no Authorization. */
    async upload(presigned, bytes, { timeoutMs: uploadMs = TIMEOUT_MS + Math.ceil((bytes?.byteLength ?? 0) / 1e6) * 1000 } = {}) {
      const url = checkedUrl(presigned?.url, 'An upload address');
      if ((presigned.method ?? 'PUT') !== 'PUT') throw new Error('An upload must be a PUT.');
      let res;
      try {
        res = await fetchImpl(url.href, { method: 'PUT', headers: { ...(presigned.headers ?? {}) }, body: bytes, redirect: 'error', signal: signalFor(uploadMs) });
      } catch (e) {
        throw failed(e, signal);
      }
      await res.arrayBuffer().catch(() => null);
      if (res.ok) return { stored: true, already: false };
      if (res.status === 412) return { stored: true, already: true }; // If-None-Match: the key is already stored
      if (res.status === 403) throw new ImportApiError({ status: 403, kind: 'expired', code: 'upload_expired' });
      const again = res.status >= 500 || res.status === 408 || res.status === 429; // the store asked us to come back
      throw new ImportApiError({ status: res.status, kind: again ? 'transient' : 'invalid', code: `http_${res.status}` });
    }
  };
}
