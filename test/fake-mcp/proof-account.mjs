// 515 — the account and the fake MCP server's contents for Kosko's end-to-end proof of `send --evernote` (Kosko doc 515,
// scripts/desktop-assist/mcp-proof.mjs). The synthetic account (synthetic-db.mjs) plus five notes that carry what the
// formatted route has to get right, each with a plain-text row so the W2 route imports it first:
//
//   Table note      a table with a header row and bold text
//   Checklist note  a checklist (one done, one not) — the proof edits this one in Kosko between run 1 and run 2
//   Pictures note   two pictures in the cache, placed by <en-media> between paragraphs
//   Links note      an evernote:///view link to each kind of target: a note of the plan (rewritten to /?note=<id>), a
//                   note in Evernote's trash, and a note of no plan (another account's); both left as they were
//   Fetched file    a file missing from this computer's cache that the fake serves by get_attachment (a real MD5)
//
// The base account's Active note keeps its own missing file (lost.pdf, an invented hash): the fake does not hold it,
// so it stays a placeholder and is counted "still missing". The Odd id note is not a GUID, so Evernote never lists it.
// Every title, word and file is invented. Nothing here is used by `npm test` except proof-account.test.mjs.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSyntheticAccount, ID, HASH } from '../fixtures/synthetic-db.mjs';
import { BODIES, HEADER } from '../fixtures/evernote-setup.mjs';

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const md5 = (b) => createHash('md5').update(b).digest('hex');
const png = (seed, size) => { const b = Buffer.alloc(size, seed); Buffer.from([137, 80, 78, 71]).copy(b); return b; };

export const PROOF_ID = { nTable: guid(311), nChecklist: guid(312), nPictures: guid(313), nLinks: guid(314), nFetched: guid(315),
  aPic1: guid(421), aPic2: guid(422), aFetched: guid(423) };
/** A note of no plan: another account's, as an evernote:/// link names it. */
export const OTHER_ACCOUNT_NOTE = 'abcdef00-1111-4222-8333-444444444444';
export const PIC1 = png(11, 12);
export const PIC2 = png(12, 14);
/** In Evernote, not in this computer's cache: get_attachment serves it. */
export const FETCHED = png(13, 16);
export const PROOF_HASH = { pic1: md5(PIC1), pic2: md5(PIC2), fetched: md5(FETCHED) };

const href = (g) => `evernote:///view/1001/s1/${g}/${g}/`;
const T0 = Date.UTC(2014, 2, 4, 10, 30, 15);

export const PROOF_BODIES = {
  ...BODIES,
  [PROOF_ID.nTable]: `${HEADER}<en-note><div>Quarterly figures</div><table><tr><th>Item</th><th>Count</th></tr>`
    + '<tr><td><b>Pens</b></td><td>12</td></tr><tr><td>Paper</td><td>300</td></tr></table><div>end of table</div></en-note>',
  [PROOF_ID.nChecklist]: `${HEADER}<en-note><div><en-todo checked="true"/>Buy milk</div><div><en-todo checked="false"/>Call the bank</div></en-note>`,
  [PROOF_ID.nPictures]: `${HEADER}<en-note><div>before the first</div><en-media hash="${PROOF_HASH.pic1}" type="image/png"/>`
    + `<div>between them</div><en-media hash="${PROOF_HASH.pic2}" type="image/png"/><div>after the second</div></en-note>`,
  [PROOF_ID.nLinks]: `${HEADER}<en-note><div>See <a href="${href(PROOF_ID.nTable)}">the table note</a>.</div>`
    + `<div>Old: <a href="${href(ID.nTrashed)}">a trashed note</a>.</div>`
    + `<div>Shared: <a href="${href(OTHER_ACCOUNT_NOTE)}">a friend's note</a>.</div></en-note>`,
  [PROOF_ID.nFetched]: `${HEADER}<en-note><div>The scan:</div><en-media hash="${PROOF_HASH.fetched}" type="image/png"/><div>kept</div></en-note>`
};

const NOTE_DEFAULTS = { isMetadata: 0, isUntitled: 0, isExternal: 0, content_localChangeTimestamp: 0, content_hash: 'h', content_size: 0,
  internal_shareCountProfiles: '{}', internal_maxResourceVersion: 0, internal_resourcesChanged: 0, internal_contentChanged: 0,
  internal_activeResourceCount: 0, localChangeTimestamp: 0, version: 1 };
const insert = (db, table, row) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
};

/** What the proof expects of a fresh account (the plan's own counts are read from kosko-plan.json; these are the rest). */
export const PROOF_EXPECTED = Object.freeze({
  notes: 9, // the base account's 4 active notes + 5
  listed: 8, // every planned note but the Odd id one
  formattedNotes: [ID.nActive, ID.nEmptyText, ID.nSpace, PROOF_ID.nTable, PROOF_ID.nChecklist, PROOF_ID.nPictures, PROOF_ID.nLinks, PROOF_ID.nFetched],
  missingFromCache: 2, // lost.pdf (Evernote has no such file) and the Fetched file's scan (Evernote serves it)
  fetched: 1,
  stillMissing: 1,
  links: { rewritten: 1, left: 2, notInPlan: 2 }
});

/** The synthetic account plus the five proof notes, on disk; `mutate(db)` runs last (Kosko 519's extras). */
export function buildProofAccount({ root, mutate } = {}) {
  const notes = [
    [PROOF_ID.nTable, 'Table note', 'Quarterly figures\nItem Count\nPens 12\nPaper 300\nend of table'],
    [PROOF_ID.nChecklist, 'Checklist note', 'Buy milk\nCall the bank'],
    [PROOF_ID.nPictures, 'Pictures note', 'before the first\nbetween them\nafter the second'],
    [PROOF_ID.nLinks, 'Links note', 'See the table note.\nOld: a trashed note.\nShared: a friend\'s note.'],
    [PROOF_ID.nFetched, 'Fetched file', 'The scan:\nkept']
  ];
  const acct = buildSyntheticAccount({ root, mutate: (db) => {
    notes.forEach(([id, label, text], i) => {
      insert(db, 'Nodes_Note', { ...NOTE_DEFAULTS, id, label, created: T0 + (10 + i) * 60_000, updated: T0 + (10 + i) * 60_000 + 1000,
        parent_Notebook_id: ID.nbLoose });
      insert(db, 'Offline_Search_Note_Content', { id, content: text });
    });
    const att = (id, noteId, bytes, filename, local) => insert(db, 'Attachment', { id, filename, mime: 'image/png', width: 1, height: 1,
      isActive: 1, dataHash: md5(bytes), dataSize: bytes.length, applicationDataKeys: '[]', owner: 1, shardId: 's1', version: 1,
      parent_Note_id: noteId, isDownloadedLocally: local ? 1 : 0 });
    att(PROOF_ID.aPic1, PROOF_ID.nPictures, PIC1, 'first.png', true);
    att(PROOF_ID.aPic2, PROOF_ID.nPictures, PIC2, 'second.png', true);
    att(PROOF_ID.aFetched, PROOF_ID.nFetched, FETCHED, 'scan.png', false);
    if (mutate) mutate(db);
  } });
  for (const [bytes] of [[PIC1], [PIC2]]) {
    const dir = join(acct.resourceCacheDir, PROOF_ID.nPictures);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, md5(bytes)), bytes);
    writeFileSync(join(dir, `${md5(bytes)}.meta`), '{}');
  }
  return acct;
}

/**
 * The fake MCP server's options for this account: every note Evernote would list, with its ENML and resources, and
 * the one file Evernote holds that the cache does not. Pass to createFakeMcp({ ...proofMcpOptions(), freePlan, ... }).
 */
export function proofMcpOptions() {
  const res = (hash, name, size, mime = 'image/png') => ({ hash, mime, name, sizeBytes: size });
  const resources = {
    [ID.nActive]: [res(HASH.present, 'receipt.png', 5)], // lost.pdf: Evernote has no such file either
    [ID.nSpace]: [res(HASH.telugu, 'telugu.png', 6), res(HASH.largeScan, 'page.png', 8), res(HASH.noWords, 'photo.png', 10)],
    [PROOF_ID.nPictures]: [res(PROOF_HASH.pic1, 'first.png', PIC1.length), res(PROOF_HASH.pic2, 'second.png', PIC2.length)],
    [PROOF_ID.nFetched]: [res(PROOF_HASH.fetched, 'scan.png', FETCHED.length)]
  };
  const notes = PROOF_EXPECTED.formattedNotes.map((g, i) => ({ guid: g, title: `T${i}`, enml: PROOF_BODIES[g], created: T0 + i * 1000,
    updated: T0 + i * 1000 + 500, resources: resources[g] ?? [] }));
  return { notes, files: new Map([[PROOF_HASH.fetched, new Uint8Array(FETCHED)]]) };
}
