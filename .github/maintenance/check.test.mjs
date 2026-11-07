import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, followupChanges, summarizeActivity, verdictFor } from './check.mjs';

test('unchanged waiting work does not wake repeated maintenance', () => {
  const pending = [{ kind: 'open_pr', url: 'https://github.com/a/b/pull/1', head: 'a', fingerprint: 'same' }];
  const changes = followupChanges(pending, structuredClone(pending));
  assert.deepEqual(changes, []);
  assert.equal(verdictFor({}, [], changes, []), 'NO_CHANGE');
});

test('new comments, edits, reviews, checks and heads trigger follow-up', () => {
  const original = { comments: [{ body: 'old', author: { login: 'contributor' } }], headRefOid: 'a' };
  const before = { kind: 'open_pr', url: 'https://github.com/a/b/pull/1', ...summarizeActivity(original) };
  for (const patch of [
    { comments: [...original.comments, { body: 'fixed' }] },
    { comments: [{ ...original.comments[0], body: 'edited' }] },
    { reviews: [{ state: 'CHANGES_REQUESTED' }] },
    { statusCheckRollup: [{ conclusion: 'FAILURE' }] },
    { headRefOid: 'b' },
  ]) {
    const after = { ...before, ...summarizeActivity({ ...original, ...patch }) };
    assert.equal(followupChanges([before], [after]).length, 1);
  }
});

test('closed own items and upstream state changes remain visible', () => {
  const item = { kind: 'tracked_upstream', url: 'https://github.com/a/b/pull/1', state: 'OPEN' };
  assert.equal(followupChanges([item], [{ ...item, state: 'MERGED' }])[0].kind, 'followup_changed');
  assert.equal(followupChanges([item], [])[0].kind, 'followup_closed');
});

test('a waiting item becomes actionable when its review date arrives', () => {
  const item = { kind: 'state_pending', id: 'registry-bump', due: false };
  assert.equal(followupChanges([item], [{ ...item, due: true }]).length, 1);
});

test('source errors win over no changes and pending work', () => {
  assert.equal(verdictFor({}, [], [], ['GitHub unavailable']), 'ERROR');
  assert.equal(verdictFor({}, [], [{}], ['npm unavailable']), 'ERROR');
  assert.equal(verdictFor(null, [], [], []), 'REVIEW');
  assert.equal(verdictFor({}, [{}], [], []), 'REVIEW');
  assert.equal(verdictFor({}, [], [{}], []), 'PENDING_FOLLOWUP');
});

test('npm next and published integrity changes are independently detected', () => {
  const before = { npm: { dsh: { distTags: { latest: '1', next: '1' }, versions: { '1': 'old' } } } };
  const after = { npm: { dsh: { distTags: { latest: '1', next: '2' }, versions: { '1': 'new', '2': 'second' } } } };
  const changes = compare(before, after);
  assert.ok(changes.some((c) => c.kind === 'dist_tag' && c.tag === 'next'));
  assert.ok(changes.some((c) => c.kind === 'version_added' && c.version === '2'));
  assert.ok(changes.some((c) => c.kind === 'version_integrity_changed' && c.version === '1'));
});

test('release page rollover is not treated as an upstream deletion', () => {
  const old = { publishedAt: '2026-01-01T00:00:00Z', tag: 'v1' };
  const recent = { publishedAt: '2026-02-01T00:00:00Z', tag: 'v2' };
  assert.deepEqual(compare({ github: { repo: { old, recent } } }, { github: { repo: { recent } } }), []);
});
