// An instant as ENEX writes it: `YYYYMMDDTHHMMSSZ`, in UTC, whole seconds.
//
// fp1's identity is a hash of the <created> STRING exactly as an export carries it, so a note read from somewhere
// else (Evernote's local database, its MCP server) can only find its ENEX twin if its time is written in this same
// form. ONE formatter, here, beside the reader that reads the other side.
export function formatEnexDate(ms) {
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString(); // 2020-01-02T03:04:05.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}
