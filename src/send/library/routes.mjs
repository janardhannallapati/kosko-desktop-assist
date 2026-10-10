// 528 rule 1 (Kosko doc 528): what `send` says before it sends anything — both routes into Kosko, every run. The tool
// cannot tell a paid Evernote plan from a free one without signing in (it learns it only when Evernote's MCP server
// refuses a free account), so it names both and says which one THIS run is, never which plan the user has.
export function routePreamble({ evernote, origin }) {
  return [
    'Two ways in, depending on your Evernote plan:',
    '  Paid plan: add --evernote. You sign in to Evernote once and every note arrives formatted.',
    '  Free plan: this run sends every note as plain text. Then export from Evernote and drop',
    `  the files on ${origin}/import: those notes are formatted in place, without copies.`,
    evernote
      ? 'This run: formatted notes from Evernote (--evernote). On a free plan it says so and sends plain text.'
      : 'This run: plain text (no --evernote).'
  ].join('\n');
}
