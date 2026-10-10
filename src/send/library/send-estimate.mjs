// 528 — a COPY of Kosko's lib/enex/import-estimate.js (doc 527 rule 4), so the tool's estimate reads exactly as the
// import page's. The tool cannot import Kosko's lib/; the next @kosko-app/enex-core release should take this and both
// repos pin it (doc 528 known issue). Keep the two byte-identical below this header until then.
const MIN = 60_000;
const QUIET_MS = MIN;
const QUIET_SHARE = 0.05;
const WINDOW_MS = 2 * MIN;
// One accepted sample per 10 s, whatever the caller's cadence (the page flushes every 100 ms): the 20 % rise cap and
// the "3 estimates agree" check are per accepted sample, so per 10 s — never compounding per call (review, 2026-10-10).
const SAMPLE_MS = 10_000;
const STABLE_SAMPLES = 3;
const STABLE_RATIO = 1.25;
const SPREAD = 0.2;
const MAX_RISE = 1.2;

const floorStep = (m) => (m > 10 ? Math.floor(m / 5) * 5 : Math.floor(m));
const ceilStep = (m) => (m > 10 ? Math.ceil(m / 5) * 5 : Math.ceil(m));
const nearest = (m) => (m > 10 ? Math.round(m / 5) * 5 : Math.ceil(m));

export function roundRange(low, high) {
  const lo = Math.max(1, floorStep(low));
  return { low: lo, high: Math.max(lo, ceilStep(high)) };
}

// Minutes left from a span of the run: the slower of the two rates. null when neither has moved.
function minutesLeft({ dNotes, dBytes, ms }, { notesLeft, bytesLeft }) {
  if (ms <= 0) return null;
  const byNotes = dNotes > 0 ? (notesLeft / dNotes) * ms : null;
  const byBytes = bytesLeft > 0 && dBytes > 0 ? (bytesLeft / dBytes) * ms : null;
  const slowest = Math.max(byNotes ?? 0, byBytes ?? 0);
  return byNotes === null && byBytes === null ? null : slowest / MIN;
}

export function createEstimator({ totalNotes, totalBytes = 0, now = () => Date.now() }) {
  const samples = [];
  const recent = [];
  let measured = false;
  let shown = null; // the last high (or rough minutes) put on screen
  let last = { kind: 'none' };

  const damp = (m) => (shown === null ? m : Math.min(m, shown * MAX_RISE));

  return {
    samplesKept: () => samples.length,
    sample({ notes, bytes = 0 }) {
      const t = now();
      // While nothing is shown yet every sample counts, so the estimate appears the moment the quiet period ends.
      if (last.kind !== 'none' && t - samples.at(-1).t < SAMPLE_MS) return last;
      samples.push({ t, notes, bytes });
      // Keep the first sample (the overall average) and only what the rolling window can still use.
      while (samples.length > 2 && samples[1].t < t - WINDOW_MS - SAMPLE_MS) samples.splice(1, 1);
      last = this.decide(t, notes, bytes);
      return last;
    },
    decide(t, notes, bytes) {
      const first = samples[0];
      const left = { notesLeft: Math.max(0, totalNotes - notes), bytesLeft: Math.max(0, totalBytes - bytes) };
      if (t - first.t < QUIET_MS || notes < totalNotes * QUIET_SHARE || notes <= 0) return { kind: 'none' };

      const overall = minutesLeft({ dNotes: notes - first.notes, dBytes: bytes - first.bytes, ms: t - first.t }, left);
      // The rolling window: from the oldest sample inside the last 2 minutes, or the newest one before it.
      const inside = samples.filter((s) => s.t >= t - WINDOW_MS && s.t < t);
      const from = inside[0] ?? samples.filter((s) => s.t < t).at(-1);
      const rolling = from ? minutesLeft({ dNotes: notes - from.notes, dBytes: bytes - from.bytes, ms: t - from.t }, left) : null;
      if (rolling !== null && t - first.t >= QUIET_MS) {
        recent.push(rolling);
        if (recent.length > STABLE_SAMPLES) recent.shift();
        if (recent.length === STABLE_SAMPLES && Math.max(...recent) <= STABLE_RATIO * Math.min(...recent)) measured = true;
      }

      const est = measured ? rolling ?? overall : overall;
      if (est === null) return { kind: 'none' };
      if (est * (1 + SPREAD) < 1) return { kind: 'soon' };
      if (!measured) {
        const minutes = nearest(damp(est));
        shown = minutes;
        return { kind: 'rough', minutes };
      }
      const high = damp(est * (1 + SPREAD));
      const range = roundRange(Math.min(est * (1 - SPREAD), high), high);
      shown = range.high;
      return { kind: 'measured', ...range };
    }
  };
}

const minutesWord = (n) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;

export function estimateText(e) {
  if (!e || e.kind === 'none') return null;
  if (e.kind === 'soon') return 'Less than a minute left.';
  if (e.kind === 'rough') return `Roughly ${minutesWord(e.minutes)} left: a first guess from your export’s size.`;
  return e.low === e.high ? `About ${minutesWord(e.high)} left.` : `About ${e.low}–${e.high} minutes left.`;
}
