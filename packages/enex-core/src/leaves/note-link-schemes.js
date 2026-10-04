// 246:B2 — the link schemes a note may keep beyond Tiptap's web defaults, and the only place they
// are listed.
//
// Tiptap Link allows http, https, ftp, ftps, mailto, tel, callto, sms, cid and xmpp. A note imported
// from Evernote or OneNote also links to OTHER NOTES in that app, and to files on the author's disk:
//
//   evernote:///view/<user>/<shard>/<note-guid>/<note-guid>/   — Evernote's internal note link
//   onenote:https://…/Section.one#Page&page-id={…}             — OneNote's page link
//   file:///C:/…                                               — a local file
//
// None of them can do anything from a web page. A browser hands evernote: and onenote: to the
// installed app (or does nothing), and refuses to navigate an https page to file: at all. What they
// CAN do is survive, so the import's link-rot rewriter (design-spec §4.4) has a mark to rewrite.
//
// An EXACT scheme match, anchored and followed by `:`, never a prefix: `evernotex:` is not
// `evernote:`, and a prefix match is an allowlist nobody wrote down (222). javascript:, data: and
// vbscript: are not here and cannot match — this widens Tiptap's own check, it never replaces it.
const APP_LINK_SCHEME = /^(?:evernote|onenote|file):/i;

export function isAppLinkScheme(href) {
  return typeof href === 'string' && APP_LINK_SCHEME.test(href.trim());
}

// Passed to Link as `isAllowedUri`, which Tiptap consults at parse AND at render — so a stored
// document written by the importer, which never passes through parseHTML, is covered too.
export function isAllowedNoteLink(url, ctx) {
  return ctx.defaultValidate(url) || isAppLinkScheme(url);
}
