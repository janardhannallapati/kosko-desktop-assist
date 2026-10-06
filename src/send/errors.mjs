// 466 rule 5: every refusal from Kosko is one of seven kinds, so the sender decides from a kind and never from a
// sentence. `code` is Kosko's (lib/enex/receipt-reasons.js and the ImportError schema in Kosko's openapi.yaml), or
// http_<status> / network / timeout / not_json when there was no code to read.
//
//   busy       429 import_busy        a write slot was not free — wait and resend (433)
//   gate       429 imports_busy       the busy gate at a job start — ask again to keep the place (435)
//   limit      429 too_many_imports   10 starts an hour, 30 a day (382) — stop
//   closed     409 job_closed         the job ended or a newer start continued it — stop
//   auth       401, 403               the token expired, was revoked, or the route is not the token's — stop
//   expired    403 on an upload       the presigned URL's hour is up — mint again (467)
//   invalid    400, 413, other 4xx, a 2xx that is not JSON — stop: the request itself is wrong
//   transient  5xx, a timeout, a network error, a body that could not be read — resend; Kosko's ledger makes every
//              resend idempotent (432)
//   aborted    the run itself was stopped (Ctrl-C) — stop at once, never wait first (466 review M5)

export class ImportApiError extends Error {
  constructor({ status, kind, code, retryAfterSeconds = null, position = null, etaMinutes = null, message }) {
    super(message ?? `Kosko answered ${status || 'nothing'} (${code})`);
    this.name = 'ImportApiError';
    Object.assign(this, { status, kind, code, retryAfterSeconds, position, etaMinutes });
  }
}

/** A run that cannot go on: `message` is one plain sentence for the person, `code` is for the receipt and the log. */
export class SendStopped extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SendStopped';
    this.code = code;
  }
}

export const TOKEN_INVALID = 'This import token is not valid any more — make a new one on Kosko\'s Import page.';

export function kindOf(status, code) {
  if (status === 429) {
    if (code === 'imports_busy') return 'gate';
    if (code === 'too_many_imports') return 'limit';
    return 'busy';
  }
  if (status === 409 && code === 'job_closed') return 'closed';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'transient';
  return 'invalid';
}
