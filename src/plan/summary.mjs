// The one-screen summary of a dry run. Plain text, because it is printed in a terminal and saved beside the plan.

const num = (n) => n.toLocaleString('en-US');
export function bytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const row = (label, value, note = '') => `  ${label.padEnd(12)}${value.padStart(7)}   ${note}`.trimEnd();

/**
 * @param {{ account, counts, problems: { missingFiles, sizeMismatch, invalidIds, ocrErrors } (numbers),
 *   ocrTextBytes, ocrWithWords, check: { passed, differences }, planPath, planBytes, otherAccounts, elapsedMs }} s
 */
export function renderSummary(s) {
  const c = s.counts;
  const p = s.problems;
  const found = c.attachments - p.missingFiles - p.sizeMismatch - p.invalidIds;
  const attNotes = [`${bytes(c.attachmentBytes)}; ${num(found)} found on disk`, `${num(p.missingFiles)} missing`];
  if (p.sizeMismatch) attNotes.push(`${num(p.sizeMismatch)} wrong size`);
  if (p.invalidIds) attNotes.push(`${num(p.invalidIds)} unreadable ids`);
  const ocrNote = `scanned for text, ${num(s.ocrWithWords)} with words; ${bytes(s.ocrTextBytes)} of words (${bytes(c.ocrStoredBytes)} stored)`
    + (p.ocrErrors ? `; ${num(p.ocrErrors)} unreadable` : '');

  const lines = [
    'Kosko desktop assist: dry run',
    '',
    `Evernote account User${s.account.userId} (${decodeURIComponent(s.account.host)}), `
      + `database v${s.account.majorVersion} (migration ${s.account.migrationVersion})`,
    row('Notes', num(c.notes), `(${num(c.trashedNotes)} in Evernote's trash, left out)`),
    row('Notebooks', num(c.notebooks), `in ${plural(c.stacks, 'stack', 'stacks')} (a stack becomes a parent notebook)`),
    row('Tags', num(c.tags), `${num(c.noteTags)} note–tag links`),
    row('Attachments', num(c.attachments), attNotes.join(', ')),
    row('OCR', num(c.ocr), ocrNote),
    `  Plain text for every note; ${num(c.emptyPlainText)} empty`
  ];
  if (c.notesWithoutNotebook) {
    const one = c.notesWithoutNotebook === 1;
    lines.push(`  ${num(c.notesWithoutNotebook)} ${one ? 'note is' : 'notes are'} in a Space, not a notebook`);
  }
  if (p.missingFiles || p.sizeMismatch || p.invalidIds || p.ocrErrors) {
    lines.push('  Each problem is listed by note title and file name in the plan\'s "problems".');
  }
  lines.push('');
  if (s.check.passed) {
    lines.push("Count check: passed. Every number above equals a direct count of Evernote's database.");
    lines.push(`Plan saved to ${s.planPath} (${bytes(s.planBytes)})`);
  } else {
    lines.push("COUNT CHECK FAILED: what was read does not match Evernote's database.");
    for (const d of s.check.differences) lines.push(`  ${d}`);
    lines.push('No plan was saved. Please report this; it is a bug in the reader, not in your data.');
    if (s.earlierPlanKept) lines.push('(An earlier kosko-plan.json is still in this folder; it is from a previous run.)');
  }
  if (s.check.passed) {
    lines.push(s.windowsOutsideProfile
      ? 'WARNING: this folder is outside your user folder, so other people who use this computer may be able to read'
        + ' your notes in the plan. Move it into your user folder, or delete it when you are done.'
      : 'The plan holds your notes in clear text, readable only by you. Delete it when you are done.');
  }
  if (s.otherAccounts?.length) {
    lines.push(`Other accounts here: ${s.otherAccounts.map((a) => `User${a.userId} (${bytes(a.dbBytes)})`).join(', ')}; `
      + `run again with --account ${s.otherAccounts[0].userId} to plan one`);
  }
  lines.push('');
  lines.push('Nothing was sent. This version of the tool has no connection to Kosko.');
  lines.push(`Took ${Math.round(s.elapsedMs / 1000)} s.`);
  return `${lines.join('\n')}\n`;
}
