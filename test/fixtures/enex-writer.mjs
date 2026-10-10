// Kosko 524 — one Evernote export (.enex) as Evernote 10/11 writes it, from notes given as data. For tests and Kosko's
// ENEX proof only: the tool itself never writes an export.
//
//   enexFile([{ title, created, updated, tags, enml, resources: [{ bytes, mime, fileName }] }]) -> string
//
// `created` and `updated` are milliseconds, written as ENEX's whole-second UTC form (enex-core's formatEnexDate, the
// formatter fp1's identity is computed over). A resource's MD5 is not written: an export carries none, and the reader
// computes it from the bytes, which is exactly what the <en-media hash> in the ENML must name.
import { formatEnexDate } from '@kosko-app/enex-core/enex';

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n';

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// A CDATA section cannot hold "]]>"; split it across two sections, as Evernote does.
const cdata = (s) => `<![CDATA[${String(s).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

function resourceXml({ bytes, mime, fileName }) {
  return '<resource>'
    + `<data encoding="base64">${Buffer.from(bytes).toString('base64')}</data>`
    + `<mime>${esc(mime)}</mime>`
    + (fileName ? `<resource-attributes><file-name>${esc(fileName)}</file-name></resource-attributes>` : '')
    + '</resource>';
}

function noteXml({ title, created, updated, tags = [], enml, resources = [] }) {
  return '<note>'
    + `<title>${esc(title ?? '')}</title>`
    + `<created>${formatEnexDate(created)}</created>`
    + `<updated>${formatEnexDate(updated ?? created)}</updated>`
    + tags.map((t) => `<tag>${esc(t)}</tag>`).join('')
    + '<note-attributes/>'
    + `<content>${cdata(enml)}</content>`
    + resources.map(resourceXml).join('')
    + '</note>';
}

export function enexFile(notes) {
  return `${HEAD}<en-export export-date="20261009T000000Z" application="Evernote" version="10.105.4">\n`
    + notes.map(noteXml).join('\n')
    + '\n</en-export>\n';
}
