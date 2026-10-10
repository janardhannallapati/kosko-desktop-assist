// 528 rules 1 and 6 (Kosko doc 528): `send` names both routes before it sends anything, and the README opens with
// them. The tool cannot know the Evernote plan before a sign-in (R5), so it never claims to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routePreamble } from '../src/send/library/routes.mjs';

test('plain run: both routes, the reason, and which one this run is', () => {
  assert.equal(routePreamble({ evernote: false, origin: 'https://kosko.app' }), [
    'Two ways in, depending on your Evernote plan:',
    '  Paid plan: add --evernote. You sign in to Evernote once and every note arrives formatted.',
    '  Free plan: this run sends every note as plain text. Then export from Evernote and drop',
    '  the files on https://kosko.app/import: those notes are formatted in place, without copies.',
    'This run: plain text (no --evernote).'
  ].join('\n'));
});

test('--evernote run: says what happens on a free plan, never which plan this is', () => {
  const text = routePreamble({ evernote: true, origin: 'http://127.0.0.1:3013' });
  assert.match(text, /drop\n {2}the files on http:\/\/127\.0\.0\.1:3013\/import:/);
  assert.match(text, /\nThis run: formatted notes from Evernote \(--evernote\)\. On a free plan it says so and sends plain text\.$/);
  assert.doesNotMatch(text, /your (paid|free) plan/i);
});

test('the README opens with the two routes, before the status section', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const routes = readme.indexOf('## Which route fits your Evernote plan');
  assert.ok(routes > 0, 'the routes section exists');
  assert.ok(routes < readme.indexOf('**Status: early development.**'), 'and comes before the status section');
  assert.match(readme, /Evernote gives formatted notes only on paid plans/);
});
