// 467 rule 11 — what one run counted, as Kosko's job summary (382/383) and receipt (423 + 465's desktop block).
//
// Every planned note is settled exactly once (created, skipped with or without a reason, or not imported with one),
// every attachment row of a planned note is counted once in one bucket, and the structure counts sit beside them, so
// Kosko's receipt page can hold each against the plan's expected counts (465 rule 8). Titles and notebook names only,
// never note text; lists bounded by Kosko's RECEIPT_LIMITS (2,000 notes, 1,000 missing files, 200 characters, 400 KB).

const LIMITS = Object.freeze({ notes: 2000, files: 1000, text: 200, bytes: 380 * 1024 });
const NOT_IMPORTED_FIRST = (a, b) => (a.outcome === b.outcome ? 0 : a.outcome === 'not_imported' ? -1 : 1);
const cut = (v) => Array.from(String(v ?? '')).slice(0, LIMITS.text).join('').toWellFormed();
const byteSize = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

// 511: an unchanged note is plain "already here" and never named, or a re-run would list every note it met.
const QUIET_SKIP_REASONS = new Set(['unchanged']);

export const emptyAttachmentCounts = () => ({ stored: 0, placeholder: 0, over_cap: 0, type_not_stored: 0, unreadable: 0, not_imported_with_note: 0 });

export function createTally() {
  const notes = { created: 0, updated: 0, skipped: 0, not_imported: 0 }; // 511: updated
  const reasons = {};
  const skipReasons = {};
  const attachments = emptyAttachmentCounts();
  const named = []; // { title, notebook, reason, outcome }
  const missing = []; // { note, name }
  let noteTags = 0;
  const settled = new Set();

  return {
    settledKeys: settled,
    /**
     * One note, once: `outcome` created | updated | skipped | not_imported, `reason` a Kosko reason code or null, `counts` its
     * attachment rows by bucket (ignored for a note not imported: its rows are `not_imported_with_note`).
     */
    settle(key, { outcome, reason = null, title, notebook, tagCount, attachmentRows, counts, missingFiles }) {
      if (settled.has(key)) return;
      settled.add(key);
      notes[outcome] += 1;
      noteTags += tagCount;
      if (outcome === 'not_imported') {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        attachments.not_imported_with_note += attachmentRows;
      } else {
        for (const [k, n] of Object.entries(counts)) attachments[k] += n;
        if (outcome === 'skipped' && reason) skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      }
      if (outcome === 'not_imported' || (reason && !QUIET_SKIP_REASONS.has(reason))) named.push({ title: cut(title || 'Untitled note'), notebook: cut(notebook), reason, outcome });
      // A file that was not on this computer is named whatever became of its note (465 rule 10).
      for (const f of missingFiles) missing.push({ note: cut(title || 'Untitled note'), name: cut(f || 'Untitled file') });
    },
    counts: () => ({ notes: { ...notes }, settled: settled.size }),

    /** { summary, receipt } for PATCH /api/import/jobs/{id}. `structure`: what the notebook and tag steps accounted for. */
    build({ expected, structure, trashedNotes, ocr }) {
      const summary = { notes: { ...notes }, reasons: { ...reasons }, skip_reasons: { ...skipReasons }, attachments: { ...attachments }, expected };
      const ordered = [...named].sort(NOT_IMPORTED_FIRST);
      const receipt = {
        v: 1,
        notes: ordered.slice(0, LIMITS.notes).map(({ title, notebook, reason }) => ({ title, notebook, reason })),
        notesMore: 0, files: [], filesMore: 0, links: [], linksMore: 0,
        // What an ENEX export cannot carry does not apply to a desktop run (465 hides these lines); notebooks is the
        // number of notebooks the run filed into, as /import's receipt counts its plan.
        cannotCarry: { locked: 0, placeholders: 0, rawHtml: 0, todoGlyphs: 0, remoteImages: 0, unresolvedTasks: 0,
          notebooks: structure.notebooks + structure.stacks + structure.spaceNotebooks, grouped: 0, parents: 0, links: 0, linked: 0 },
        desktop: { notebooks: structure.notebooks, stacks: structure.stacks, spaceNotebooks: structure.spaceNotebooks,
          tags: structure.tags, tagsDropped: structure.tagsDropped, noteTags, trashedNotes,
          missingFiles: missing.length, missing: missing.slice(0, LIMITS.files), missingMore: 0,
          // 501/504: all five image-text counts, or none (a caller that sent no OCR)
          ...(ocr ? { ocrWords: ocr.ocrWords, ocrEmpty: ocr.ocrEmpty, ocrUnreadable: ocr.ocrUnreadable,
            ocrNotSent: ocr.ocrNotSent, ocrRefused: ocr.ocrRefused } : {}) }
      };
      // Over the byte budget: halve the longer list until it fits (Kosko's buildReceipt does the same).
      while (byteSize(receipt) > LIMITS.bytes && (receipt.notes.length || receipt.desktop.missing.length)) {
        if (receipt.notes.length >= receipt.desktop.missing.length) receipt.notes = receipt.notes.slice(0, Math.floor(receipt.notes.length / 2));
        else receipt.desktop.missing = receipt.desktop.missing.slice(0, Math.floor(receipt.desktop.missing.length / 2));
      }
      receipt.notesMore = named.length - receipt.notes.length;
      receipt.desktop.missingMore = missing.length - receipt.desktop.missing.length;
      return { summary, receipt };
    }
  };
}
