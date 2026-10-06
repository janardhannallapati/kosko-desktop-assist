// 467 rules 1-2 — the plan the send step works from, and the counts it checks before sending anything.
// Only a plan the dry run wrote AND checked is sent (457: format kosko-plan, version 1, check.passed). Before the first
// request the account is counted again: if Evernote changed since the dry run, the plan no longer describes it, and
// the receipt could never add up (ADR-0007), so the run stops and says to run the dry run again.
import { readFileSync } from 'node:fs';

// What the receipt compares (465) and what the database is re-counted on. Not the OCR or byte totals: those do not
// reach the receipt in W2, and a re-sync of OCR alone must not block a send.
export const COMPARED = Object.freeze(['notes', 'trashedNotes', 'notebooks', 'stacks', 'tags', 'noteTags', 'attachments']);

export function loadPlan(planPath) {
  let text;
  try { text = readFileSync(planPath, 'utf8'); } catch { throw new Error(`The plan at ${planPath} can't be read. Run dry-run first.`); }
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error(`${planPath} is not a Kosko plan. Run dry-run again.`); }
  if (plan?.format !== 'kosko-plan') throw new Error(`${planPath} is not a Kosko plan. Run dry-run again.`);
  if (plan.version !== 1) throw new Error(`This plan is version ${plan.version}; this tool reads version 1. Run dry-run again.`);
  if (plan.check?.passed !== true) throw new Error('This plan did not pass its own count check, so it is not sent. Run dry-run again.');
  return plan;
}

const num = (n) => Number(n).toLocaleString('en-US');

/** One sentence per count that differs between the plan and the database now; [] when they agree. */
export function countDifferences(planCounts, dbCounts) {
  return COMPARED.filter((k) => planCounts[k] !== dbCounts[k])
    .map((k) => `${k}: the plan has ${num(planCounts[k])}, Evernote now has ${num(dbCounts[k])}`);
}

/** The job's expected counts (465): notes and attachments, and the six structure counts a desktop job may carry. */
export function expectedOf(plan) {
  const c = plan.counts;
  return { notes: c.notes, attachments: c.attachments, notebooks: c.notebooks, stacks: c.stacks, tags: c.tags,
    noteTags: c.noteTags, trashedNotes: c.trashedNotes, missingFiles: plan.problems?.missingFiles?.length ?? 0 };
}
