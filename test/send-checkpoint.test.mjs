// 466 rule 9: the checkpoint beside the plan can be lost, never wrong — atomic, 0600, bound to its plan and its app,
// closed keys, and it never holds the token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFingerprint, checkpointPath, emptyCheckpoint, loadCheckpoint, saveCheckpoint, CHECKPOINT_NAME } from '../src/send/checkpoint.mjs';

const JOB = '11111111-2222-4333-8444-555555555555';
const NB = '99999999-2222-4333-8444-555555555555';
const GUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const APP = 'https://kosko.app';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kda-cp-'));
  const plan = join(dir, 'kosko-plan.json');
  writeFileSync(plan, '{"format":"kosko-plan","version":1}');
  return { dir, plan };
}
const full = (fp) => ({ ...emptyCheckpoint({ plan: fp, app: APP, jobId: JOB }),
  notebooks: { 'nb-1': NB, 'stack:Work': NB }, tags: { done: true }, notes: { [GUID]: 'created' }, attachments: { 'att-1': true } });

test('the checkpoint sits beside the plan', () => {
  assert.equal(checkpointPath('/x/y/kosko-plan.json'), join('/x/y', CHECKPOINT_NAME));
});

test('the plan fingerprint is its sha-256 and size', async () => {
  const { plan } = setup();
  const fp = await planFingerprint(plan);
  assert.equal(fp.bytes, 35);
  assert.match(fp.sha256, /^[0-9a-f]{64}$/);
});

test('save then load round-trips, mode 0600, no partial file left', async () => {
  const { dir, plan } = setup();
  const fp = await planFingerprint(plan);
  saveCheckpoint(plan, full(fp));
  const { checkpoint, reason } = loadCheckpoint(plan, { plan: fp, app: APP });
  assert.equal(reason, null);
  assert.deepEqual({ ...checkpoint, updatedAt: 'x' }, { ...full(fp), updatedAt: 'x' });
  if (process.platform !== 'win32') assert.equal(statSync(checkpointPath(plan)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ['kosko-plan.json', CHECKPOINT_NAME]);
  assert.ok(!readFileSync(checkpointPath(plan), 'utf8').includes('cvit_'));
});

test('a checkpoint for another plan, another app, another version, an extra key or bad JSON is ignored, with why', async () => {
  const { plan } = setup();
  const fp = await planFingerprint(plan);
  const write = (obj) => writeFileSync(checkpointPath(plan), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const cases = [
    [{ ...full(fp), plan: { ...fp, sha256: '0'.repeat(64) } }, /another plan/],
    [{ ...full(fp), app: 'http://127.0.0.1:3003' }, /another Kosko/],
    [{ ...full(fp), version: 2 }, /version/],
    [{ ...full(fp), token: 'cvit_x' }, /not a checkpoint/],
    [{ ...full(fp), notes: { [GUID]: 'deleted' } }, /not a checkpoint/],
    [{ ...full(fp), notebooks: { a: 'not-a-uuid' } }, /not a checkpoint/],
    [{ ...full(fp), jobId: '../x' }, /not a checkpoint/],
    ['{not json', /not a checkpoint/]
  ];
  for (const [obj, re] of cases) {
    write(obj);
    const { checkpoint, reason } = loadCheckpoint(plan, { plan: fp, app: APP });
    assert.equal(checkpoint, null);
    assert.match(reason, re);
  }
});

test('benign: no checkpoint yet is no checkpoint and no complaint', async () => {
  const { plan } = setup();
  assert.deepEqual(loadCheckpoint(plan, { plan: await planFingerprint(plan), app: APP }), { checkpoint: null, reason: null });
});

test('a failing rename leaves the previous checkpoint whole and no partial file', async () => {
  const { dir, plan } = setup();
  const fp = await planFingerprint(plan);
  saveCheckpoint(plan, full(fp));
  const before = readFileSync(checkpointPath(plan), 'utf8');
  const rename = () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); };
  assert.throws(() => saveCheckpoint(plan, { ...full(fp), tags: { done: false } }, { rename }), /disk/);
  assert.equal(readFileSync(checkpointPath(plan), 'utf8'), before);
  assert.deepEqual(readdirSync(dir).sort(), ['kosko-plan.json', CHECKPOINT_NAME]);
});

test('a rename refused while another program holds the file is retried (Windows)', async () => {
  const { plan } = setup();
  const fp = await planFingerprint(plan);
  let n = 0;
  const rename = (a, b) => { if (n++ < 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return renameSync(a, b); };
  saveCheckpoint(plan, full(fp), { rename });
  assert.equal(n, 3);
  assert.ok(existsSync(checkpointPath(plan)));
});

test('saving refuses a checkpoint that would not load back', async () => {
  const { plan } = setup();
  const fp = await planFingerprint(plan);
  assert.throws(() => saveCheckpoint(plan, { ...full(fp), secret: 'x' }), /not a checkpoint/);
});

// 466 review H2 — a stack's name is the person's own text: Telugu, accents and punctuation must round-trip.
test('stack keys in any script round-trip; a control character or __proto__ does not', async () => {
  const { plan } = setup();
  const fp = await planFingerprint(plan);
  const notebooks = { 'stack:తెలుగు నోట్స్': NB, 'stack:Café': NB, 'stack:Work (old) — 2019/20': NB, [`stack:${'x'.repeat(300)}`]: NB };
  saveCheckpoint(plan, { ...full(fp), notebooks });
  assert.deepEqual(loadCheckpoint(plan, { plan: fp, app: APP }).checkpoint.notebooks, notebooks);
  assert.throws(() => saveCheckpoint(plan, { ...full(fp), notebooks: { 'stack:a\nb': NB } }), /not a checkpoint/);
  writeFileSync(checkpointPath(plan), JSON.stringify({ ...full(fp), notebooks: JSON.parse('{"__proto__":"' + NB + '"}') }));
  assert.equal(loadCheckpoint(plan, { plan: fp, app: APP }).checkpoint, null);
});
