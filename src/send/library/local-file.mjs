// 512/514 — the files the --evernote route writes beside the plan (kosko-evernote-listing.json, kosko-evernote-links.json):
// GUIDs and reasons the receipt cannot name. They only name what the summary's counts already say, so a write that fails
// never fails the run (review T5): one counts-only line, and the import goes on.
import { writeFileSync, renameSync, rmSync } from 'node:fs';

/**
 * A local file beside the plan, best effort (review T5): a write that fails is said in one counts-only line and the
 * run goes on. The file only names what the counts already say. true when it was written.
 */
export function writeLocalFile(file, value, log, what) {
  try {
    writeFileSync(`${file}.partial`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.partial`, file);
    return true;
  } catch {
    try { rmSync(`${file}.partial`, { force: true }); } catch { /* best effort */ }
    log(`The list of ${what} could not be saved beside the plan; the counts above still hold, and the import goes on.`);
    return false;
  }
}
