// 467 rules 3-5 — the account's structure as Kosko will hold it: notebooks under their stacks, one notebook per Space
// for notes that have no notebook, and every tag named by its full path.
//
// Notebook keys are stable strings the notebooks route answers ids for: `stack:<name>`, `nb:<Evernote id>`,
// `space:<Space id>` and `space:none`. Kosko refuses two siblings with one folded name (lower(btrim()), 20260921000000),
// so siblings that would collide are numbered here — the user's own notebooks keep their names first, then stacks,
// then the Space notebooks this tool makes up.

export const NO_NOTEBOOK = 'Evernote — no notebook';
const MAX_NOTEBOOKS = 2000; // the notebooks route's limit per call (380)
const fold = (s) => String(s).trim().toLowerCase();

/** Space id → the name its notebook gets: two Spaces with one name become "Work", "Work (2)", oldest first. */
const byAge = (spaces) => [...spaces].sort((a, b) => (a.created - b.created) || String(a.id).localeCompare(String(b.id)));

export function spaceNames(spaces = []) {
  const seen = new Map();
  const out = new Map();
  for (const s of byAge(spaces)) {
    const name = String(s.name ?? '').trim() || NO_NOTEBOOK;
    const n = (seen.get(fold(name)) ?? 0) + 1;
    seen.set(fold(name), n);
    out.set(s.id, n === 1 ? name : `${name} (${n})`);
  }
  return out;
}

export function notebookPlan(plan) {
  const names = spaceNames(plan.spaces ?? []);
  const spaceKeyOf = (note) => (note.workspaceId && names.has(note.workspaceId) ? `space:${note.workspaceId}` : 'space:none');
  const parentKeyOf = (note) => (note.notebookId ? `nb:${note.notebookId}` : spaceKeyOf(note));

  const entries = [
    ...plan.stacks.map((s) => ({ key: `stack:${s.name}`, name: String(s.name).trim(), parent_key: null, rank: 1 })),
    ...plan.notebooks.map((n) => ({ key: `nb:${n.id}`, name: String(n.name).trim(), parent_key: n.stack ? `stack:${n.stack}` : null, rank: 0 }))
  ];
  // Oldest Space first, the fallback notebook last — a stable order, so a re-run sends the same list and the older of
  // two same-named Spaces keeps the plainer name. Each takes its own name; the numbering below tells them apart.
  const used = new Set(plan.notes.filter((n) => !n.notebookId).map(spaceKeyOf));
  for (const sp of byAge(plan.spaces ?? [])) {
    if (used.has(`space:${sp.id}`)) entries.push({ key: `space:${sp.id}`, name: String(sp.name ?? '').trim() || NO_NOTEBOOK, parent_key: null, rank: 2 });
  }
  if (used.has('space:none')) entries.push({ key: 'space:none', name: NO_NOTEBOOK, parent_key: null, rank: 2 });
  if (entries.length > MAX_NOTEBOOKS) {
    throw new Error(`This account has ${entries.length.toLocaleString('en-US')} notebooks and stacks; Kosko takes 2,000 in one import. Nothing was sent.`);
  }
  // Siblings that would share a folded name: each takes the first free of "Name", "Name (2)", "Name (3)" … in rank
  // order (the user's notebooks keep theirs), checked against EVERY name already taken — a numbered name can itself
  // collide with a real one ("Work (2)" from a Space against a Space named "Work (2)").
  const taken = new Set(); // parent|folded
  for (const e of [...entries].sort((a, b) => a.rank - b.rank)) {
    let name = e.name;
    for (let n = 2; taken.has(`${e.parent_key}|${fold(name)}`); n++) name = `${e.name} (${n})`;
    taken.add(`${e.parent_key}|${fold(name)}`);
    e.name = name;
  }
  return { entries: entries.map(({ rank, ...e }) => e), parentKeyOf };
}

/** Tag id → its full path, `parent/child` (owner decision 2026-10-06); a cycle or a lost parent never loops. */
export function tagPaths(tags) {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const out = new Map();
  for (const t of tags) {
    const parts = [String(t.name)];
    const seen = new Set([t.id]);
    let p = byId.get(t.parentId);
    while (p && !seen.has(p.id) && parts.length < 10) {
      parts.unshift(String(p.name));
      seen.add(p.id);
      p = byId.get(p.parentId);
    }
    out.set(t.id, parts.join('/'));
  }
  return out;
}

/** Note id → the full names of its tags, in the plan's link order; a link to an unknown tag is left out. */
export function noteTagNames(noteTags, paths) {
  const out = new Map();
  for (const { noteId, tagId } of noteTags) {
    if (!paths.has(tagId)) continue;
    if (!out.has(noteId)) out.set(noteId, []);
    out.get(noteId).push(paths.get(tagId));
  }
  return out;
}
