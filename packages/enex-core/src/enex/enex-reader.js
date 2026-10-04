// 253 — read an Evernote export as a stream of note records, in the browser or under Node.
//
//   for await (const record of readEnex(blob, { limits, onProgress, pause })) { … }
//
//   { kind: 'export', application, version }
//   { kind: 'note', index, title, created, updated, tags, attributes, content, resources, tasks, problems }
//   { kind: 'end', notes, error? }     error: 'internal-dtd' | 'not-enex' | 'malformed-xml' | 'too-deep' | 'read-failed' | 'too-large' | 'too-compressed'
//
// ONE MODULE FOR EVERY REALM (10:B2): it takes anything with `stream()` — a File in the page,
// `fs.openAsBlob(path)` in tests and the corpus run.
//
// WHAT STREAMS. Measured over the owner's exports, one note is 176 MB (92 resources) and one resource is
// 45 MB decoded, while the largest note BODY is 1.15 MB. So the unit that must stream is a resource's
// <data>: its base64 goes from sax (which flushes text at 64 KB) through a decoder straight into an
// incremental MD5, and none of it is kept. What IS kept — ENML, title, tags, attributes, task fields — is
// capped, and a cap is a counted problem, never a silent truncation.
//
// HARDENING (spec §3.4). No DTD is read or fetched; a DOCTYPE with an internal subset ends the file before
// any note. sax runs strict with strictEntities, so only the five XML entities and numeric references are
// decoded and an undefined one is a well-formedness error. ENEX nesting is capped. File names are kept as
// display text only.
import sax from 'sax';
import { createMD5 } from 'hash-wasm';
import { createCdataRepair } from './cdata-repair.js';
import { attachEnexAssembler, DEFAULT_LIMITS, Stop } from './enex-assembler.js';

export { DEFAULT_LIMITS };

const ZIP_STOPS = new Set(['too-large', 'too-compressed']); // zip-source.js's fileError codes (421)

export async function* readEnex(blob, { limits: overrides = {}, onProgress, pause, keepResourceData = false } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const md5 = await createMD5();
  // `position` MUST stay on. sax runs its buffer check only when `parser.position` reaches the next check
  // point, and with `position: false` the counter never advances — so every buffer limit, the 64 KB text
  // flush included, silently stops existing while every correctness test stays green (measured; the
  // 300 KB-attribute test in enex-reader.test.js is what fails).
  const parser = sax.parser(true, { strictEntities: true });
  const state = attachEnexAssembler(parser, { limits, md5, keepData: keepResourceData });

  const feed = (text) => {
    for (let at = 0; at < text.length && !state.fatal; at += limits.chunkChars) {
      try {
        parser.write(text.slice(at, at + limits.chunkChars));
      } catch (e) {
        if (!(e instanceof Stop)) state.fatal = state.fatal || 'malformed-xml';
      }
    }
  };

  const reader = blob.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  const repair = createCdataRepair();
  let bytesRead = 0;
  let finished = false;

  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        // 421: a ZIP entry's stream stops at its caps and says which; every other failure is read-failed.
        state.fatal = state.fatal || (ZIP_STOPS.has(e?.fileError) ? e.fileError : 'read-failed');
        break;
      }
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      feed(repair.push(decoder.decode(chunk.value, { stream: true })));
      while (state.queue.length && !state.fatal) yield state.queue.shift();
      if (onProgress) onProgress(bytesRead);
      if (state.fatal) break;
      // A Blob's stream can hand over already-buffered chunks as microtasks, so without this a single
      // 176 MB note is read in one unbroken main-thread task (measured in Chromium: 4.4 s). The caller
      // decides whether to give the page a turn; the reader only offers the moment.
      if (pause) await pause();
    }
    if (!state.fatal) {
      feed(repair.push(decoder.decode()) + repair.end());
      if (!state.fatal) {
        try {
          parser.close();
        } catch (e) {
          if (!(e instanceof Stop)) state.fatal = state.fatal || 'malformed-xml';
        }
      }
      if (!state.fatal && !state.sawRoot) state.fatal = 'not-enex';
    }
    // Records completed before a fatal error are real notes and are still yielded; the export record of a
    // file refused at its DOCTYPE is never queued, because the refusal fires before the root opens.
    while (state.queue.length) yield state.queue.shift();
    finished = true;
    yield state.fatal ? { kind: 'end', notes: state.notes, error: state.fatal } : { kind: 'end', notes: state.notes };
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}

