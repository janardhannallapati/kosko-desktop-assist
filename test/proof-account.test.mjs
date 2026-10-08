// 515 — the proof account (test/fake-mcp/proof-account.mjs) does what Kosko's real-HTTP proof expects of it, against the
// in-memory Kosko and the fake MCP server: the same demo steps, so a fixture drift fails here first, in seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDryRun } from '../src/plan/dry-run.mjs';
import { runSend } from '../src/send/library/run-send.mjs';
import { FREE_PLAN_SENTENCE } from '../src/send/library/evernote-route.mjs';
import { createFakeKosko } from './fixtures/fake-kosko.mjs';
import { createFakeMcp, autoAuthorize } from './fake-mcp/server.mjs';
import { TOKEN, APP, clock, types } from './fixtures/evernote-setup.mjs';
import { buildProofAccount, proofMcpOptions, PROOF_ID, PROOF_EXPECTED, PROOF_HASH } from './fake-mcp/proof-account.mjs';

async function proofSetup(mcpExtra = {}) {
  const acct = buildProofAccount();
  const outDir = mkdtempSync(join(tmpdir(), 'kda-proof-'));
  await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const kosko = createFakeKosko();
  kosko.token = TOKEN;
  const time = clock();
  const mcp = createFakeMcp({ now: time.now, ...proofMcpOptions(), ...mcpExtra });
  return { acct, planPath: join(outDir, 'kosko-plan.json'), kosko, mcp, time };
}
async function send(s, evernote) {
  const lines = [];
  const r = await runSend({ planPath: s.planPath, app: APP, token: TOKEN, dataDir: s.acct.dataDir, fetch: s.kosko.fetch,
    tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: (l) => lines.push(l), sleep: async () => {}, random: () => 0,
    evernote: evernote ? { origin: s.mcp.origin, fetch: s.mcp.fetch, authorize: autoAuthorize(s.mcp.fetch), sleep: s.time.sleep, now: s.time.now,
      signedUrlOk: s.mcp.signedUrlOk } : null });
  return { ...r, out: lines.join('\n'), job: r.jobId && s.kosko.job(r.jobId) };
}
const byGuid = (s, g) => [...s.kosko.state.notes.values()].find((n) => n.external_id === g);

test('the proof account: plain run, a Kosko edit, the formatted run, a no-op third run', async () => {
  const s = await proofSetup();
  const r1 = await send(s, false);
  assert.equal(r1.exitCode, 0, r1.out);
  assert.deepEqual(r1.job.summary.notes, { created: PROOF_EXPECTED.notes, updated: 0, skipped: 0, not_imported: 0 });
  assert.equal(r1.job.receipt.desktop.missingFiles, PROOF_EXPECTED.missingFromCache);
  const edited = byGuid(s, PROOF_ID.nChecklist);
  s.kosko.editNote(edited.id, { title: 'Checklist note (edited in Kosko)' });

  const r2 = await send(s, true);
  assert.equal(r2.exitCode, 0, r2.out);
  assert.deepEqual(r2.job.summary.notes, { created: 0, updated: PROOF_EXPECTED.listed - 1, skipped: 2, not_imported: 0 });
  assert.deepEqual(r2.job.summary.skip_reasons, { edited_in_kosko: 1 });
  assert.deepEqual(r2.job.summary.evernoteFiles, { fetched: PROOF_EXPECTED.fetched, stillMissing: PROOF_EXPECTED.stillMissing, downloaded: 1, unreachable: 0 });
  assert.deepEqual({ rewritten: r2.job.summary.links.rewritten, left: r2.job.summary.links.left, notInPlan: r2.job.summary.links.notInPlan },
    PROOF_EXPECTED.links);
  assert.ok(types(byGuid(s, PROOF_ID.nTable).content).includes('table'));
  assert.ok(types(byGuid(s, PROOF_ID.nChecklist).content).includes('taskItem') === false, 'the edited note keeps its Kosko body');
  assert.ok(JSON.stringify(byGuid(s, PROOF_ID.nFetched).content).includes(`${PROOF_HASH.fetched}.png`), 'the fetched file is stored in the note');

  const versions = s.kosko.state.versions.length;
  const r3 = await send(s, true);
  assert.equal(r3.exitCode, 0, r3.out);
  assert.deepEqual(r3.job.summary.notes, { created: 0, updated: 0, skipped: PROOF_EXPECTED.notes, not_imported: 0 });
  assert.deepEqual(r3.job.summary.skip_reasons, { edited_in_kosko: 1 }, 'the Kosko edit is still kept and named');
  assert.equal(s.kosko.state.versions.length, versions);
});

test('the proof account on a free plan: one sentence, plain text, exit 0', async () => {
  for (const freePlan of ['http403', 'rpc', 'tool']) {
    const s = await proofSetup({ freePlan });
    const r = await send(s, true);
    assert.equal(r.exitCode, 0, r.out);
    assert.equal(r.out.split('\n').filter((l) => l === FREE_PLAN_SENTENCE).length, 1, freePlan);
    assert.deepEqual(r.job.summary.notes, { created: PROOF_EXPECTED.notes, updated: 0, skipped: 0, not_imported: 0 });
  }
});
