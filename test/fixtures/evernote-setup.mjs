// 512's shared setup: the synthetic account's plan, the in-memory Kosko, and the fake MCP server holding ENML for the
// three notes Evernote would list (the Odd id note's id is not a GUID, so Evernote never lists it). A virtual clock
// drives the pacer, so pacing is measured, not waited for.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticAccount, ID, HASH } from './synthetic-db.mjs';
import { runDryRun } from '../../src/plan/dry-run.mjs';
import { runSend } from '../../src/send/library/run-send.mjs';
import { createFakeKosko } from './fake-kosko.mjs';
import { createFakeMcp, autoAuthorize } from '../fake-mcp/server.mjs';

export const TOKEN = `cvit_${'e5'.repeat(32)}`;
export const APP = 'https://kosko.test';
export const HEADER = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';
export const SECRET_WORD = 'Zanzibarquill'; // in a formatted body only: it must never reach the console
export const BODIES = {
  [ID.nActive]: `${HEADER}<en-note><div><b>hello</b> ${SECRET_WORD}</div><table><tr><td>a</td><td>b</td></tr></table>`
    + `<en-media hash="${HASH.present}" type="image/png"/><div><en-todo checked="true"/>done</div></en-note>`,
  [ID.nEmptyText]: `${HEADER}<en-note><ul><li>one</li><li>two</li></ul></en-note>`,
  [ID.nSpace]: `${HEADER}<en-note><h1>Scans</h1><en-media hash="${HASH.noWords}" type="image/png"/><div>between</div>`
    + `<en-media hash="${HASH.telugu}" type="image/png"/></en-note>`
};
export const LISTED = [ID.nActive, ID.nEmptyText, ID.nSpace]; // the Odd id note's id is not a GUID: Evernote never lists it

export function clock() {
  const c = { t: 1_000_000 };
  return { now: () => c.t, sleep: async (ms) => { c.t += ms; }, c };
}

export async function setup({ mcp: mcpOpts = {}, notes = LISTED, mutate, kosko: koskoOpts } = {}) {
  const acct = buildSyntheticAccount({ mutate });
  const outDir = mkdtempSync(join(tmpdir(), 'kda-ev-'));
  await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const kosko = createFakeKosko(koskoOpts);
  kosko.token = TOKEN;
  const time = clock();
  const mcp = createFakeMcp({ now: time.now, ...mcpOpts,
    notes: notes.map((guid, i) => ({ guid, title: `T${i}`, enml: BODIES[guid], created: i, updated: i })) });
  const signIns = { count: 0 };
  return { acct, planPath: join(outDir, 'kosko-plan.json'), kosko, mcp, time, signIns };
}

export async function send(s, { evernote = true, mcpFetch, evernoteExtra = {}, ...extra } = {}) {
  const lines = [];
  const fetchMcp = mcpFetch ?? s.mcp.fetch;
  const r = await runSend({ planPath: s.planPath, app: APP, token: TOKEN, dataDir: s.acct.dataDir, fetch: s.kosko.fetch,
    tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: (l) => lines.push(l), sleep: async () => {}, random: () => 0,
    evernote: evernote ? { origin: s.mcp.origin, fetch: fetchMcp, authorize: autoAuthorize(fetchMcp, s.signIns), sleep: s.time.sleep, now: s.time.now,
      signedUrlOk: s.mcp.signedUrlOk, ...evernoteExtra } : null,
    ...extra });
  return { ...r, out: lines.join('\n') };
}

export const byGuid = (s, guid) => [...s.kosko.state.notes.values()].find((n) => n.external_id === guid);
export const types = (doc) => { const out = []; (function w(n) { out.push(n.type); (n.content ?? []).forEach(w); })(doc); return out; };
export const paths = (doc) => { const out = new Set(); (function w(n) { if (n.attrs?.path) out.add(n.attrs.path); (n.content ?? []).forEach(w); })(doc); return out; };
