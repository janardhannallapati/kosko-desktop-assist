// 466 rules 1-2: the import token (Kosko 438: `cvit_` + 64 hex, 24 hours, revocable, import routes only).
// It is pasted — a hidden prompt when stdin is a terminal — or read from KOSKO_IMPORT_TOKEN. Never a command-line flag:
// a flag lands in the shell's history and in every process listing on the machine. It lives in memory only, and
// redact() runs over every string the tool prints, so a token echoed back in a server's error never reaches the screen.

export const TOKEN_ENV = 'KOSKO_IMPORT_TOKEN';
const TOKEN_RE = /^cvit_[0-9a-f]{64}$/;
// Any cvit_ run, whatever its case or length: what is redacted must be wider than what is accepted.
const ANY_TOKEN_RE = /cvit_[0-9A-Za-z]+/g;

export const redact = (text) => String(text ?? '').replace(ANY_TOKEN_RE, 'cvit_…');

export function checkToken(raw) {
  const token = String(raw ?? '').trim();
  if (!TOKEN_RE.test(token)) {
    // Never repeat the value: someone may have pasted a password into the wrong prompt.
    throw new Error("That isn't an import token. Make one on Kosko's Import page (it starts with cvit_) and paste it.");
  }
  return token;
}

/** The token from KOSKO_IMPORT_TOKEN if set, else from a hidden prompt on a terminal. */
export async function readToken({ env = process.env, stdin = process.stdin, stderr = process.stderr } = {}) {
  if (env[TOKEN_ENV]?.trim()) return checkToken(env[TOKEN_ENV]);
  if (!stdin.isTTY) throw new Error(`No import token: paste one when asked (run in a terminal), or set ${TOKEN_ENV}.`);
  return checkToken(await hiddenPrompt(stdin, stderr));
}

// Raw mode: the terminal hands over each key and echoes nothing. Raw mode is ALWAYS restored, or the person's shell
// stays silent after the tool exits.
function hiddenPrompt(stdin, stderr) {
  stderr.write('Paste your Kosko import token (it will not be shown) and press Enter: ');
  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('close', onEnd);
      try { stdin.setRawMode(false); } catch { /* the terminal went away; nothing to restore */ }
      stdin.pause();
      stderr.write('\n');
      fn(arg);
    };
    const onEnd = () => done(reject, new Error('Cancelled.')); // EOF or a closed terminal never leaves the prompt hanging
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(resolve, value);
        if (ch === '\x03' || ch === '\x04') return done(reject, new Error('Cancelled.'));
        if (ch === '\x7f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    stdin.resume();
  });
}
