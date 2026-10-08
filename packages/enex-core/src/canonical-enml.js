// Kosko 510 (desktop assist W4) — the ENML a note's VERSION is computed over, so one unchanged note has one version
// whichever route brought it.
//
// 461's R5 fetched the same 150 notes from Evernote's MCP server and from an ENEX export: 0 of 150 bodies were
// byte-identical, and 150 of 150 were identical once three things were removed. Exactly those three, nothing else:
//   (a) a leading XML declaration and DOCTYPE;
//   (b) the export-only hidden settings div, `<div style="display:none;--en-chs:<base64 JSON>">` holding one hair space
//       (U+200A, or its entity `&#8202;`) — Evernote's heading-style settings, not note content;
//   (c) whitespace at either end.
// Whitespace INSIDE the note is content and stays. A hidden div that holds anything but the hair space is the user's,
// and stays. Without this, a note crossing between routes reads as edited and writes a needless note_versions row.
const HEADER = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>)?/;
const SETTINGS_DIV = /<div style="display:none;--en-chs:[^"]*">(?: |&#8202;|&#x200[aA];)<\/div>/g;

export function canonicalEnml(enml) {
  if (typeof enml !== 'string') return null;
  return enml.replace(HEADER, '').replace(SETTINGS_DIV, '').trim();
}
