import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const enex = readFileSync(process.argv[2], 'utf8');
const fps = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const shas = new Set(fps.map((f) => f.contentSha)), norms = new Set(fps.map((f) => f.normSha));
const lens = new Set(fps.map((f) => f.contentLength));
const strip = (t) => t.replace(/<div style="display:none;--en-chs:[^"]*"> <\/div>/, '');
const hdr = (t) => t.replace(/^\s*<\?xml[^>]*\?>/, '').replace(/^\s*<!DOCTYPE[^>]*>/, '').trim();
const out = { chsRemoved_raw: 0, chsRemoved_trimEnd: 0, chsRemoved_norm: 0, none: 0, chsDivPresent: 0 };
for (const [, c] of enex.matchAll(/<content>\s*<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
  if (/--en-chs:/.test(c)) out.chsDivPresent++;
  const a = strip(c);
  if (shas.has(sha(a))) out.chsRemoved_raw++;
  else if (shas.has(sha(a.trimEnd()))) out.chsRemoved_trimEnd++;
  else if (norms.has(sha(hdr(a)))) out.chsRemoved_norm++;
  else out.none++;
}
console.log(out, 'mcp lengths sample', [...lens].slice(0, 5));
