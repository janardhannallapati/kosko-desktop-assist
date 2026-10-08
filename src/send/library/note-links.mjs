// 514 — links between notes, on the --evernote route. Kosko 424 rewrites an Evernote note link to the note it names
// when that is certain; /import can only guess by the link's text (an ENEX has no note GUIDs). This route has the
// GUIDs, so it is exact: the link's GUID (enex-core parseEvernoteNoteLink) → the plan's note → its fp1 → Kosko's
// note-ids answer. `here` or `new` with an id: the link becomes `/?note=<id>` and keeps the Evernote address in the
// link's `evernoteHref` (enex-core's EvernoteLinkOrigin), the exact shape Kosko's lib/enex/resolve-links.js writes.
// Anything else is left exactly as it was and listed:
//
//   not_in_plan         the GUID is no note of the plan: another account's, in Evernote's trash, or not on this computer
//   in_kosko_trash      Kosko holds it in its trash (note-ids `trash`)
//   deleted_in_kosko    Kosko held it and it was deleted for good (`deleted`)
//   clash               Kosko holds its creation second for a different Evernote note (`clash`)
//   no_stable_id        Kosko answered `new` without the id it will be written under (424 always gives one)
//   target_not_written  rewritten, but the note it names was then not written in this run (424's landed rule)
//
// Links are resolved before each note is written, from ids that do not depend on write order (424's stable ids: a
// `new` note is created under the id note-ids gave it). A note's links are counted only when its body is written
// (created or updated), as 424 counts them. Kosko's receipt lists a left link as `target_unavailable` (its reasons are
// a closed set); the exact reason goes to the summary's counts and, with GUIDs, to kosko-evernote-links.json beside the
// plan. Never a GUID, title or link text on the console (467 rule 12).
//
// Review fixes (2026-10-08): each written note's link outcomes are kept in the checkpoint (`links`, v3), so a resumed
// run counts the links the stopped run wrote (T6); a link to a `new` note that never settles in the run is listed
// `target_not_written`, never dropped (T7); the links a note leaves unresolved are part of its version, so the note is
// sent again once one can be resolved (T9, evernote-route.mjs finalize).
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseEvernoteNoteLink } from '@kosko-app/enex-core/enex';
import { writeLocalFile } from './local-file.mjs';

export const LINKS_NAME = 'kosko-evernote-links.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_IDS_MAX = 1000; // Kosko lib/enex/import-note-ids.js
const RECEIPT_LINKS = 500; // Kosko RECEIPT_LIMITS.links
const FILE_ROWS = 10_000;
const TEXT_MAX = 200;
const STATE_REASON = { trash: 'in_kosko_trash', deleted: 'deleted_in_kosko', clash: 'clash' };
const COUNT_KEY = { not_in_plan: 'notInPlan', in_kosko_trash: 'inKoskoTrash', deleted_in_kosko: 'deletedInKosko', clash: 'clash',
  no_stable_id: 'noStableId', target_not_written: 'targetNotWritten' };

export const LINK_REASONS = Object.freeze(Object.keys(COUNT_KEY));

/**
 * Review T9: a note's version with the GUIDs of the links it leaves unresolved, sorted and distinct. No left link: the
 * version as it is. Otherwise a SHA-256 over both (64 hex, as Kosko's version_hash must be).
 */
export function withLeftLinks(version, targets) {
  const set = [...new Set(targets.map((t) => String(t).toLowerCase()))].sort();
  if (!set.length) return version;
  return createHash('sha256').update(`${version}\nleft-links:${set.join(',')}`).digest('hex');
}

/** Kosko lib/note-deep-link.js noteDeepLink: only a UUID becomes a link. */
export function noteDeepLink(id) {
  if (!UUID_RE.test(String(id))) throw new Error('a note link needs a note id');
  return `/?note=${String(id).toLowerCase()}`;
}

const cut = (s) => Array.from(String(s ?? '').replace(/\s+/gu, ' ').trim()).slice(0, TEXT_MAX).join('').toWellFormed();
const linkMark = (node) => node.type === 'text' && node.marks?.find((m) => m.type === 'link' && parseEvernoteNoteLink(m.attrs?.href));

/** The note GUIDs a converted doc links to. */
export function linkTargets(doc) {
  const out = new Set();
  (function walk(n) {
    const m = n && linkMark(n);
    if (m) out.add(parseEvernoteNoteLink(m.attrs.href));
    (n?.content ?? []).forEach(walk);
  })(doc);
  return out;
}

/**
 * resolveNoteLinks(doc, decide) -> { doc, left: [{ target, text, reason }], used: [{ target, id, state, text }] }.
 * `decide(guid)` answers { id, state } or { reason }. Adjacent text nodes carrying the same href are one link (a bold
 * word inside a link is still that link), as in 424's resolveInline. Pure: the input doc is never mutated.
 */
export function resolveNoteLinks(doc, decide) {
  const left = [];
  const used = [];
  const inline = (content) => {
    const out = content.slice();
    for (let i = 0; i < out.length;) {
      const mark = linkMark(out[i]);
      if (!mark) { i += 1; continue; }
      let j = i;
      while (j < out.length && linkMark(out[j])?.attrs.href === mark.attrs.href) j += 1;
      const target = parseEvernoteNoteLink(mark.attrs.href);
      const text = cut(out.slice(i, j).map((n) => n.text).join(''));
      const d = decide(target);
      if (d.id) {
        const href = noteDeepLink(d.id);
        for (let k = i; k < j; k++) {
          out[k] = { ...out[k], marks: out[k].marks.map((m) => (m === linkMark(out[k]) ? { ...m, attrs: { ...m.attrs, href, evernoteHref: m.attrs.href } } : m)) };
        }
        used.push({ target, id: d.id.toLowerCase(), state: d.state, text });
      } else {
        left.push({ target, text, reason: d.reason });
      }
      i = j;
    }
    return out;
  };
  const walk = (node) => {
    if (!Array.isArray(node.content)) return node;
    const content = node.content.some((c) => c.type === 'text') ? inline(node.content) : node.content;
    return { ...node, content: content.map(walk) };
  };
  return { doc: walk(doc), left, used };
}

/**
 * One run's links: resolved per batch, judged as notes settle, reported at the end. `cp` (optional) is the run's
 * checkpoint: `cp.links` (note GUID → { rewritten, left: { reason: n }, pending: [[target GUID, id]] }) is kept up to
 * date as notes settle, and read back for the notes the stopped run settled (`cp.notes`), so their counts survive.
 */
export function createLinkLedger({ plan, fps, cp = null }) {
  const planned = new Map(plan.notes.map((n, i) => [String(n.id).toLowerCase(), { fp: fps[i], guid: String(n.id) }]));
  const answers = new Map(); // fp -> note-ids answer, asked once per run
  const landed = new Map(); // note GUID -> the Kosko id it was settled under (null when it was not written)
  const rows = []; // { note (GUID), target, reason, who, text }; `who` null for a link the stopped run left
  const counts = { rewritten: 0, left: 0, notInPlan: 0, inKoskoTrash: 0, deletedInKosko: 0, clash: 0, noStableId: 0, targetNotWritten: 0 };
  const pending = []; // rewritten to a `new` note not settled yet
  const store = cp ? cp.links : {};
  const recordOf = (guid) => (store[guid] ??= { rewritten: 0, left: {}, pending: [] });
  const list = (note, who, l, reason, { persist = true } = {}) => {
    counts.left += 1;
    counts[COUNT_KEY[reason]] += 1;
    rows.push({ note, target: l.target, reason, who, text: l.text });
    if (persist) { const r = recordOf(note); r.left[reason] = (r.left[reason] ?? 0) + 1; }
  };
  const unpend = (u) => {
    const r = recordOf(u.note);
    const i = r.pending.findIndex(([t, id]) => t === u.target && id === u.id);
    if (i >= 0) r.pending.splice(i, 1);
  };
  const judge = (u) => {
    unpend(u);
    if (landed.get(u.target) === u.id) { counts.rewritten += 1; recordOf(u.note).rewritten += 1; } else list(u.note, u.who, u, 'target_not_written');
  };
  const decide = (guid) => {
    const t = planned.get(guid);
    if (!t) return { reason: 'not_in_plan' };
    const st = answers.get(t.fp);
    if (st?.state === 'here' || st?.state === 'new') return UUID_RE.test(String(st.id)) ? { id: st.id, state: st.state } : { reason: 'no_stable_id' };
    return { reason: STATE_REASON[st?.state] ?? 'not_in_plan' };
  };

  // Review T6: the notes the stopped run settled count as that run counted them; their links still waiting for a `new`
  // target wait again (the target is one of this run's notes, or it is listed at the end).
  for (const [note, r] of Object.entries(store)) {
    if (!cp || !Object.hasOwn(cp.notes, note)) { delete store[note]; continue; }
    counts.rewritten += r.rewritten;
    for (const [reason, n] of Object.entries(r.left)) {
      for (let k = 0; k < n; k++) list(note, null, { target: null, text: '' }, reason, { persist: false });
    }
    for (const [target, id] of r.pending) pending.push({ note, target, id, who: null, text: '' });
  }

  return {
    /** Before the batch is written: every formatted body's links resolved. `ids` is the batch's note-ids answer. */
    async resolve(queue, ids, ask) {
      for (const x of queue) if (ids[x.fp]) answers.set(x.fp, ids[x.fp]);
      const want = new Map();
      for (const x of queue) {
        if (!x.converted) continue;
        for (const g of linkTargets(x.converted.doc)) {
          const t = planned.get(g);
          if (t && !answers.has(t.fp)) want.set(t.fp, t.guid);
        }
      }
      const entries = [...want].map(([fp, guid]) => ({ fp, guid }));
      for (let i = 0; i < entries.length; i += NOTE_IDS_MAX) {
        const chunk = entries.slice(i, i + NOTE_IDS_MAX);
        const got = await ask(chunk);
        for (const e of chunk) answers.set(e.fp, got[e.fp]);
      }
      for (const x of queue) {
        if (!x.converted) { x.links = null; continue; }
        const { doc, left, used } = resolveNoteLinks(x.converted.doc, decide);
        x.converted = { ...x.converted, doc };
        x.links = { left, used };
      }
    },
    /** A note of this run settled. Its links count only if its formatted body was written (created or updated). */
    settled(x, outcome, who) {
      const guid = String(x.note.id).toLowerCase();
      landed.set(guid, outcome === 'not_imported' ? null : (x.koskoId ?? null));
      delete store[guid];
      if ((outcome === 'created' || outcome === 'updated') && x.converted && x.links) {
        for (const l of x.links.left) list(guid, who, l, l.reason);
        for (const u of x.links.used) {
          const held = { ...u, note: guid, who };
          // `here`: the note was live in Kosko under that id when asked. `new`: it must land under it in this run.
          if (u.state === 'here') { counts.rewritten += 1; recordOf(guid).rewritten += 1; } else if (landed.has(u.target)) judge(held);
          else { pending.push(held); recordOf(guid).pending.push([u.target, u.id.toLowerCase()]); }
        }
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].target === guid) { judge(pending[i]); pending.splice(i, 1); }
      }
    },
    /**
     * { counts, receipt: { rows, total, linked } }. Called when every note of the run has settled: a link still
     * waiting for its target (one that never settled in this run) is listed `target_not_written` (review T7).
     */
    report() {
      for (const u of pending.splice(0)) judge(u);
      const named = rows.filter((r) => r.who);
      return { counts: { ...counts }, receipt: { rows: named.slice(0, RECEIPT_LINKS).map((r) => ({ note: r.who.title, notebook: r.who.notebook, text: r.text, reason: 'target_unavailable' })),
        total: counts.left, linked: counts.rewritten } };
    },
    /**
     * The left links by GUID, beside the plan (0600): what the receipt cannot name exactly. Best effort (review T5):
     * false, and one counts-only line, when it cannot be written. A link the stopped run left is counted in `more`
     * (the checkpoint keeps its reason's count, not its target).
     */
    write(planPath, log = () => {}) {
      const file = join(dirname(planPath), LINKS_NAME);
      const known = rows.filter((r) => r.target);
      const left = known.slice(0, FILE_ROWS).map((r) => ({ note: r.note, target: r.target, reason: r.reason }));
      return writeLocalFile(file, { format: 'kosko-evernote-links', version: 1, left, more: rows.length - left.length }, log, 'links kept as Evernote links');
    }
  };
}
