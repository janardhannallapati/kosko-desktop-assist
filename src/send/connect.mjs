// 466 rule 11 — `kosko-assist connect`: proves the pasted import token works against this Kosko, over real HTTP, and
// writes nothing — GET /api/import/allowance is its only request. Prints the space used and left, the number the
// person needs before sending a whole account.
import { createImportApi, appOrigin } from './api.mjs';
import { ImportApiError, TOKEN_INVALID } from './errors.mjs';
import { readToken, redact } from './token.mjs';

const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

export async function runConnect({ app, env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, fetch } = {}) {
  try {
    const origin = appOrigin(app);
    const token = await readToken({ env, stdin, stderr });
    const a = await createImportApi({ app: origin, token, fetch }).allowance();
    // A JSON answer that is not an allowance (a proxy, a captive page) proves nothing about the token (466 review M7).
    if (!Number.isInteger(a?.byteLimit) || !Number.isInteger(a?.bytesUsed)) {
      stderr.write(`The answer from ${origin} isn't Kosko's. Check the address (--app).\n`);
      return 1;
    }
    const left = Math.max(0, a.byteLimit - a.bytesUsed);
    stdout.write(`Connected to ${origin}. Storage: ${size(a.bytesUsed)} of ${size(a.byteLimit)} used, ${size(left)} left.\n`);
    return 0;
  } catch (e) {
    const sentence = e instanceof ImportApiError
      ? (e.kind === 'auth' ? TOKEN_INVALID : `Kosko could not be asked just now (${e.code}). Try again in a minute.`)
      : e.message;
    stderr.write(`${redact(sentence)}\n`);
    return 1;
  }
}
