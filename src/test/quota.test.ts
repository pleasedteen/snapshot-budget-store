import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planQuota, type QuotaVersionLike } from '../quota.js';

function version(id: string, seq: number, size: number, pinned = false): QuotaVersionLike {
  return { id, seq, pinned, blobIds: new Set([`blob-${id}`]) };
}

function sizesFor(...items: Array<[string, number]>): Map<string, number> {
  return new Map(items);
}

test('quota planner keeps everything when quota is unlimited', () => {
  const plan = planQuota({
    versions: [version('v1', 1, 4)],
    nextBlobIds: ['new'],
    blobSizes: sizesFor(['blob-v1', 4], ['new', 100]),
  });
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.evictVersionIds, []);
  assert.equal(plan.afterBytes, 104);
});

test('quota planner evicts earliest unpinned versions until just fitting', () => {
  const versions = [version('v1', 1, 4), version('v2', 2, 6), version('v3', 3, 3)];
  const plan = planQuota({
    quotaBytes: 9,
    versions,
    nextBlobIds: ['new'],
    blobSizes: sizesFor(['blob-v1', 4], ['blob-v2', 6], ['blob-v3', 3], ['new', 2]),
  });

  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.evictVersionIds, ['v1', 'v2']);
  // v3 (3) + new (2) = 5; it stopped as soon as the quota was met.
  assert.equal(plan.afterBytes, 5);
});

test('quota planner skips pinned versions', () => {
  const versions = [version('v1', 1, 4, true), version('v2', 2, 4), version('v3', 3, 2)];
  const plan = planQuota({
    quotaBytes: 8,
    versions,
    nextBlobIds: ['new'],
    blobSizes: sizesFor(['blob-v1', 4], ['blob-v2', 4], ['blob-v3', 2], ['new', 2]),
  });

  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.evictVersionIds, ['v2']);
  assert.equal(plan.afterBytes, 8);
});

test('quota planner reports rejection when all evictable versions are insufficient', () => {
  const versions = [version('v1', 1, 2, true), version('v2', 2, 3)];
  const plan = planQuota({
    quotaBytes: 4,
    versions,
    nextBlobIds: ['huge'],
    blobSizes: sizesFor(['blob-v1', 2], ['blob-v2', 3], ['huge', 9]),
  });

  assert.equal(plan.allowed, false);
  assert.deepEqual(plan.evictVersionIds, ['v2']);
  assert.equal(plan.irreducibleBytes, 11);
});

test('shared blob bytes are counted only once', () => {
  const versions: QuotaVersionLike[] = [
    { id: 'v1', seq: 1, pinned: false, blobIds: new Set(['shared', 'a']) },
    { id: 'v2', seq: 2, pinned: false, blobIds: new Set(['shared', 'b']) },
  ];
  const plan = planQuota({
    quotaBytes: 100,
    versions,
    nextBlobIds: ['shared', 'c'],
    blobSizes: sizesFor(['shared', 8], ['a', 2], ['b', 3], ['c', 4]),
  });

  assert.equal(plan.beforeBytes, 13);
  assert.equal(plan.afterBytes, 17);
});
