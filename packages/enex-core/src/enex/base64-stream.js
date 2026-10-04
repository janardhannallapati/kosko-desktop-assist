// 253 — a streaming base64 decoder with its size cap inside.
//
//   const d = createBase64Decoder({ maxBytes, onBytes });
//   d.push(textPiece) …   →   d.end()  →  { bytes, problem }
//
// `onBytes(Uint8Array)` receives decoded bytes as they are produced — the reader feeds them straight to an
// incremental MD5 and keeps nothing. A piece may end mid-quantum; up to three characters are carried.
//
// `problem`:
//   null                 decoded completely
//   'empty'              no base64 characters at all (Joplin sees this "semi-frequently" from Web Clipper)
//   'corrupt'            a character outside the standard alphabet, data after padding, padding that does
//                        not complete a quantum, or a lone final character — decoding stops there. An
//                        UNDER-padded tail (`QQ=`) is decoded, not refused: its bytes are unambiguous, and
//                        refusing them would lose an attachment over a formality
//   'too-large-to-read'  the decoded size passed `maxBytes`. Nothing past the cap is emitted; `bytes` is
//                        still the full decoded size, counted from the characters, so the dry run can say
//                        how large it was
//
// `bytes` is the decoded length: exact when problem is null or too-large-to-read, an estimate from the
// characters seen when corrupt.

export const MAX_RESOURCE_BYTES = 1024 * 1024 * 1024;

const INVALID = 255;
const PAD = 254;
const SPACE = 253;
const TABLE = new Uint8Array(256).fill(INVALID);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { TABLE[c.charCodeAt(0)] = i; });
TABLE[61] = PAD; // '='
for (const c of [32, 9, 10, 13]) TABLE[c] = SPACE;

export function createBase64Decoder({ maxBytes = MAX_RESOURCE_BYTES, onBytes = () => {} } = {}) {
  let dataChars = 0; // alphabet characters seen
  let padChars = 0;
  let problem = null;
  let emitted = 0;
  let over = false;
  // carry: up to 3 sextets from an incomplete quantum
  let carry = 0;
  let carryCount = 0;

  function push(text) {
    if (problem === 'corrupt') return;
    const out = over ? null : new Uint8Array(Math.floor((text.length + carryCount) * 3 / 4) + 3);
    let o = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const v = code < 256 ? TABLE[code] : INVALID;
      if (v === SPACE) continue;
      if (v === INVALID) { problem = 'corrupt'; break; }
      if (v === PAD) {
        padChars += 1;
        // Padding is legal only to complete a 2- or 3-sextet final quantum, and only up to 4.
        if ((dataChars % 4) + padChars > 4 || dataChars % 4 < 2) { problem = 'corrupt'; break; }
        continue;
      }
      if (padChars > 0) { problem = 'corrupt'; break; }
      dataChars += 1;
      carry = (carry << 6) | v;
      carryCount += 1;
      if (carryCount === 4) {
        if (out) {
          out[o++] = (carry >> 16) & 255;
          out[o++] = (carry >> 8) & 255;
          out[o++] = carry & 255;
        }
        carry = 0;
        carryCount = 0;
      }
    }
    emit(out, o);
  }

  function emit(out, o) {
    if (!out || o === 0) return;
    if (emitted + o > maxBytes) {
      over = true;
      return;
    }
    emitted += o;
    onBytes(o === out.length ? out : out.subarray(0, o));
  }

  function end() {
    if (problem === null) {
      if (dataChars === 0) problem = 'empty';
      else if (carryCount === 1) problem = 'corrupt';
      else if (carryCount > 1) {
        const out = over ? null : new Uint8Array(2);
        let o = 0;
        if (out) {
          if (carryCount === 2) out[o++] = (carry >> 4) & 255;
          else {
            out[o++] = (carry >> 10) & 255;
            out[o++] = (carry >> 2) & 255;
          }
        }
        emit(out, o);
      }
    }
    const tail = dataChars % 4 === 2 ? 1 : dataChars % 4 === 3 ? 2 : 0;
    const bytes = Math.floor(dataChars / 4) * 3 + tail;
    if (problem === null && over) problem = 'too-large-to-read';
    return { bytes: problem === 'empty' ? 0 : bytes, problem };
  }

  return { push, end };
}
