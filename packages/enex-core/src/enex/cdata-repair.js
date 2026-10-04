// 253 — repair a stray CDATA terminator before a strict XML parser sees it.
//
//   const repair = createCdataRepair();
//   parser.write(repair.push(chunk)); … parser.write(repair.end());
//
// WHY. Evernote has exported notes whose <content> CDATA contains a `]]>` that was never meant to end the
// section — a multi-note export from 10.65.3 wrote `]]<![CDATA[>]]>` (obsidian-importer #173), and an
// inner CDATA can end inside the note (`…<![CDATA[x]]></en-note>]]></content>`). XML says the FIRST
// `]]>` ends a section, so a strict parser then meets `</en-note>` with nothing open and abandons the
// file. Every importer we read either buffers the whole file to fix it (and Joplin's fix is commented
// out for running out of memory) or parses leniently and repairs whatever else it likes.
//
// THE RULE. Inside a CDATA section, a `]]>` ends it only when what follows — after at most
// MAX_LOOKAHEAD_WS whitespace characters — is the close tag of the element the section is IN, or another
// `<![CDATA[`. Any other `]]>` is rewritten to `]]]]><![CDATA[>`: the valid XML spelling of those same
// three characters. The parser stays strict, and <content> reads back as the ENML the note held.
//
// THE PROPERTY that makes it safe to run on every file: on a document with no stray terminator the output
// is byte-identical to the input. It never buffers a section — a CDATA's text is emitted as it arrives,
// holding back at most a terminator plus its bounded lookahead.
//
// It tracks just enough XML to know which element a section is in: a stack of open element names, with
// quoted attribute values (which may contain `>`), self-closing tags, comments and processing
// instructions (which may contain `<![CDATA[`) skipped correctly. It is not a validator; `sax` is.

export const MAX_LOOKAHEAD_WS = 1024;
const MAX_STACK = 64;
const MAX_NAME = 256;
const REWRITE = ']]]]><![CDATA[>';
const CDATA_OPEN = '<![CDATA[';

const TEXT = 0;
const TAG = 1;
const CLOSE = 2;
const COMMENT = 3;
const PI = 4;
const DECL = 5;
const CDATA = 6;

const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

export function createCdataRepair() {
  let buf = '';
  let state = TEXT;
  const stack = [];
  let overflow = 0; // opens beyond MAX_STACK, so the element a section is in is unknown
  let name = '';
  let nameDone = false;
  let quote = null;
  let lastSignificant = '';

  const top = () => (overflow > 0 || stack.length === 0 ? null : stack[stack.length - 1]);

  function process(final) {
    let out = '';
    let emitFrom = 0;
    let keep = -1;
    let i = 0;

    scan: while (i < buf.length) {
      switch (state) {
        case TEXT: {
          const lt = buf.indexOf('<', i);
          if (lt === -1) { i = buf.length; break; }
          const tail = buf.slice(lt, lt + CDATA_OPEN.length);
          if (!final && tail.length < CDATA_OPEN.length && (CDATA_OPEN.startsWith(tail) || '<!--'.startsWith(tail))) {
            keep = lt;
            break scan;
          }
          if (tail.startsWith(CDATA_OPEN)) { state = CDATA; i = lt + CDATA_OPEN.length; break; }
          if (tail.startsWith('<!--')) { state = COMMENT; i = lt + 4; break; }
          const c = buf[lt + 1];
          if (c === '?') { state = PI; i = lt + 2; break; }
          if (c === '!') { state = DECL; i = lt + 2; break; }
          if (c === '/') { state = CLOSE; name = ''; nameDone = false; i = lt + 2; break; }
          state = TAG; name = ''; nameDone = false; quote = null; lastSignificant = ''; i = lt + 1;
          break;
        }
        case TAG: {
          const c = buf[i++];
          if (!nameDone) {
            if (isSpace(c) || c === '/' || c === '>') nameDone = true;
            else { if (name.length < MAX_NAME) name += c; break; }
          }
          if (quote) { if (c === quote) quote = null; break; }
          if (c === '"' || c === "'") { quote = c; lastSignificant = c; break; }
          if (c === '>') {
            if (lastSignificant !== '/') {
              if (stack.length < MAX_STACK) stack.push(name);
              else overflow += 1;
            }
            state = TEXT;
            break;
          }
          if (!isSpace(c)) lastSignificant = c;
          break;
        }
        case CLOSE: {
          const c = buf[i++];
          if (c === '>') {
            if (overflow > 0) overflow -= 1;
            else stack.pop();
            state = TEXT;
          }
          break;
        }
        case COMMENT: {
          const end = buf.indexOf('-->', i);
          if (end === -1) { i = buf.length; keep = Math.max(i - 2, 0); break scan; }
          state = TEXT; i = end + 3;
          break;
        }
        case PI: {
          const end = buf.indexOf('?>', i);
          if (end === -1) { i = buf.length; keep = Math.max(i - 1, 0); break scan; }
          state = TEXT; i = end + 2;
          break;
        }
        case DECL: {
          const end = buf.indexOf('>', i);
          if (end === -1) { i = buf.length; break; }
          state = TEXT; i = end + 1;
          break;
        }
        case CDATA: {
          const p = buf.indexOf(']]>', i);
          if (p === -1) { i = buf.length; keep = Math.max(i - 2, 0); break scan; }
          let j = p + 3;
          while (j < buf.length && isSpace(buf[j]) && j - (p + 3) <= MAX_LOOKAHEAD_WS) j++;
          const wsRun = j - (p + 3);
          let terminal;
          if (wsRun > MAX_LOOKAHEAD_WS) {
            terminal = true;
          } else {
            const open = top();
            const closeTag = open === null ? null : `</${open}`;
            const rest = buf.slice(j);
            if (rest.startsWith(CDATA_OPEN)) terminal = true;
            else if (open === null && rest.startsWith('</')) terminal = true;
            else if (closeTag && rest.length > closeTag.length && rest.startsWith(closeTag)) {
              const d = rest[closeTag.length];
              terminal = isSpace(d) || d === '>';
            } else if (!final && (j === buf.length ||
                (rest.length < CDATA_OPEN.length && CDATA_OPEN.startsWith(rest)) ||
                (closeTag && rest.length <= closeTag.length && closeTag.startsWith(rest)) ||
                (open === null && rest === '<'))) {
              keep = p; // the decision needs characters that have not arrived yet
              break scan;
            } else {
              // At end of input a terminator followed by nothing (every string starts with '') — or by the
              // start of what would have decided it — is a truncated file: leave it exactly as written.
              terminal = final && (CDATA_OPEN.startsWith(rest) || (closeTag !== null && closeTag.startsWith(rest)));
            }
          }
          if (terminal) {
            state = TEXT;
            i = p + 3;
          } else {
            out += buf.slice(emitFrom, p) + REWRITE;
            emitFrom = p + 3;
            i = p + 3;
          }
          break;
        }
        default:
          throw new Error('unreachable');
      }
    }

    const cut = keep === -1 || final ? buf.length : Math.max(keep, emitFrom);
    out += buf.slice(emitFrom, cut);
    buf = buf.slice(cut);
    return out;
  }

  return {
    push(chunk) {
      buf += chunk;
      return process(false);
    },
    end() {
      return process(true);
    }
  };
}
