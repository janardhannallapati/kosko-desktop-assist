// 528 rules 2-4 (Kosko doc 528, owner's option B on the 525 decision page): the running lines while `send` works.
//
//   Sent 2,750 of 5,532 notes (50 %): 2,690 created, 50 updated, 10 already in Kosko
//   Now: Work - Clients, notebook 312 of 579 · about 20–25 minutes left
//
// On a terminal the two lines are redrawn in place, at most once a second, and cleared before any other line is
// printed so nothing is overwritten. Into a file or a pipe they are written as plain lines every 30 s and at the end.
// Replaces the old "Sent X of Y notes." per batch (~222 lines for 5,532 notes). The estimate is send-estimate.mjs,
// the same rules and words as Kosko's import page.
import { createEstimator, estimateText } from './send-estimate.mjs';

const REDRAW_MS = 1_000;
const PIPE_MS = 30_000;
const ERASE_TWO = '\r\x1b[2K\x1b[1A\x1b[2K\r'; // clear this line, go up one, clear that one
const num = (n) => Number(n).toLocaleString('en-US');

// Kosko's words, lower-cased to sit after a "·", the rough one marked as a guess the way the page says it.
function estimatePhrase(e) {
  if (!e || e.kind === 'none') return null;
  if (e.kind === 'rough') return `roughly ${e.minutes} ${e.minutes === 1 ? 'minute' : 'minutes'} left (a first guess)`;
  const text = estimateText(e);
  return text.charAt(0).toLowerCase() + text.slice(1, -1);
}

export function progressLines(s, total, estimate) {
  const n = s.notes;
  const pct = total > 0 ? Math.floor((100 * s.settled) / total) : 0;
  const counts = `${num(n.created)} created, ${num(n.updated)} updated, ${num(n.skipped)} already in Kosko`
    + (n.not_imported ? `, ${num(n.not_imported)} not imported` : '');
  const where = s.notebook ? `Now: ${s.notebook.name || 'Untitled notebook'}, notebook ${num(s.notebook.index)} of ${num(s.notebook.count)}` : 'Now: starting';
  const eta = estimatePhrase(estimate);
  return [`Sent ${num(s.settled)} of ${num(total)} notes (${pct} %): ${counts}`, eta ? `${where} · ${eta}` : where];
}

export function createSendProgress({ total, totalBytes = 0, out, now = () => Date.now(), start = { settled: 0, bytes: 0 } }) {
  const estimator = createEstimator({ totalNotes: total, totalBytes, now });
  // The quiet first minute counts from now: what a resumed run already settled is the starting point, not a rate.
  estimator.sample({ notes: start.settled, bytes: start.bytes });
  const tty = Boolean(out.isTTY);
  let drawn = false;
  let lastDraw = -Infinity;
  let lastPipe = now();
  let latest = null;

  // A line wider than the terminal wraps onto a third row the two-line erase cannot reach (review, 2026-10-10), so on
  // a terminal each line is cut to the width it has.
  const fit = (line) => {
    const cols = Number(out.columns) || 0;
    const chars = [...line];
    return cols > 1 && chars.length > cols - 1 ? `${chars.slice(0, cols - 2).join('')}…` : line;
  };
  const draw = (s, estimate) => {
    const [a, b] = progressLines(s, total, estimate);
    if (tty) { out.write(`${drawn ? ERASE_TWO : ''}${fit(a)}\n${fit(b)}`); drawn = true; } else out.write(`${a}\n${b}\n`);
  };

  return {
    update(s) {
      latest = { s, estimate: estimator.sample({ notes: s.settled, bytes: s.bytes ?? 0 }) };
      const t = now();
      if (tty && t - lastDraw >= REDRAW_MS) { lastDraw = t; draw(latest.s, latest.estimate); }
      if (!tty && t - lastPipe >= PIPE_MS) { lastPipe = t; draw(latest.s, latest.estimate); }
    },
    // Before any other line is printed: on a terminal the two lines go, and come back at the next update.
    clear() {
      if (tty && drawn) { out.write(ERASE_TWO); drawn = false; lastDraw = -Infinity; }
    },
    // The final counts always, left on screen as the record of the run, then a fresh line.
    finish(s = latest?.s) {
      if (!s) return;
      draw(s, { kind: 'none' });
      if (tty) out.write('\n');
      drawn = false;
    }
  };
}
