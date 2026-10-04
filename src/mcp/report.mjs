// What the probe writes down. Rule 5: counts, timings, status codes, tool names, GUIDs and byte sizes — never a
// note's title or body. Shapes replace every string that is not an id with its length.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{32}$/i;

// The structure of a value with its content removed: keys and types stay, ids stay, every other string becomes
// "<string N>", URLs "<url>", and arrays keep their length and the shape of their first two items.
export function shape(v, depth = 0) {
  if (depth > 8) return '<deep>';
  if (Array.isArray(v)) return { '<array>': v.length, items: v.slice(0, 2).map((x) => shape(x, depth + 1)) };
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  if (typeof v === 'string') {
    if (GUID.test(v) || HEX.test(v)) return v;
    if (/^https?:\/\//.test(v)) return '<url>';
    return `<string ${v.length}>`;
  }
  return v;
}

// Every value found under `key`, at any depth.
export function collectKey(v, key, out = []) {
  if (Array.isArray(v)) v.forEach((x) => collectKey(x, key, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === key && (typeof x === 'string' || typeof x === 'number')) out.push(x);
      else collectKey(x, key, out);
    }
  }
  return out;
}

export function firstUrl(v) {
  if (typeof v === 'string') return /^https:\/\//.test(v) ? v : (v.match(/https:\/\/\S+/)?.[0] ?? null);
  if (Array.isArray(v)) { for (const x of v) { const u = firstUrl(x); if (u) return u; } return null; }
  if (v && typeof v === 'object') { for (const x of Object.values(v)) { const u = firstUrl(x); if (u) return u; } }
  return null;
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

export class Stats {
  constructor() { this.byTool = {}; this.limits = []; this.events = []; }
  call(tool, ms, outcome) {
    const t = (this.byTool[tool] ??= { calls: 0, ok: 0, errors: {}, ms: [] });
    t.calls++;
    if (outcome === 'ok') { t.ok++; t.ms.push(ms); } else t.errors[outcome] = (t.errors[outcome] ?? 0) + 1;
  }
  summary() {
    return Object.fromEntries(Object.entries(this.byTool).map(([k, t]) => {
      const s = [...t.ms].sort((a, b) => a - b);
      return [k, { calls: t.calls, ok: t.ok, errors: t.errors, p50ms: percentile(s, 50), p95ms: percentile(s, 95), maxms: s.length ? Math.round(s.at(-1)) : null }];
    }));
  }
}

// Rule 2's last line of defence: refuse to write a report that contains any secret this process holds.
export function assertNoSecrets(text, secrets) {
  for (const s of secrets) {
    if (s && s.length >= 8 && text.includes(s)) throw new Error('refusing to write: report contains a secret');
  }
  return text;
}

export function markdownSummary(r) {
  const lines = [
    `# Evernote MCP probe — ${r.startedAt}`,
    '',
    `Stopped by: ${r.stoppedBy}. Elapsed ${Math.round(r.elapsedSec)} s.`,
    `Notes fetched: ${r.notes.fetched} (${r.notes.listed} listed, ${r.repeat ?? 1} pass(es)). Sustained rate: **${r.notes.perMinute ?? '—'} notes/min**.`,
    `Extrapolated (from ${r.notes.fetched} notes, an extrapolation, not a measurement): 5,532 notes ≈ ${r.extrapolation5532Min ?? '—'} min.`,
    '',
    '| Tool | Calls | OK | Errors | p50 ms | p95 ms | max ms |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(r.tools).map(([k, t]) => `| ${k} | ${t.calls} | ${t.ok} | ${JSON.stringify(t.errors)} | ${t.p50ms} | ${t.p95ms} | ${t.maxms} |`),
    '',
    `Rate-limit events: ${r.limits.length}${r.limits.length ? '' : ' (none seen)'}.`,
    ...r.limits.map((l) => `- at +${l.atSec}s: status ${l.status}, Retry-After ${l.retryAfterSec ?? 'none'}, waited ${l.waitedMs} ms, rate → ${l.newRps.toFixed(3)}/s`),
    '',
    `Token: expires_in ${r.token.expiresIn ?? 'not stated'} s; refresh token issued: ${r.token.refreshIssued}; forced refresh: ${r.token.refreshOk ?? 'not tried'}.`,
    `Attachments: ${r.attachments.downloads} downloads, ${r.attachments.bytes} bytes, median ${r.attachments.p50ms ?? '—'} ms.`
  ];
  return lines.join('\n') + '\n';
}
