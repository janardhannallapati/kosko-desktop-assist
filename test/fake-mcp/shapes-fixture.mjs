// Kosko 537 — the account and fake MCP server the shape check is proved on, and the ONE recording the committed
// baseline (src/mcp/shapes-baseline.json) is made from. scripts/shapes-baseline.mjs writes it and
// shapes-baseline.test.mjs fails when it is stale, so the baseline is always what this fake answers (rule 3).
//
// It is 515's proof account (proof-account.mjs) on the fake W4 was proved on, with two changes:
// - the Odd id note is removed, so Evernote lists every planned note and coverage can be green (a test keeps it);
// - each note offers only the resources the fake can serve with real bytes (515's other hashes are invented, so a
//   download of them could never hash right). Every result shape is still the fake's own.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ID } from '../fixtures/synthetic-db.mjs';
import { clock } from '../fixtures/evernote-setup.mjs';
import { runDryRun } from '../../src/plan/dry-run.mjs';
import { loadPlan } from '../../src/send/library/plan-file.mjs';
import { recordShapes, baselineOf } from '../../src/mcp/shapes.mjs';
import { buildProofAccount, proofMcpOptions, PIC1, PIC2, FETCHED, PROOF_HASH } from './proof-account.mjs';
import { createFakeMcp, autoAuthorize } from './server.mjs';

export const SERVED = Object.freeze({ [PROOF_HASH.pic1]: PIC1, [PROOF_HASH.pic2]: PIC2, [PROOF_HASH.fetched]: FETCHED });
export const servedFiles = (over = {}) => new Map(Object.entries({ ...SERVED, ...over }).map(([h, b]) => [h, new Uint8Array(b)]));

const dropOddNote = (db) => {
  for (const [table, col] of [['Attachment', 'parent_Note_id'], ['Offline_Search_Note_Content', 'id'], ['Nodes_Note', 'id']]) {
    db.prepare(`DELETE FROM "${table}" WHERE "${col}" = ?`).run(ID.nBadId);
  }
};

/** A dry-run plan of the proof account and a fake MCP server listing it. `mcp` options are passed to the fake last. */
export async function shapesSetup({ mcp = {}, keepOddNote = false, titles = [] } = {}) {
  const acct = buildProofAccount({ mutate: keepOddNote ? undefined : dropOddNote });
  const planDir = mkdtempSync(join(tmpdir(), 'kda-shapes-plan-'));
  await runDryRun({ dataDir: acct.dataDir, outDir: planDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const notes = proofMcpOptions().notes.map((n, i) => ({ ...n, title: titles[i] ?? n.title, resources: n.resources.filter((r) => SERVED[r.hash]) }));
  const time = clock();
  const fake = createFakeMcp({ now: time.now, notes, files: servedFiles(), ...mcp });
  return { acct, planPath: join(planDir, 'kosko-plan.json'), fake, time, signIns: { count: 0 } };
}

/** The evernote options recordShapes/runShapes take, pointed at this fake (in memory unless fetchImpl says otherwise). */
export const evernoteOpts = (s, fetchImpl = s.fake.fetch) => ({ origin: s.fake.origin, fetchImpl, authorize: autoAuthorize(fetchImpl, s.signIns),
  sleep: s.time.sleep, now: s.time.now, signedUrlOk: s.fake.signedUrlOk });

/** The baseline as this fake answers it today: what scripts/shapes-baseline.mjs writes. */
export async function baselineFromFake({ mcp } = {}) {
  const s = await shapesSetup({ mcp });
  return baselineOf(await recordShapes({ plan: loadPlan(s.planPath), evernote: evernoteOpts(s) }));
}
