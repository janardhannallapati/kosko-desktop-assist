// The ENEX match probe (Kosko doc 462, R1): does every note in a real Evernote export find exactly ONE note in the
// local database by fp1?
//
// Why it matters: an export carries no note id, so Kosko keys every imported note on fp1, a hash of its <created>
// string (@kosko-app/enex-core). The desktop tool writes its notes under the same key, computed from the local
// database's `created` written the way ENEX writes it. A later ENEX drop then finds the tool's note and upgrades it
// instead of importing a duplicate. This probe measures how often that works on a real account, before any wave
// writes a ledger row on the assumption that it does.
//
// Both sides go through the package: readEnex reads the export, formatEnexDate writes the local time, and
// fingerprintNote hashes both. Nothing here re-implements any of them, so the probe measures the real path.
//
// Output is counts and titles only. No note text leaves this module: plain text is compared in memory to break
// ties between notes that share a creation second, and then dropped.
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readEnex, formatEnexDate, fingerprintNote } from '@kosko-app/enex-core/enex';

export const PASS_RATE = 0.99;
// A text tie-break must be clear, not just best: the winner needs this much overlap AND this lead over the runner-up.
export const TEXT_MIN = 0.5;
export const TEXT_LEAD = 0.2;

/** ENEX paths from a list of files and folders (a folder contributes its *.enex files, not recursively). */
export function enexFiles(paths) {
  const out = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) if (name.toLowerCase().endsWith('.enex')) out.push(join(p, name));
    } else out.push(p);
  }
  return out;
}

const words = (text) => new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Jaccard overlap of two texts' word sets; 0 when either is empty. */
export function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both);
}

// ENML to rough plain text, for the tie-break only: tags out, the five XML entities and numeric references decoded.
export function enmlText(enml) {
  return String(enml ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const sameTitle = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Decide one ENEX note against the local notes that share its fp1 identity.
 * @returns {{ outcome: 'single'|'title'|'text'|'unresolved'|'miss', localId?: string }}
 */
export function decide(enexNote, candidates) {
  if (!candidates.length) return { outcome: 'miss' };
  if (candidates.length === 1) return { outcome: 'single', localId: candidates[0].id };
  const byTitle = candidates.filter((c) => sameTitle(c.title, enexNote.title));
  if (byTitle.length === 1) return { outcome: 'title', localId: byTitle[0].id };
  const pool = byTitle.length ? byTitle : candidates;
  const scored = pool.map((c) => ({ c, s: overlap(c.plainText, enexNote.text) })).sort((x, y) => y.s - x.s);
  const [best, next] = scored;
  if (best.s >= TEXT_MIN && best.s - (next?.s ?? 0) >= TEXT_LEAD) return { outcome: 'text', localId: best.c.id };
  return { outcome: 'unresolved' };
}

/**
 * Match every note of the given exports against one opened local account.
 * @param {{ notes(): Iterable<{ id, title, created, plainText }> }} account  as openAccount returns it
 */
export async function matchExports(account, files, { read = readEnex, blobOf = openAsBlob } = {}) {
  const local = new Map(); // fp1 identity -> local notes created in that second
  let localNotes = 0;
  for (const n of account.notes()) {
    localNotes += 1;
    const { identity } = await fingerprintNote({ created: formatEnexDate(n.created) });
    if (!identity) continue;
    if (!local.has(identity)) local.set(identity, []);
    local.get(identity).push({ id: n.id, title: n.title, plainText: n.plainText });
  }

  const counts = { enexNotes: 0, single: 0, title: 0, text: 0, unresolved: 0, miss: 0, noCreated: 0, claimedTwice: 0 };
  const named = { unresolved: [], miss: [], noCreated: [], claimedTwice: [] };
  const claimedBy = new Map(); // local note id -> the first ENEX note that matched it
  const fileErrors = [];

  for (const path of files) {
    const file = basename(path);
    for await (const r of read(await blobOf(path))) {
      if (r.kind === 'end' && r.error) fileErrors.push({ file, error: r.error });
      if (r.kind !== 'note') continue;
      counts.enexNotes += 1;
      const where = { file, title: r.title ?? '(untitled)', created: r.created ?? null };
      const { identity } = await fingerprintNote({ created: r.created });
      if (!identity) { counts.noCreated += 1; named.noCreated.push(where); continue; }
      const { outcome, localId } = decide({ title: r.title, text: enmlText(r.content) }, local.get(identity) ?? []);
      counts[outcome] += 1;
      if (outcome === 'miss' || outcome === 'unresolved') { named[outcome].push(where); continue; }
      if (claimedBy.has(localId)) {
        counts.claimedTwice += 1;
        named.claimedTwice.push({ ...where, alsoClaimedBy: claimedBy.get(localId) });
      } else claimedBy.set(localId, where.title);
    }
  }

  const matched = counts.single + counts.title + counts.text - counts.claimedTwice;
  const rate = counts.enexNotes ? matched / counts.enexNotes : 0;
  return {
    format: 'kosko-match-report', version: 1,
    files: files.map((f) => basename(f)), localNotes, counts, matched, rate,
    pass: counts.enexNotes > 0 && rate >= PASS_RATE && fileErrors.length === 0,
    passBar: PASS_RATE, named, fileErrors
  };
}

// Titles and file names come from export files, which anyone can write. Printed raw, an ESC sequence in a title could
// rewrite the terminal (fake a PASS line, hide a miss). C0/C1 controls and DEL become U+FFFD; the JSON report keeps
// the original text, because JSON escapes controls itself.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
export const printable = (text) => String(text ?? '').replace(CONTROLS, '\uFFFD');

/** The one-screen summary: counts, the rate against the bar, and every note that did not match, by title. */
export function renderMatch(report) {
  const c = report.counts;
  const pct = (n) => `${((n / Math.max(c.enexNotes, 1)) * 100).toFixed(1)}%`;
  const lines = [
    `ENEX match probe — ${report.files.length} export file(s), ${c.enexNotes} notes, against ${report.localNotes} local notes`,
    `  matched exactly one local note   ${report.matched} (${pct(report.matched)})   pass bar ${report.passBar * 100}%: ${report.pass ? 'PASS' : 'FAIL'}`,
    `    unique creation second         ${c.single}`,
    `    shared second, told by title   ${c.title}`,
    `    shared second, told by text    ${c.text}`,
    `  shared second, not told apart    ${c.unresolved}`,
    `  no local note at that second     ${c.miss}`,
    `  no <created> in the export       ${c.noCreated}`,
    `  local note claimed twice         ${c.claimedTwice}`
  ];
  for (const [label, list] of [['Not told apart', report.named.unresolved], ['Missed', report.named.miss],
    ['No <created>', report.named.noCreated], ['Claimed twice', report.named.claimedTwice]]) {
    if (!list.length) continue;
    lines.push('', `${label}:`);
    for (const n of list) lines.push(`  ${printable(n.file)}: ${printable(n.title)}${n.created ? `  (${printable(n.created)})` : ''}`);
  }
  for (const e of report.fileErrors) lines.push('', `Could not read all of ${printable(e.file)}: ${printable(e.error)}`);
  lines.push('', 'Only counts and titles are shown or written. Nothing was sent anywhere.');
  return lines.join('\n');
}
