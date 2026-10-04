// R5: is MCP's get_note body byte-identical to the ENEX export's <content>? Prints counts only.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [enexPath, fpPath, outPath] = process.argv.slice(2);
const sha = (t) => createHash('sha256').update(t).digest('hex');
const md5 = (b) => createHash('md5').update(b).digest('hex');
const norm = (t) => t.replace(/^\s*<\?xml[^>]*\?>/, '').replace(/^\s*<!DOCTYPE[^>]*>/, '').trim();
const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const enexDate = (iso) => iso.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, ''); // 2026-09-28T04:05:12.000Z -> 20260928T040512Z

const enex = readFileSync(enexPath, 'utf8');
const notes = [...enex.matchAll(/<note>([\s\S]*?)<\/note>/g)].map(([, n]) => {
  const content = n.match(/<content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content>/)?.[1] ?? null;
  const resources = [...n.matchAll(/<data[^>]*>([\s\S]*?)<\/data>/g)].map(([, b64]) => md5(Buffer.from(b64.replace(/\s+/g, ''), 'base64'))).sort();
  return {
    title: unxml(n.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
    created: n.match(/<created>([^<]*)<\/created>/)?.[1] ?? null,
    content, resources
  };
});
const fps = JSON.parse(readFileSync(fpPath, 'utf8'));

const byKey = new Map();
for (const f of fps) {
  const k = `${enexDate(f.created)}|${f.titleSha}`;
  byKey.set(k, [...(byKey.get(k) ?? []), f]);
}
const byCreated = new Map();
for (const f of fps) byCreated.set(enexDate(f.created), (byCreated.get(enexDate(f.created)) ?? 0) + 1);

const r = { enexNotes: notes.length, mcpNotes: fps.length, matchedByCreatedAndTitle: 0, unmatched: 0, createdCollisionsMcp: [...byCreated.values()].filter((n) => n > 1).length,
  bodyIdentical: 0, bodyIdenticalAfterHeaderStrip: 0, bodyDiffers: 0, resourcesIdentical: 0, resourcesDiffer: 0, lengthDeltas: [] };
for (const n of notes) {
  const hit = byKey.get(`${n.created}|${sha(n.title)}`);
  if (!hit || hit.length !== 1) { r.unmatched++; continue; }
  const f = hit[0];
  r.matchedByCreatedAndTitle++;
  if (n.content != null && sha(n.content) === f.contentSha) r.bodyIdentical++;
  else if (n.content != null && sha(norm(n.content)) === f.normSha) r.bodyIdenticalAfterHeaderStrip++;
  else { r.bodyDiffers++; r.lengthDeltas.push((n.content?.length ?? 0) - (f.contentLength ?? 0)); }
  if (JSON.stringify(n.resources) === JSON.stringify(f.resourceHashes)) r.resourcesIdentical++; else r.resourcesDiffer++;
}
r.lengthDeltas = r.lengthDeltas.slice(0, 20);
writeFileSync(outPath, JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 2));
