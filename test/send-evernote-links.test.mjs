// 514 — links between notes on the --evernote route. An evernote:///view link whose GUID names a note of the plan is
// rewritten to that note's Kosko deep link (`/?note=<id>`, Kosko 424), keeping the Evernote address in the link's
// `evernoteHref` (enex-core's EvernoteLinkOrigin), exactly as Kosko's resolveLinks writes it. Any other is left as it was
// and listed. Exact identity by GUID, through the plan's fp1 and note-ids — never by title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID } from './fixtures/synthetic-db.mjs';
import { setup, send, byGuid, BODIES } from './fixtures/evernote-setup.mjs';
import { LINKS_NAME, createLinkLedger, withLeftLinks } from '../src/send/library/note-links.mjs';
import { checkpointPath } from '../src/send/checkpoint.mjs';
import { createTally } from '../src/send/library/tally.mjs';

const OTHER = 'abcdef00-1111-4222-8333-444444444444'; // a note of another account, or one never planned
const href = (g, h = g) => `evernote:///view/1001/s1/${g}/${h}/`;
const LINKS = `<div><a href="${href(ID.nEmptyText)}">to <b>empty</b></a> and <a href="${href(ID.nSpace)}">to space</a></div>`
  + `<div><a href="${href(OTHER)}">Empty text</a> <a href="${href(ID.nTrashed)}">gone</a></div>`
  + `<div><a href="${href(ID.nSpace, OTHER)}">two ids</a> <a href="https://www.evernote.com/shard/s1/sh/x/y">web</a></div>`;

async function linkSetup(opts) {
  const s = await setup(opts);
  s.mcp.state.notes.get(ID.nActive).enml = BODIES[ID.nActive].replace('<en-note>', `<en-note>${LINKS}`);
  return s;
}

/** Every link run in a doc: { text, href, evernoteHref }, adjacent text nodes with one href joined (as 424 reads them). */
function links(doc) {
  const out = [];
  (function w(n) {
    const kids = n.content ?? [];
    for (let i = 0; i < kids.length; i++) {
      const m = kids[i].marks?.find((k) => k.type === 'link');
      const prev = out.at(-1);
      if (m && prev && prev.node === n && prev.i === i - 1 && prev.href === m.attrs.href) { prev.text += kids[i].text; prev.i = i; prev.marks.push(m); continue; }
      if (m) out.push({ node: n, i, text: kids[i].text, href: m.attrs.href, evernoteHref: m.attrs.evernoteHref ?? null, marks: [m] });
    }
    kids.forEach(w);
  })(doc);
  return out.map(({ text, href: h, evernoteHref, marks }) => ({ text, href: h, evernoteHref, marks }));
}
const byText = (doc, text) => links(doc).find((l) => l.text === text);

test('a first --evernote run: links to planned notes open them in Kosko, whatever batch the target is written in', async () => {
  const s = await linkSetup();
  const r = await send(s, { batchNotes: 1 }); // the linking note goes first; its targets are written in later batches
  assert.equal(r.exitCode, 0, r.out);
  const doc = byGuid(s, ID.nActive).content;
  for (const [text, target] of [['to empty', ID.nEmptyText], ['to space', ID.nSpace]]) {
    const l = byText(doc, text);
    assert.equal(l.href, `/?note=${byGuid(s, target).id}`, `${text}: the id the target was written under`);
    assert.equal(l.evernoteHref, href(target), `${text}: the Evernote address kept`);
    for (const m of l.marks) assert.deepEqual(Object.keys(m.attrs).sort(), ['class', 'evernoteHref', 'href', 'rel', 'target', 'title']);
  }
  assert.equal(byText(doc, 'to empty').marks.length, 2, 'a bold word inside the link is the same link, rewritten too');
  // Not planned (another account's note; a note in Evernote's trash): left exactly as it was. A title is never matched.
  assert.deepEqual([byText(doc, 'Empty text').href, byText(doc, 'Empty text').evernoteHref], [href(OTHER), null]);
  assert.deepEqual([byText(doc, 'gone').href, byText(doc, 'gone').evernoteHref], [href(ID.nTrashed), null]);
  // Not a note link at all: untouched and not listed.
  assert.equal(byText(doc, 'two ids').href, href(ID.nSpace, OTHER));
  assert.match(byText(doc, 'web').href, /^https:/);

  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.links, { rewritten: 2, left: 2, notInPlan: 2, inKoskoTrash: 0, deletedInKosko: 0, clash: 0, noStableId: 0, targetNotWritten: 0 });
  assert.equal(job.receipt.cannotCarry.linked, 2);
  assert.equal(job.receipt.cannotCarry.links, 2);
  assert.deepEqual(job.receipt.links, [
    { note: 'Active note', notebook: 'Receipts', text: 'Empty text', reason: 'target_unavailable' },
    { note: 'Active note', notebook: 'Receipts', text: 'gone', reason: 'target_unavailable' }]);
  assert.equal(job.receipt.linksMore, 0);
  const file = JSON.parse(readFileSync(join(s.planPath, '..', LINKS_NAME), 'utf8'));
  assert.deepEqual(file.left, [{ note: ID.nActive, target: OTHER, reason: 'not_in_plan' }, { note: ID.nActive, target: ID.nTrashed, reason: 'not_in_plan' }]);
  assert.match(r.out, /Links between notes: 2 now open in Kosko, 2 kept as Evernote links\./);
  for (const g of [OTHER, ID.nTrashed, ID.nEmptyText]) assert.ok(!r.out.includes(g), 'no GUID on the console');
  assert.ok(!r.out.includes('Empty text') && !r.out.includes('to empty'), 'no link text on the console');
});

test('run 2 upgrades in place: links point at the notes Kosko holds; run 3 changes nothing (the ids are stable)', async () => {
  const s = await linkSetup();
  await send(s, { evernote: false });
  const r2 = await send(s);
  assert.equal(r2.exitCode, 0, r2.out);
  const doc = byGuid(s, ID.nActive).content;
  assert.equal(byText(doc, 'to empty').href, `/?note=${byGuid(s, ID.nEmptyText).id}`);
  assert.equal(byText(doc, 'to space').href, `/?note=${byGuid(s, ID.nSpace).id}`);
  assert.equal(s.kosko.job(r2.jobId).summary.links.rewritten, 2);
  const versions = s.kosko.state.versions.length;
  const r3 = await send(s);
  assert.deepEqual(s.kosko.job(r3.jobId).summary.notes, { created: 0, updated: 0, skipped: 4, not_imported: 0 });
  assert.equal(s.kosko.state.versions.length, versions);
  // Run 3 wrote no note, so it rewrote no link (424: links are counted for the notes a run writes).
  assert.equal(s.kosko.job(r3.jobId).summary.links.rewritten, 0);
});

test('a target in Kosko\'s trash, or deleted there, is not linked: the link stays and is listed with why', async () => {
  const s = await linkSetup();
  await send(s, { evernote: false });
  s.kosko.state.trashed.add(byGuid(s, ID.nEmptyText).id);
  s.kosko.state.notes.delete(byGuid(s, ID.nSpace).id);
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const doc = byGuid(s, ID.nActive).content;
  assert.equal(byText(doc, 'to empty').href, href(ID.nEmptyText));
  assert.equal(byText(doc, 'to space').href, href(ID.nSpace));
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.links, { rewritten: 0, left: 4, notInPlan: 2, inKoskoTrash: 1, deletedInKosko: 1, clash: 0, noStableId: 0, targetNotWritten: 0 });
  const file = JSON.parse(readFileSync(join(s.planPath, '..', LINKS_NAME), 'utf8'));
  assert.ok(file.left.some((l) => l.target === ID.nEmptyText && l.reason === 'in_kosko_trash'));
  assert.ok(file.left.some((l) => l.target === ID.nSpace && l.reason === 'deleted_in_kosko'));
});

test('a rewritten link whose target is then not written is listed, not counted as linked (424\'s landed rule)', async () => {
  const s = await linkSetup();
  s.kosko.state.noteErrors.set(ID.nEmptyText, ['quota_exceeded']);
  const r = await send(s, { batchNotes: 1 });
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.equal(job.summary.notes.not_imported, 1);
  assert.deepEqual(job.summary.links, { rewritten: 1, left: 3, notInPlan: 2, inKoskoTrash: 0, deletedInKosko: 0, clash: 0, noStableId: 0, targetNotWritten: 1 });
  assert.equal(job.receipt.cannotCarry.linked, 1);
  assert.ok(job.receipt.links.some((l) => l.text === 'to empty' && l.reason === 'target_unavailable'));
});

test('a note whose formatted body was not written (kept for a Kosko edit) counts none of its links', async () => {
  const s = await linkSetup();
  await send(s, { evernote: false });
  const active = byGuid(s, ID.nActive);
  s.kosko.editNote(active.id, { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mine' }] }] } });
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.deepEqual(s.kosko.job(r.jobId).summary.links, { rewritten: 0, left: 0, notInPlan: 0, inKoskoTrash: 0, deletedInKosko: 0, clash: 0, noStableId: 0, targetNotWritten: 0 });
});

test('a formatted body Kosko refuses is sent again as plain text: it carries no links, so none are counted', async () => {
  const s = await linkSetup();
  s.kosko.state.noteErrors.set(ID.nActive, ['invalid']);
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.koskoRefused, 1);
  assert.deepEqual(s.kosko.job(r.jobId).summary.links, { rewritten: 0, left: 0, notInPlan: 0, inKoskoTrash: 0, deletedInKosko: 0, clash: 0, noStableId: 0, targetNotWritten: 0 });
});

test('a link to a note Kosko already holds counts as linked even when that note\'s own upgrade fails in this run', async () => {
  const s = await linkSetup();
  await send(s, { evernote: false });
  s.kosko.state.noteErrors.set(ID.nEmptyText, ['quota_exceeded']); // the target is live in Kosko; its upgrade is refused
  const r = await send(s, { batchNotes: 1 });
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.equal(job.summary.notes.not_imported, 1);
  assert.equal(byText(byGuid(s, ID.nActive).content, 'to empty').href, `/?note=${byGuid(s, ID.nEmptyText).id}`);
  assert.deepEqual(job.summary.links, { rewritten: 2, left: 2, notInPlan: 2, inKoskoTrash: 0, deletedInKosko: 0, clash: 0, noStableId: 0, targetNotWritten: 0 });
});

test('review T6: a stopped run\'s link counts survive the resume (checkpoint v3 `links`), as if it had never stopped', async () => {
  const s = await linkSetup();
  const ac = new AbortController();
  const real = s.kosko.fetch;
  let batches = 0;
  const stopping = async (url, init) => { const res = await real(url, init); if (String(url).endsWith('/api/import/notes/batch') && ++batches === 1) ac.abort(); return res; };
  const first = await send(s, { batchNotes: 1, fetch: stopping, signal: ac.signal }); // the linking note's batch, then Ctrl-C
  assert.equal(first.exitCode, 130, first.out);
  const rec = JSON.parse(readFileSync(checkpointPath(s.planPath), 'utf8')).links[ID.nActive];
  assert.deepEqual([rec.rewritten, rec.left, rec.pending.map(([t]) => t).sort()], [0, { not_in_plan: 2 }, [ID.nEmptyText, ID.nSpace].sort()]);
  const second = await send(s, { batchNotes: 1 });
  assert.equal(second.exitCode, 0, second.out);
  assert.equal(second.jobId, first.jobId);
  const job = s.kosko.job(second.jobId);
  assert.deepEqual(job.summary.links, { rewritten: 2, left: 2, notInPlan: 2, inKoskoTrash: 0, deletedInKosko: 0, clash: 0, noStableId: 0, targetNotWritten: 0 });
  assert.deepEqual([job.receipt.cannotCarry.linked, job.receipt.cannotCarry.links], [2, 2]);
  // The stopped run's left links are counted; their text is not in the checkpoint, so they are in linksMore.
  assert.equal(job.receipt.links.length + job.receipt.linksMore, 2);
  assert.match(second.out, /Links between notes: 2 now open in Kosko, 2 kept as Evernote links\./);
});

test('review T7: a link to a `new` note that never settles in the run is listed target_not_written, never dropped', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const idB = '11111111-2222-4333-8444-555555555555';
  const ledger = createLinkLedger({ plan: { notes: [{ id: A }, { id: B }] }, fps: ['fp1:a', 'fp1:b'] });
  ledger.settled({ note: { id: A }, koskoId: '11111111-2222-4333-8444-000000000000', converted: { doc: {} },
    links: { left: [], used: [{ target: B, id: idB, state: 'new', text: 'to b' }] } }, 'created', { title: 'A', notebook: 'N' });
  const { counts, receipt } = ledger.report();
  assert.deepEqual([counts.rewritten, counts.left, counts.targetNotWritten], [0, 1, 1]);
  assert.deepEqual(receipt.rows, [{ note: 'A', notebook: 'N', text: 'to b', reason: 'target_unavailable' }]);
});

test('review T9: the links a note leaves are in its version — once one can be resolved, the note is sent again and the link opens', async () => {
  const s = await linkSetup();
  await send(s, { evernote: false });
  const empty = byGuid(s, ID.nEmptyText);
  s.kosko.state.trashed.add(empty.id);
  await send(s); // run 2: "to empty" is left (in_kosko_trash)
  assert.equal(byText(byGuid(s, ID.nActive).content, 'to empty').href, href(ID.nEmptyText));
  s.kosko.state.trashed.delete(empty.id); // taken out of Kosko's trash
  const updates = s.kosko.state.updates.length;
  const r3 = await send(s);
  assert.equal(r3.exitCode, 0, r3.out);
  assert.ok(s.kosko.state.updates.slice(updates).includes(byGuid(s, ID.nActive).id), 'the linking note is sent again and updated');
  assert.equal(byText(byGuid(s, ID.nActive).content, 'to empty').href, `/?note=${empty.id}`);
  assert.equal(s.kosko.job(r3.jobId).summary.links.inKoskoTrash, 0);
  // The version is exactly the formatted one again when nothing is left but what can never resolve.
  const r4 = await send(s);
  assert.equal(s.kosko.job(r4.jobId).summary.notes.updated, 0, 'run 4 changes nothing');
  assert.equal(withLeftLinks('v', []), 'v');
  assert.equal(withLeftLinks('v', ['B', 'a', 'b']), withLeftLinks('v', ['a', 'b']), 'sorted, distinct, case-folded');
  assert.match(withLeftLinks('v', ['a']), /^[0-9a-f]{64}$/);
});

test('review T13: more than Kosko\'s 500 receipt links: 500 rows, the rest in linksMore', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const ledger = createLinkLedger({ plan: { notes: [{ id: A }] }, fps: ['fp1:a'] });
  const left = Array.from({ length: 600 }, (_, i) => ({ target: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, text: `l${i}`, reason: 'not_in_plan' }));
  ledger.settled({ note: { id: A }, koskoId: '11111111-2222-4333-8444-000000000000', converted: { doc: {} }, links: { left, used: [] } }, 'created', { title: 'A', notebook: 'N' });
  const { receipt } = createTally().build({ expected: {}, structure: { notebooks: 0, stacks: 0, spaceNotebooks: 0, tags: 0, tagsDropped: 0 },
    trashedNotes: 0, ocr: null, links: ledger.report().receipt });
  assert.equal(receipt.links.length, 500);
  assert.equal(receipt.linksMore, 100);
  assert.equal(receipt.cannotCarry.links, 600);
});
