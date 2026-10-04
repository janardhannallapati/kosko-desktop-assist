// The MCP probe (Kosko doc 449): sign in once, then measure how fast Evernote's MCP server hands out notes.
//
// The tools' parameters are not published, so the run is steered by a plan file the operator writes after reading
// tools.json: a plan with `samples` runs those calls and writes their shapes (content removed) to samples-N.json;
// a plan with `run` starts the measurement. The sign-in survives the wait because the token is refreshed in memory.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { authorizeUrl, discover, exchangeCode, newState, pkcePair, refreshToken, register, waitForCallback } from './oauth.mjs';
import { McpClient, resultData } from './client.mjs';
import { Pacer, RateLimitError } from './pacer.mjs';
import { assertNoSecrets, collectKey, firstUrl, markdownSummary, percentile, shape, Stats } from './report.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => (t == null ? null : createHash('sha256').update(String(t)).digest('hex'));

// R5 support: ENML with its XML declaration and DOCTYPE removed and the ends trimmed, so a header difference
// is told apart from a body difference.
export const normaliseEnml = (t) => (t == null ? null : String(t).replace(/^\s*<\?xml[^>]*\?>/, '').replace(/^\s*<!DOCTYPE[^>]*>/, '').trim());

// What fingerprint mode keeps of one note: hashes, lengths and dates, never the text.
export function noteFingerprint(data) {
  return {
    id: data?.id ?? null,
    created: data?.created ?? null,
    updated: data?.updated ?? null,
    titleSha: sha(data?.title),
    contentSha: sha(data?.content),
    normSha: sha(normaliseEnml(data?.content)),
    contentLength: data?.content?.length ?? null,
    resourceHashes: (data?.resources ?? []).map((r) => r.hash).sort()
  };
}

export function fillTemplate(template, vars) {
  return Object.fromEntries(Object.entries(template).map(([k, v]) => {
    if (typeof v !== 'string' || !v.startsWith('$')) return [k, v];
    if (v === '$note') return [k, vars.note];
    if (v.startsWith('$r.')) return [k, vars.resource?.[v.slice(3)]];
    return [k, v];
  }));
}

// Pages the list tool until it stops yielding new ids or `max` is reached.
export async function enumerate({ list, call, max }) {
  const ids = [];
  const seen = new Set();
  for (let page = 0; page < (list.maxPages ?? 1000) && ids.length < max; page++) {
    const args = { ...list.args };
    if (list.offsetArg) args[list.offsetArg] = page * list.pageSize;
    const data = await call(list.tool, args);
    const fresh = collectKey(data, list.idKey).filter((id) => !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    ids.push(...fresh);
    if (fresh.length === 0 || !list.offsetArg) break;
  }
  return ids.slice(0, max);
}

export async function runProbe({ outDir, port = 8765, maxNotes = Infinity, maxMinutes = 60, planWaitMinutes = 30,
  origin = 'https://mcp.evernote.com', log = console.error, fetchImpl = fetch }) {
  await mkdir(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const secrets = new Set();
  const stats = new Stats();
  const token = { expiresIn: null, refreshIssued: false, refreshOk: null, refreshes: 0 };
  const attach = { downloads: 0, bytes: 0, ms: [] };
  let stoppedBy = 'completed';
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; stoppedBy = 'Ctrl-C'; log('stopping after the current call…'); });

  // 1. Sign in.
  const { resource, as } = await discover(origin, fetchImpl);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const clientId = await register(as, { redirectUri, clientName: 'Kosko desktop assist (probe)' }, fetchImpl);
  const { verifier, challenge } = pkcePair();
  const state = newState();
  [verifier, state].forEach((s) => secrets.add(s));
  const url = authorizeUrl(as, { clientId, redirectUri, challenge, state, scope: 'read', resource });
  await writeFile(path.join(outDir, 'sign-in-url.txt'), url + '\n');
  log(`Open this URL in your browser and sign in to Evernote:\n${url}\n`);
  const code = await waitForCallback({ port, state });
  secrets.add(code);
  let tok = await exchangeCode(as, { clientId, code, verifier, redirectUri, resource }, fetchImpl);
  const remember = (t) => {
    secrets.add(t.access_token);
    if (t.refresh_token) { secrets.add(t.refresh_token); token.refreshIssued = true; }
    token.expiresIn = t.expires_in ?? token.expiresIn;
  };
  remember(tok);
  log('Signed in.');
  const doRefresh = async () => {
    if (!tok.refresh_token) throw new Error('no refresh token to refresh with');
    const next = await refreshToken(as, { clientId, refresh: tok.refresh_token, resource }, fetchImpl);
    tok = { refresh_token: tok.refresh_token, ...next };
    token.refreshes++;
    remember(tok);
  };
  const getToken = async () => {
    if (tok.expires_in && Date.now() > tok.obtainedAt + (tok.expires_in - 60) * 1000) await doRefresh();
    return tok.access_token;
  };

  // 2. Connect and list the tools.
  const client = new McpClient({ url: new URL('/mcp', origin).toString(), getToken, onUnauthorized: doRefresh, fetchImpl });
  const server = await client.initialize();
  const tools = await client.listTools();
  await writeFile(path.join(outDir, 'tools.json'), JSON.stringify({ server: server?.serverInfo, tools }, null, 2));
  log(`${tools.length} tools listed → tools.json. Waiting for plan.json in ${outDir}`);

  const pacer = new Pacer({
    rps: 1,
    onLimit: (l) => { stats.limits.push({ atSec: Math.round((Date.now() - t0) / 1000), ...l }); log(`rate limited: ${JSON.stringify(l)}`); }
  });
  const call = async (name, args) => pacer.run(async () => {
    try {
      const r = await client.callTool(name, args);
      stats.call(name, r.ms, 'ok');
      return resultData(r.result);
    } catch (e) {
      stats.call(name, 0, e instanceof RateLimitError ? `limit-${e.status}` : (e.status ? `http-${e.status}` : e.toolError ? 'tool-error' : 'other'));
      throw e;
    }
  });

  // 3. Wait for the operator's plan; samples may come first, any number of times.
  const planPath = path.join(outDir, 'plan.json');
  let plan = null;
  let samplesRound = 0;
  const waitUntil = Date.now() + planWaitMinutes * 60_000;
  while (!plan && !stopping && Date.now() < waitUntil) {
    let raw = null;
    try { raw = await readFile(planPath, 'utf8'); } catch { await sleep(3000); continue; }
    await rename(planPath, path.join(outDir, `plan-read-${++samplesRound}.json`));
    let p;
    try { p = JSON.parse(raw); } catch { log('plan.json is not JSON; ignored'); continue; }
    if (p.samples) {
      const out = [];
      for (const s of p.samples) {
        try { out.push({ ...s, ok: true, shape: shape(await call(s.tool, s.args)) }); } catch (e) { out.push({ ...s, ok: false, error: e.message }); }
      }
      await writeFile(path.join(outDir, `samples-${samplesRound}.json`), JSON.stringify(out, null, 2));
      log(`samples-${samplesRound}.json written`);
    }
    if (p.run) plan = p.run;
    if (p.refreshNow) { try { await doRefresh(); token.refreshOk = true; } catch (e) { token.refreshOk = `failed: ${e.message}`; } }
  }
  if (!plan && !stopping) stoppedBy = 'no plan within the wait';

  // 4. Measure.
  const notes = { listed: 0, fetched: 0 };
  let listed = [];
  const fingerprints = [];
  let runStart = Date.now();
  if (plan) {
    Object.assign(pacer, plan.pacer ?? {});
    listed = await enumerate({ list: plan.list, call, max: maxNotes });
    notes.listed = listed.length;
    // Burst mode: the same notes again, `repeat` passes in all, so a small account can still reach the server's limit.
    const ids = Array.from({ length: plan.repeat ?? 1 }, () => listed).flat();
    log(`${ids.length} note ids listed; fetching…`);
    runStart = Date.now();
    for (const [i, id] of ids.entries()) {
      if (stopping) break;
      if (Date.now() - runStart > maxMinutes * 60_000) { stoppedBy = 'max-minutes'; break; }
      let data;
      try { data = await call(plan.note.tool, { ...(plan.note.extraArgs ?? {}), [plan.note.idArg]: id }); notes.fetched++; } catch (e) { log(`note ${i}: ${e.message}`); continue; }
      if (plan.fingerprint && i < listed.length) fingerprints.push(noteFingerprint(data));
      if (plan.attachment && i < listed.length && i % (plan.attachment.every ?? 10) === 0) {
        const resources = plan.attachment.resourcesKey ? (collectKeyObjects(data, plan.attachment.resourcesKey)) : [];
        if (resources.length) {
          try {
            const a = await call(plan.attachment.tool, fillTemplate(plan.attachment.args, { note: id, resource: resources[0] }));
            const u = firstUrl(a);
            if (u) {
              const ta = performance.now();
              const res = await fetchImpl(u);
              const buf = await res.arrayBuffer();
              attach.downloads++; attach.bytes += buf.byteLength; attach.ms.push(performance.now() - ta);
            }
          } catch (e) { log(`attachment for note ${i}: ${e.message}`); }
        }
      }
      if ((i + 1) % 50 === 0) log(`${i + 1}/${ids.length} notes, ${((notes.fetched / (Date.now() - runStart)) * 60_000).toFixed(1)}/min`);
    }
    if (token.refreshOk == null && token.refreshIssued) {
      try { await doRefresh(); token.refreshOk = true; } catch (e) { token.refreshOk = `failed: ${e.message}`; }
    }
  }

  // 5. Report.
  const runSec = (Date.now() - runStart) / 1000;
  const perMinute = notes.fetched && runSec > 0 ? +(notes.fetched / runSec * 60).toFixed(1) : null;
  const report = {
    startedAt, stoppedBy, elapsedSec: (Date.now() - t0) / 1000, repeat: plan?.repeat ?? 1, pacerFinalRps: +pacer.rps.toFixed(3),
    authorizationServer: as.issuer, server: server?.serverInfo ?? null,
    notes: { ...notes, perMinute },
    extrapolation5532Min: perMinute ? Math.round(5532 / perMinute) : null,
    tools: stats.summary(), limits: stats.limits,
    token: { expiresIn: token.expiresIn, refreshIssued: token.refreshIssued, refreshOk: token.refreshOk, refreshes: token.refreshes },
    attachments: { downloads: attach.downloads, bytes: attach.bytes, p50ms: percentile([...attach.ms].sort((a, b) => a - b), 50) }
  };
  const json = assertNoSecrets(JSON.stringify(report, null, 2), secrets);
  await writeFile(path.join(outDir, 'report.json'), json);
  if (fingerprints.length) await writeFile(path.join(outDir, 'fingerprints.json'), assertNoSecrets(JSON.stringify(fingerprints, null, 2), secrets));
  await writeFile(path.join(outDir, 'report.md'), assertNoSecrets(markdownSummary(report), secrets));
  log(`report.json and report.md written to ${outDir}`);
  return report;
}

// Objects found under `key` (an array of resource objects, typically).
function collectKeyObjects(v, key) {
  if (Array.isArray(v)) { for (const x of v) { const r = collectKeyObjects(x, key); if (r.length) return r; } return []; }
  if (v && typeof v === 'object') {
    if (Array.isArray(v[key])) return v[key].filter((x) => x && typeof x === 'object');
    for (const x of Object.values(v)) { const r = collectKeyObjects(x, key); if (r.length) return r; }
  }
  return [];
}
