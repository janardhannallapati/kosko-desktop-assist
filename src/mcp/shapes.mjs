// Kosko 537 — `kosko-assist shapes`: on the paid account, re-record the shape of every MCP call the run makes and
// diff it against the fake the run was proved on (src/mcp/shapes-baseline.json), before the big run (W7 demo item 2).
//
// Rules this module owns (Kosko doc 537):
// - Read only, Evernote only (rule 1): the run's own sign-in and read-tool client; a few attachments are downloaded,
//   hashed in memory and dropped. Kosko is never contacted.
// - Shape, never content (rule 2): skeletons, GUIDs, MD5s, counts, hosts, statuses. The file is scanned for every
//   secret of the session before it is written.
// - The run's own calls (rule 4): listNoteGuids, fetchNoteBody and fetchAttachment, watched through openEvernote's
//   `observe`, so the arguments checked against the server's schemas are the ones the run sends.
import { renameSync, rmSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, dirname, basename } from 'node:path';
import { TOOL_VERSION } from '../version.mjs';
import { loadPlan } from '../send/library/plan-file.mjs';
import { assertNoSecrets } from './report.mjs';
import { skeleton, merge, diffSkeletons } from './skeleton.mjs';
import { openEvernote, fetchNoteBody, fetchAttachment, isSignedUrl, isTransient, EvernoteAuthFailed, BodyMissing, AttachmentMissing } from './evernote.mjs';
import BASELINE from './shapes-baseline.json' with { type: 'json' };

export const SHAPE_TOOLS = Object.freeze(['search_notes', 'get_note', 'get_attachment']);
export const SHAPES_FILE = 'kosko-shapes.json';
export const DEFAULT_NOTES = 5;
export const MAX_NOTES = 50;
export const MAX_DOWNLOADS = 3;
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const TRIES = 3; // review A3: a 5xx, a network blip or a pacer give-up is tried again, as send --evernote does

/**
 * Rule 5, review A1: the fields the run reads. A key missing, or a type changed, ON or ABOVE one of these paths is red;
 * anywhere else it is only noted, because Evernote leaves optional fields out of some answers and a 5-note sample
 * cannot hold every one. Each path names its reader.
 */
export const READ_PATHS = Object.freeze([
  'search_notes.hits[].noteId', 'search_notes.isLastPage', // listNoteGuids
  'get_note.id', 'get_note.content', 'get_note.resources[].hash', // fetchNoteBody; resources[].hash: shapes' own pick
  'get_attachment.url', 'get_attachment.expiresAt' // fetchAttachment
]);
const pathOf = (line) => line.slice(0, line.indexOf(': '));
export const isReadPath = (path) => READ_PATHS.some((r) => r === path || r.startsWith(`${path}.`) || r.startsWith(`${path}[`));

const lower = (s) => String(s).toLowerCase();
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The planned notes Evernote lists, those with attachments first (plan order otherwise), `n` of them. */
export function pickSample(plan, listedSet, n) {
  const withFiles = new Set(plan.attachments.map((a) => lower(a.noteId)));
  const listed = plan.notes.map((x) => lower(x.id)).filter((g) => listedSet.has(g));
  return [...listed.filter((g) => withFiles.has(g)), ...listed.filter((g) => !withFiles.has(g))].slice(0, n);
}

/** Rule 10: attachments get_note offered for the sampled notes, matched to the plan by MD5, within the byte bound, smallest first. */
export function pickAttachments(plan, offered, max = MAX_DOWNLOADS) {
  const seen = new Set();
  return plan.attachments
    .filter((a) => a.size <= MAX_DOWNLOAD_BYTES && offered.get(lower(a.noteId))?.has(a.dataHash))
    .sort((a, b) => a.size - b.size || (a.dataHash < b.dataHash ? -1 : 1))
    .filter((a) => !seen.has(a.dataHash) && seen.add(a.dataHash))
    .slice(0, max)
    .map((a) => ({ guid: lower(a.noteId), md5: a.dataHash, size: a.size }));
}

// What may be printed or written about a failure: our own sentences, never a server's text (review A6).
function safeReason(e) {
  if (e instanceof EvernoteAuthFailed) return e.message;
  if (e instanceof SyntaxError) return 'Evernote answered with something that is not JSON';
  if (e?.status) return `HTTP ${e.status}`;
  if (e?.toolError) return 'Evernote answered the call with an error';
  return e?.name === 'Error' ? 'the call failed' : String(e?.name ?? 'the call failed');
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return '(not a URL)'; } };
const envelopeOf = (result) => [result?.structuredContent !== undefined ? 'structuredContent' : null,
  ...new Set((result?.content ?? []).map((c) => c?.type))].filter(Boolean).join('+');

/** Signs in, makes the run's calls on a small sample, and returns what they looked like. Never content. */
export async function recordShapes({ plan, notes = DEFAULT_NOTES, evernote = {}, log = () => {}, signal }) {
  const { signedUrlOk = isSignedUrl, now, fetchImpl = fetch, downloadFloorMs, ...open } = evernote;
  const results = {};
  const args = {};
  const envelopes = {};
  const offered = new Map();
  const hosts = new Map();
  const urls = new Set(); // review A6: a signed URL is read access, so it is scanned for like a token
  const observe = (event) => {
    const { name, args: a, result, data } = event;
    const sent = (args[name] ??= new Set());
    for (const k of Object.keys(a ?? {})) sent.add(k);
    if (!('result' in event)) return;
    const s = skeleton(data);
    results[name] = results[name] ? merge(results[name], s) : s;
    (envelopes[name] ??= new Set()).add(envelopeOf(result));
    if (name === 'get_note' && Array.isArray(data?.resources)) offered.set(lower(a.noteId), new Set(data.resources.map((r) => r?.hash)));
    if (name === 'get_attachment' && typeof data?.url === 'string') { urls.add(data.url); hosts.set(hostOf(data.url), signedUrlOk(data.url)); }
  };
  const opened = await openEvernote({ ...open, fetchImpl, now, log, signal, observe });
  if (opened.freePlan) return { freePlan: true };
  const { listed, session, stats } = opened;
  const call = async (name, a) => {
    for (let i = 1; ; i++) {
      try { return await opened.call(name, a); } catch (e) { if (signal?.aborted || !isTransient(e) || i >= TRIES) throw e; }
    }
  };

  const listedSet = new Set(listed);
  const planned = new Set(plan.notes.map((x) => lower(x.id)));
  const coverage = { listed: listed.length, planned: planned.size,
    planNotListed: [...planned].filter((g) => !listedSet.has(g)), listedNotInPlan: listed.filter((g) => !planned.has(g)) };

  const sample = pickSample(plan, listedSet, notes);
  const bodiesMissing = [];
  for (const guid of sample) {
    try { await fetchNoteBody(call, guid); } catch (e) { if (!(e instanceof BodyMissing)) throw e; bodiesMissing.push(guid); }
  }
  const downloads = [];
  if (session.client.tools.has('get_attachment')) {
    for (const a of pickAttachments(plan, offered)) {
      try {
        await fetchAttachment({ call, fetchImpl, signal, signedUrlOk, ...(now ? { now } : {}), ...(downloadFloorMs ? { downloadFloorMs } : {}) }, a);
        downloads.push({ md5: a.md5, size: a.size, ok: true });
      } catch (e) {
        if (!(e instanceof AttachmentMissing)) throw e;
        downloads.push({ md5: a.md5, size: a.size, ok: false, reason: e.message });
      }
    }
  }
  // R3: renew once, as a long run must, and prove the next call works on the new token without a browser.
  // search_notes, not get_note: a sampled note deleted meanwhile must not read as a failed refresh (review A5). The
  // count proves ONE renewal did it: a rejected new token would make the client renew again and still answer.
  let refresh;
  try {
    const before = session.stats.refreshes;
    await session.forceRefresh();
    await call('search_notes', { query: '', maxResults: 1, startIndex: 0 });
    const renewals = session.stats.refreshes - before;
    refresh = renewals === 1 ? { ok: true } : { ok: false, reason: `the sign-in needed ${renewals} renewals instead of one` };
  } catch (e) {
    if (signal?.aborted) throw e;
    refresh = { ok: false, reason: safeReason(e) };
  }
  const tools = Object.fromEntries(SHAPE_TOOLS.map((t) => {
    const def = session.client.tools.get(t);
    return [t, { offered: Boolean(def), properties: Object.keys(def?.inputSchema?.properties ?? {}).sort(), required: [...(def?.inputSchema?.required ?? [])].sort() }];
  }));
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, [...o[k]].sort()]));
  return { freePlan: false, server: skeleton(opened.server ?? {}), tools, results, args: sorted(args), envelopes: sorted(envelopes),
    coverage, sample: sample.length, bodiesMissing, downloads, hosts: [...hosts].map(([host, ok]) => ({ host, ok })),
    token: session.token, refresh, limits: stats.limits, calls: stats.calls, secrets: new Set([...session.secrets, ...urls]) };
}

/** What scripts/shapes-baseline.mjs commits: the parts of a recording the live one is compared with. */
export function baselineOf(rec) {
  return { format: 'kosko-shapes-baseline', version: 1, server: rec.server,
    tools: Object.fromEntries(SHAPE_TOOLS.map((t) => [t, { properties: rec.tools[t].properties, required: rec.tools[t].required }])),
    results: Object.fromEntries(Object.keys(rec.results).sort().map((k) => [k, rec.results[k]])), envelopes: rec.envelopes };
}

/** Each check green or red, in the order the screen shows them, plus what breaks nothing but is worth reading. */
export function compareToBaseline(rec, baseline = BASELINE) {
  const noted = [];
  const missingTools = SHAPE_TOOLS.filter((t) => !rec.tools[t].offered);
  const argLines = [];
  for (const t of SHAPE_TOOLS.filter((x) => rec.tools[x].offered)) {
    const { properties, required } = rec.tools[t];
    const sent = rec.args[t] ?? [];
    for (const a of sent.filter((x) => !properties.includes(x))) argLines.push(`${t} sends ${a}, which the server's schema does not name`);
    for (const r of required.filter((x) => !sent.includes(x))) argLines.push(`${t} requires ${r}, which the run does not send`);
    for (const p of (baseline.tools[t]?.properties ?? []).filter((x) => !properties.includes(x))) noted.push(`${t} input: ${p} no longer offered`);
    for (const p of properties.filter((x) => !(baseline.tools[t]?.properties ?? []).includes(x))) noted.push(`${t} input: ${p} is new`);
  }
  const resultLines = [];
  for (const t of SHAPE_TOOLS) {
    if (!rec.results[t]) { resultLines.push(`${t}: not exercised, so its answer could not be compared`); continue; }
    const d = diffSkeletons(baseline.results[t], rec.results[t], t);
    resultLines.push(...d.differences.filter((l) => isReadPath(pathOf(l))));
    noted.push(...d.differences.filter((l) => !isReadPath(pathOf(l))).map((l) => `${l} (not read by the run)`), ...d.noted);
    const was = (baseline.envelopes?.[t] ?? []).join(', ');
    const now = (rec.envelopes[t] ?? []).join(', ');
    if (was !== now) noted.push(`${t} answers as ${now || 'nothing'} (the fake answers as ${was || 'nothing'})`);
  }
  for (const g of rec.bodiesMissing) resultLines.push(`get_note gave no body for ${g}`);
  noted.push(...diffSkeletons(baseline.server, rec.server, 'initialize').differences.map((l) => `${l} (server info)`));
  const c = rec.coverage;
  const coverageLines = c.planNotListed.length || c.listedNotInPlan.length
    ? [`${plural(c.planNotListed.length, 'planned note is', 'planned notes are')} not listed by Evernote; `
      + `${plural(c.listedNotInPlan.length, 'listed note is', 'listed notes are')} not in the plan (their GUIDs are in ${SHAPES_FILE})`] : [];
  const badHosts = rec.hosts.filter((h) => !h.ok).map((h) => `signed URLs come from ${h.host}, outside the pinned hosts`);
  const failed = rec.downloads.filter((d) => !d.ok).map((d) => `attachment ${d.md5}: ${d.reason}`);
  return { noted, checks: [
    { id: 'tools', ok: !missingTools.length, lines: missingTools.map((t) => `Evernote's server does not offer ${t}`) },
    { id: 'arguments', ok: !argLines.length, lines: argLines },
    { id: 'results', ok: !resultLines.length, lines: resultLines },
    { id: 'coverage', ok: !coverageLines.length, lines: coverageLines },
    { id: 'hosts', ok: rec.hosts.length > 0 && !badHosts.length, lines: rec.hosts.length ? badHosts : ['no signed URL was seen'] },
    { id: 'downloads', ok: rec.downloads.length > 0 && !failed.length, lines: rec.downloads.length ? failed : ['no attachment was downloaded'] },
    { id: 'refresh', ok: rec.refresh.ok, lines: rec.refresh.ok ? [] : [rec.refresh.reason] }
  ] };
}

const SUMMARY = { tools: 'the three tools are offered', arguments: 'every argument the run sends is in the schema',
  results: 'every answer has the shape the run was proved on', coverage: 'Evernote lists every planned note and nothing else',
  hosts: 'signed URLs come from the pinned host', downloads: 'downloaded files have the planned size and MD5',
  refresh: 'the sign-in renews without the browser' };

// Review A7: compared through symlinks, from the nearest folder that exists (--out may not exist yet).
function real(p) {
  let head = resolve(p);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) { rest.unshift(basename(head)); head = dirname(head); }
  try { return join(realpathSync(head), ...rest); } catch { return resolve(p); }
}
function isInside(child, parent) {
  const r = relative(real(parent), real(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** The command: record, compare, write kosko-shapes.json, print one screen. 0 all green, 1 any red, 2 bad --out. */
export async function runShapes({ planPath, outDir, notes = DEFAULT_NOTES, dataDirs = [], evernote = {}, baseline = BASELINE,
  log = (l) => process.stdout.write(`${l}\n`), signal }) {
  if (dataDirs.some((d) => isInside(outDir, d))) { log("--out is inside Evernote's data folder; choose a folder of your own."); return 2; }
  const file = join(outDir, SHAPES_FILE);
  try { mkdirSync(outDir, { recursive: true }); } catch { log(`--out ${outDir} cannot be created; choose a folder you can write to.`); return 2; }
  try {
    const plan = loadPlan(planPath);
    log(`Checking Evernote's MCP answers against the shapes the run was proved on (${plural(notes, 'note', 'notes')} sampled)…`);
    const rec = await recordShapes({ plan, notes, evernote, log, signal });
    if (rec.freePlan) { log('Evernote refused this account over MCP: it is on a free plan, so there are no formatted notes to check.'); return 1; }
    const { checks, noted } = compareToBaseline(rec, baseline);
    const verdict = checks.every((c) => c.ok) ? 'match' : 'differs';
    const { secrets, ...kept } = rec;
    const report = { format: 'kosko-shapes', version: 1, generatedAt: new Date().toISOString(), tool: { name: 'kosko-desktop-assist', version: TOOL_VERSION },
      verdict, checks, noted, ...kept };
    const text = assertNoSecrets(`${JSON.stringify(report, null, 2)}\n`, secrets);
    try {
      writeFileSync(`${file}.partial`, text, { mode: 0o600 });
      renameSync(`${file}.partial`, file);
    } catch (e) { rmSync(`${file}.partial`, { force: true }); throw e; }
    for (const c of checks) {
      log(`  ${c.ok ? 'green' : 'RED  '}  ${c.id.padEnd(9)}  ${c.ok ? SUMMARY[c.id] : c.lines[0]}`);
      for (const l of c.ok ? [] : c.lines.slice(1, 5)) log(`                    ${l}`);
    }
    log(`Listed ${plural(rec.coverage.listed, 'note', 'notes')} of ${rec.coverage.planned.toLocaleString('en-US')} planned; `
      + `${plural(rec.calls, 'call', 'calls')}, ${plural(rec.limits, 'rate limit', 'rate limits')}; ${noted.length} noted.`);
    const red = checks.filter((c) => !c.ok).length;
    log(red ? `${plural(red, 'check is', 'checks are')} red: fix and re-prove before the run. Details: ${file}`
      : `Every check is green: the shapes match. Details: ${file}`);
    return red ? 1 : 0;
  } catch (e) {
    rmSync(`${file}.partial`, { force: true });
    if (signal?.aborted) { log('Stopped. Nothing was written.'); return 1; }
    // Our own sentences pass through (loadPlan, openEvernote); a server's text never does (review A6).
    log(`shapes: ${e instanceof SyntaxError ? safeReason(e) : e.message}`);
    return 1;
  }
}
