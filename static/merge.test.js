'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {mergeNoteVersions, mergeText} = require('./merge.js');

test('merges independent line edits', () => {
  const result = mergeNoteVersions(
    {title: 'Shopping', tags: 'home', content: 'Milk\nBread\nCall Sam'},
    {title: 'Shopping', tags: 'home', content: 'Milk and eggs\nBread\nCall Sam'},
    {title: 'Shopping list', tags: 'home', content: 'Milk\nBread\nCall Sam'},
  );

  assert.deepEqual(result, {
    title: 'Shopping list',
    tags: 'home',
    content: 'Milk and eggs\nBread\nCall Sam',
  });
});

test('merges independent insertions at different locations', () => {
  assert.equal(
    mergeText('One\nTwo\nThree', 'One\nLocal\nTwo\nThree', 'One\nTwo\nThree\nRemote'),
    'One\nLocal\nTwo\nThree\nRemote',
  );
});

test('merges a deletion with a distant edit', () => {
  assert.equal(
    mergeText('Alpha\nBeta\nGamma\nDelta', 'Alpha\nGamma\nDelta', 'Alpha\nBeta\nGamma\nDelta updated'),
    'Alpha\nGamma\nDelta updated',
  );
});

test('accepts the same edit on both sides', () => {
  const result = mergeNoteVersions(
    {title: 'Before', tags: 'a', content: 'Original'},
    {title: 'After', tags: 'b', content: 'Changed'},
    {title: 'After', tags: 'b', content: 'Changed'},
  );

  assert.deepEqual(result, {title: 'After', tags: 'b', content: 'Changed'});
});

test('keeps one-sided changes when the other side kept the base', () => {
  const result = mergeNoteVersions(
    {title: 'Original', tags: 'work', content: 'First\nSecond'},
    {title: 'Original', tags: 'work, urgent', content: 'First\nSecond'},
    {title: 'Renamed', tags: 'work', content: 'First\nSecond\nThird'},
  );

  assert.deepEqual(result, {
    title: 'Renamed',
    tags: 'work, urgent',
    content: 'First\nSecond\nThird',
  });
});

test('refuses overlapping content changes', () => {
  assert.equal(mergeText('Buy milk', 'Buy milk and eggs', 'Buy oat milk'), null);
});

test('refuses distinct insertions at the same location', () => {
  assert.equal(mergeText('One\nTwo', 'One\nLocal\nTwo', 'One\nRemote\nTwo'), null);
});

test('refuses divergent title or tag changes', () => {
  const base = {title: 'Plan', tags: 'work', content: 'Keep'};
  assert.equal(mergeNoteVersions(base, {...base, title: 'Local plan'}, {...base, title: 'Remote plan'}), null);
  assert.equal(mergeNoteVersions(base, {...base, tags: 'work, local'}, {...base, tags: 'work, remote'}), null);
});

test('preserves a final newline', () => {
  assert.equal(
    mergeText('One\nTwo\n', 'One local\nTwo\n', 'One\nTwo\nThree\n'),
    'One local\nTwo\nThree\n',
  );
});
