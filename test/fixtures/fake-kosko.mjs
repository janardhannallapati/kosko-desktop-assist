// An in-memory Kosko import intake for 467's tests: the routes' shapes and the ledger rules the sender depends on,
// as a `fetch` the client is given. It holds state across runs, so a second run meets the first run's ledger.
// Mirrors (Kosko docs): 380 notebooks reuse by (parent, folded name) · 464 tags by slug · 463 note-ids GUID-first
// with `clash` · 432 notes/batch per-index results, a note found by GUID or fp1 is `skipped` · 381/432 attachments,
// a stored key answers `upload: null` · 423/465 receipt (the desktop block's sum rule) · 382 job lifecycle.
import { createHash, randomUUID } from 'node:crypto';

const fold = (s) => String(s).trim().toLowerCase();
const uuidOf = (text) => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
// Kosko 511's import_body_hash: one hash over title and body (jsonb normalises key order there; JSON here is built in a
// fixed order by the tool, and a Kosko edit through editNote changes the stored record itself).
const bodyHash = (title, content) => createHash('sha256').update(JSON.stringify([title ?? null, content ?? null])).digest('hex');
const mediaPaths = (doc) => {
  const out = new Set();
  (function walk(n) { if (!n || typeof n !== 'object') return; if (typeof n.attrs?.path === 'string') out.add(n.attrs.path); (n.content ?? []).forEach(walk); })(doc);
  return out;
};
const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function createFakeKosko({ maxFileBytes = 200 * 1024 * 1024 } = {}) {
  const ownMedia = (r) => {
    // Kosko 379: a media path is a placeholder or THIS note's own key, or the whole record is refused.
    let ok = true;
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      const p = n.attrs?.path;
      if ((n.type === 'noteImage' || n.type === 'noteAttachment') && !(/^enex-resource:[0-9a-f]{32}$/.test(p) || String(p).startsWith(`notes/${r.id}/`))) ok = false;
      (n.content ?? []).forEach(walk);
    })(r.content);
    return ok;
  };
  const state = {
    jobs: [], notebooks: new Map(), tags: new Map(), ledgerByGuid: new Map(), ledgerByFp: new Map(),
    notes: new Map(), stored: new Map(), refusals: [], requests: [], uploads: [],
    // test hooks: per-call overrides
    noteErrors: new Map(), // guid -> [code, …] consumed one per attempt
    badAnswers: new Set(), // guids whose next notes/batch result is neither an outcome nor an error
    expireUploads: 0, // the next N store PUTs answer 403 (an expired presigned URL)
    mintErrors: [], // codes answered, one per item, by the next attachments/batch items
    failNextNotesBatch: 0,
    tagCalls: [], noteIdCalls: [],
    // 501/504: image text by `${note_id}|${md5}`, and each ocr/batch call's item count and JSON byte size
    ocr: new Map(), ocrCalls: [],
    // A note in Kosko's trash, or locked (encryption <> 'none'), by node id. A DELETED note: remove it from `notes`
    // and keep its ledger entry (Kosko 420's tombstone answers the same way).
    trashed: new Set(), locked: new Set(),
    // 511/512: notes updated in place (node ids), the pre-images note_versions would hold, and would_drop_media refusals
    updates: [], versions: [], dropRefusals: 0
  };

  function job(id) { return state.jobs.find((j) => j.id === id); }

  // Kosko 511 rule 2, in its order: deleted, trash, same version, no flag, no baseline, edited in Kosko, unchanged,
  // then the update in place (same id, title and body, tags only added; would_drop_media refused). The batch route
  // reports every 22023 as `invalid` (Kosko 512: only the single-note route can name would_drop_media).
  function matched(e, r, index) {
    const skip = (reason) => ({ index, outcome: 'skipped', node_id: e.nodeId, reason });
    const node = state.notes.get(e.nodeId);
    if (!node) return skip('deleted_in_kosko');
    if (state.trashed.has(e.nodeId)) return skip('in_kosko_trash');
    if (e.version === r.version_hash) return skip(null);
    if (r.update !== true) return skip('changed_in_evernote');
    if (!e.writtenHash) return skip('changed_in_evernote');
    if (bodyHash(node.title, node.content) !== e.writtenHash) return skip('edited_in_kosko');
    if (bodyHash(r.title, r.content) === e.writtenHash) { e.version = r.version_hash; return skip('unchanged'); }
    if (r.id && r.id !== e.nodeId) return { index, error: { code: 'invalid' } };
    const incoming = mediaPaths(r.content);
    if (![...mediaPaths(node.content)].every((p) => incoming.has(p))) { state.dropRefusals += 1; return { index, error: { code: 'invalid' } }; }
    if (!ownMedia({ ...r, id: e.nodeId })) return { index, error: { code: 'invalid' } };
    state.versions.push({ nodeId: e.nodeId, content: node.content });
    Object.assign(node, { title: r.title, content: r.content, updated_at: r.updated_at, tags: [...new Set([...(node.tags ?? []), ...(r.tags ?? [])])] });
    Object.assign(e, { version: r.version_hash, writtenHash: bodyHash(node.title, node.content) });
    state.updates.push(e.nodeId);
    return { index, outcome: 'updated', node_id: e.nodeId, reason: null };
  }
  function openJob(id) { const j = job(id); return j && j.status === 'running' ? j : null; }

  const routes = {
    'POST /api/import/jobs': (body) => {
      for (const j of state.jobs) if (j.status === 'running') { j.status = 'cancelled'; j.summary = { ...(j.summary ?? {}), continued: 1 }; }
      const j = { id: randomUUID(), status: 'running', source: body?.source ?? 'enex', summary: body?.expected ? { expected: body.expected } : {}, receipt: null, created: state.jobs.length };
      state.jobs.push(j);
      return json(201, { id: j.id, status: 'running' });
    },
    'GET /api/import/jobs': () => {
      const j = state.jobs.at(-1);
      return json(200, { job: j && j.status !== 'complete' ? { id: j.id, source: j.source, status: j.status } : null });
    },
    'DELETE /api/import/jobs': () => json(204, null),
    'PATCH /api/import/jobs/[id]': (body, id) => {
      const j = openJob(id);
      if (!j) return json(409, { code: 'job_closed' });
      if (body.receipt !== undefined && !receiptOk(body.receipt)) return json(400, { code: 'invalid' });
      Object.assign(j, { status: body.status, summary: body.summary, receipt: body.receipt ?? null });
      return json(200, { id: j.id, status: j.status });
    },
    'GET /api/import/allowance': () => json(200, { byteLimit: 10 * 1024 ** 3, bytesUsed: 0, maxFileBytes }),
    'POST /api/import/notebooks': (body) => {
      if (!openJob(body.job_id)) return json(409, { code: 'job_closed' });
      const ids = {};
      let created = 0;
      let reused = 0;
      const pending = [...body.notebooks];
      for (let guard = 0; pending.length && guard < 10_000; guard++) {
        const e = pending.shift();
        if (e.parent_key && !ids[e.parent_key]) {
          if (!body.notebooks.some((x) => x.key === e.parent_key)) return json(400, { code: 'invalid' });
          pending.push(e); continue;
        }
        const parent = e.parent_key ? ids[e.parent_key] : null;
        const k = `${parent}|${fold(e.name)}`;
        if (state.notebooks.has(k)) { ids[e.key] = state.notebooks.get(k); reused++; } else { ids[e.key] = randomUUID(); state.notebooks.set(k, ids[e.key]); created++; }
      }
      return json(200, { ids, created, reused });
    },
    'POST /api/import/tags': (body) => {
      if (!openJob(body.job_id)) return json(409, { code: 'job_closed' });
      if (!Array.isArray(body.names) || body.names.length < 1 || body.names.length > 1000) return json(400, { code: 'invalid' });
      state.tagCalls.push(body.names.length);
      let created = 0; let reused = 0; let dropped = 0;
      for (const n of body.names) {
        const slug = fold(n).replace(/^#/, '');
        if (!slug) { dropped++; continue; }
        if (state.tags.has(slug)) reused++; else { state.tags.set(slug, n); created++; }
      }
      return json(200, { created, reused, shortened: 0, dropped });
    },
    'POST /api/import/note-ids': (body) => {
      const { fingerprints, external_ids: guids } = body;
      if (!Array.isArray(fingerprints) || fingerprints.length > 1000 || (guids && guids.length !== fingerprints.length)) return json(400, { code: 'invalid' });
      state.noteIdCalls.push(fingerprints.length);
      const ids = {};
      fingerprints.forEach((fp, i) => {
        const g = guids?.[i] ?? null;
        // Kosko 424/463: the GUID's entry first, then the fingerprint's; a live node is `here`, a trashed one `trash`,
        // one gone (or unreadable) `deleted` — the last two with no id.
        const e = (g && state.ledgerByGuid.get(g)) || state.ledgerByFp.get(fp);
        if (e && g && e.guid && e.guid !== g) { ids[fp] = { id: null, state: 'clash' }; return; }
        if (e) {
          ids[fp] = !state.notes.has(e.nodeId) ? { id: null, state: 'deleted' }
            : state.trashed.has(e.nodeId) ? { id: null, state: 'trash' } : { id: e.nodeId, state: 'here' };
          return;
        }
        ids[fp] = { id: uuidOf(`fp:${fp}`), state: 'new' };
      });
      return json(200, { ids });
    },
    'POST /api/import/attachments/batch': (body) => {
      if (!openJob(body.job_id)) return json(409, { code: 'job_closed' });
      if (body.items.length > 100) return json(400, { code: 'invalid' });
      const results = body.items.map((it, index) => {
        const forced = state.mintErrors.shift();
        if (forced) return { index, error: { code: forced } };
        const ext = it.content_type === 'image/png' ? 'png' : it.content_type === 'application/pdf' ? 'pdf' : 'bin';
        const path = `notes/${it.note_id}/${it.folder}/${it.md5}.${ext}`;
        if (state.stored.has(path)) return { index, path, upload: null };
        return { index, path, upload: { url: `https://store.test/${path}`, method: 'PUT', headers: { 'content-type': it.content_type, 'content-length': String(it.size) }, expiresIn: 3600 } };
      });
      return json(200, { results });
    },
    'POST /api/import/notes/batch': (body) => {
      if (!openJob(body.job_id)) return json(409, { code: 'job_closed' });
      if (state.failNextNotesBatch > 0) { state.failNextNotesBatch--; return json(503, { code: 'unavailable' }); }
      const results = body.notes.map((r, index) => {
        if (state.badAnswers.delete(r.external_id)) return { index, outcome: 'bogus' };
        const queued = state.noteErrors.get(r.external_id);
        if (queued?.length) return { index, error: { code: queued.shift() } };
        if (r.content?.type !== 'doc' || !ownMedia(r) || !/^fp1:[0-9a-f]{64}$/.test(r.fingerprint) || !/^[0-9a-f]{64}$/.test(r.version_hash)) return { index, error: { code: 'invalid' } };
        if (r.update !== undefined && typeof r.update !== 'boolean') return { index, error: { code: 'invalid' } };
        const known = (r.external_id && state.ledgerByGuid.get(r.external_id)) || state.ledgerByFp.get(r.fingerprint);
        if (known) return matched(known, r, index);
        if (state.notes.has(r.id)) return { index, error: { code: 'id_taken' } };
        const entry = { nodeId: r.id, guid: r.external_id ?? null, version: r.version_hash, writtenHash: bodyHash(r.title, r.content) };
        state.ledgerByFp.set(r.fingerprint, entry);
        if (r.external_id) state.ledgerByGuid.set(r.external_id, entry);
        state.notes.set(r.id, r);
        return { index, outcome: 'created', node_id: r.id, reason: null };
      });
      return json(200, { results });
    },
    // Kosko 501's shape check (exactly four keys, a uuid and a 32-hex md5, empty ⇔ '' text, ≤ 32,768 characters,
    // 1–500 items, ≤ 4 MB), then 500's import_ocr item by item, in its order: a note that is missing, deleted or in
    // the trash is refused note_not_found; a locked one locked; an md5 that is neither this note's own stored key
    // (notes/<id>/images|attachments/<md5>.<ext>) nor an enex-resource:<md5> placeholder in its content is refused
    // not_an_attachment. The rest are upserted by (note_id, md5) as created / updated / unchanged.
    'POST /api/import/ocr/batch': (body, _id, raw) => {
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return json(413, { code: 'too_large' });
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const keys = ['note_id', 'md5', 'status', 'text'];
      const okItem = (it) => it && typeof it === 'object' && Object.keys(it).length === 4 && keys.every((k) => Object.hasOwn(it, k))
        && UUID.test(String(it.note_id)) && /^[0-9a-f]{32}$/.test(String(it.md5)) && typeof it.text === 'string' && it.text.length <= 32768
        && ((it.status === 'empty' && it.text === '') || (it.status === 'words' && it.text.trim() !== ''));
      if (!UUID.test(String(body?.job_id)) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 500 || !body.items.every(okItem)) {
        return json(400, { code: 'invalid' });
      }
      if (!openJob(body.job_id)) return json(409, { code: 'job_closed' });
      state.ocrCalls.push({ items: body.items.length, bytes: Buffer.byteLength(raw) });
      let created = 0; let updated = 0; let unchanged = 0;
      const refused = [];
      body.items.forEach((it, i) => {
        const note = state.notes.get(it.note_id.toLowerCase());
        if (!note || state.trashed.has(note.id)) { refused.push({ i, reason: 'note_not_found' }); return; }
        if (state.locked.has(note.id)) { refused.push({ i, reason: 'locked' }); return; }
        const stored = new Set();
        (function walk(n) {
          if (!n || typeof n !== 'object') return;
          // Kosko 500 rule 5, exactly: this note's own stored key, or the placeholder of a file not on this computer.
          const p = String(n.attrs?.path ?? '');
          const m = new RegExp(`^notes/${it.note_id.toLowerCase()}/(?:images|attachments)/([0-9a-f]{32})\\.[^/]+$`).exec(p) || /^enex-resource:([0-9a-f]{32})$/.exec(p);
          if (m) stored.add(m[1]);
          (n.content ?? []).forEach(walk);
        })(note.content);
        if (!stored.has(it.md5)) { refused.push({ i, reason: 'not_an_attachment' }); return; }
        const k = `${it.note_id.toLowerCase()}|${it.md5}`;
        const was = state.ocr.get(k);
        if (!was) created++; else if (was.status === it.status && was.text === it.text) unchanged++; else updated++;
        state.ocr.set(k, { status: it.status, text: it.text });
      });
      state.ocrCalls.at(-1).answer = { created, updated, unchanged, refused: refused.length };
      return json(200, { created, updated, unchanged, refused });
    },
    'POST /api/import/refusals': (body) => { state.refusals.push(body); return json(200, { outcome: 'not_imported' }); }
  };

  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'store.test') {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const path = u.pathname.slice(1);
      state.uploads.push({ path, bytes: bytes.length, headers: init.headers });
      if (init.headers?.authorization) return new Response(null, { status: 400 });
      if (state.expireUploads > 0) { state.expireUploads--; return new Response(null, { status: 403 }); }
      state.stored.set(path, bytes.length);
      return new Response(null, { status: 200 });
    }
    const m = /^\/api\/import\/jobs\/([0-9a-f-]{36})(\/receipt)?$/.exec(u.pathname);
    const route = m ? `/api/import/jobs/[id]${m[2] ?? ''}` : u.pathname;
    const key = `${init.method ?? 'GET'} ${route}`;
    state.requests.push(key);
    const handler = routes[key];
    if (!handler) return json(404, { code: 'not_found' });
    if (init.headers?.authorization !== 'Bearer ' + fake.token) return json(401, { error: 'no' });
    return handler(init.body ? JSON.parse(init.body) : undefined, m?.[1], init.body ?? '');
  };

  /** An edit in Kosko's editor (through the notes view): the body changes, the ledger's written hash does not. */
  const editNote = (nodeId, { title, content } = {}) => {
    const n = state.notes.get(nodeId);
    if (title !== undefined) n.title = title;
    if (content !== undefined) n.content = content;
  };
  const fake = { fetch, state, token: null, job, editNote };
  return fake;
}

// Kosko 423 + 465: the receipt's own keys, and the desktop block's keys and sum rule.
function receiptOk(r) {
  const keys = ['v', 'notes', 'notesMore', 'files', 'filesMore', 'links', 'linksMore', 'cannotCarry', 'desktop'];
  if (!r || r.v !== 1 || !Object.keys(r).every((k) => keys.includes(k))) return false;
  if (!r.desktop) return true;
  const d = r.desktop;
  // 501: the OCR group is all five keys or none.
  const OCR = ['ocrWords', 'ocrEmpty', 'ocrUnreadable', 'ocrNotSent', 'ocrRefused'];
  const counts = ['notebooks', 'stacks', 'spaceNotebooks', 'tags', 'tagsDropped', 'noteTags', 'trashedNotes', 'missingFiles', 'missingMore',
    ...(OCR.some((k) => Object.hasOwn(d, k)) ? OCR : [])];
  if (Object.keys(d).length !== counts.length + 1 || !counts.every((k) => Number.isInteger(d[k]) && d[k] >= 0)) return false;
  if (!Array.isArray(d.missing) || d.missing.length > 1000) return false;
  if (!d.missing.every((m) => Object.keys(m).length === 2 && typeof m.note === 'string' && typeof m.name === 'string')) return false;
  return d.missing.length + d.missingMore === d.missingFiles;
}
