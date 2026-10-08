// Kosko 510 (desktop assist W4) — one unchanged note must have ONE version on both routes. 461's R5 measured the
// same 150 notes from Evernote's MCP server and from an ENEX export: 0 of 150 bodies byte-identical, 150 of 150
// identical once (a) the XML declaration and DOCTYPE, (b) the export-only hidden `--en-chs` div and (c) trailing
// whitespace are removed (kosko-desktop-assist scripts/r5-explain.mjs). canonicalEnml applies exactly those rules.
import { describe, it, expect } from 'vitest';
import { canonicalEnml } from '../src/canonical-enml.js';

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">\n';
const BODY = '<en-note><div>milk</div><en-media hash="aa" type="image/png"/></en-note>';
const CHS = '<div style="display:none;--en-chs:eyJoMSI6eyJmb250U2l6ZSI6MjR9fQ=="> </div>';
const CHS_ENTITY = '<div style="display:none;--en-chs:eyJoMSI6eyJmb250U2l6ZSI6MjR9fQ==">&#8202;</div>';

describe('canonicalEnml', () => {
  it('an ENEX-shaped body and its MCP-shaped twin canonicalise to the same string (R5 rules a-c)', () => {
    const enex = `${HEADER}<en-note><div>milk</div>${CHS}<en-media hash="aa" type="image/png"/></en-note>\n\n`;
    const mcp = `${BODY}`;
    expect(canonicalEnml(enex)).toBe(canonicalEnml(mcp));
    expect(canonicalEnml(enex)).toBe(BODY);
  });

  it('drops the hidden div whether its hair space is a literal character or the entity', () => {
    expect(canonicalEnml(`<en-note>a${CHS_ENTITY}</en-note>`)).toBe('<en-note>a</en-note>');
    expect(canonicalEnml(`<en-note>a${CHS}</en-note>`)).toBe('<en-note>a</en-note>');
  });

  it('keeps a hidden div that is NOT the --en-chs settings div (benign: real content is never dropped)', () => {
    const own = '<en-note><div style="display:none;">secret note text</div></en-note>';
    expect(canonicalEnml(own)).toBe(own);
    const chsWithText = '<en-note><div style="display:none;--en-chs:abc">visible words</div></en-note>';
    expect(canonicalEnml(chsWithText)).toBe(chsWithText);
  });

  it('changes nothing inside the note: whitespace between and within elements stays', () => {
    const body = '<en-note>\n  <div>a  b</div>\n  <div> c </div>\n</en-note>';
    expect(canonicalEnml(body)).toBe(body);
  });

  it('removes only a LEADING declaration and DOCTYPE, never a DOCTYPE-looking string in the text', () => {
    const body = '<en-note><div>&lt;!DOCTYPE x&gt;</div></en-note>';
    expect(canonicalEnml(`${HEADER}${body}`)).toBe(body);
  });

  it('is idempotent and passes a non-string through as null', () => {
    const once = canonicalEnml(`${HEADER}${BODY}  `);
    expect(canonicalEnml(once)).toBe(once);
    expect(canonicalEnml(null)).toBeNull();
    expect(canonicalEnml(undefined)).toBeNull();
  });
});
