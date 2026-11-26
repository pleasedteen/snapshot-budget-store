import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotArchive } from '../index.js';
import { makeSandbox, writeTree } from './helpers.js';

test('publishes new version and evicts earliest unpinned versions in one visible history', async (t) => {
  const sandbox = await makeSandbox(t);
  const root = `${sandbox}/archive`;
  const archive = await SnapshotArchive.open(root, { quotaBytes: 10 });

  const s1 = `${sandbox}/v1`;
  const s2 = `${sandbox}/v2`;
  const s3 = `${sandbox}/v3`;
  await writeTree(s1, { 'old.txt': 'aaaa' }); // 4
  await writeTree(s2, { 'middle.txt': 'bbbbbb' }); // 6; union = 10
  await writeTree(s3, { 'new.txt': 'cc' }); // 2; would be 12

  const v1 = await archive.createSnapshot(s1);
  const v2 = await archive.createSnapshot(s2);
  const result = await archive.createSnapshot(s3);

  assert.deepEqual(result.evictedVersions.map((v) => v.id), [v1.version.id]);
  assert.equal(result.quota.usedBytes, 8); // v2 6 + v3 2

  const visible = await archive.listVersions({ order: 'asc' });
  assert.deepEqual(visible.map((v) => v.id), [v2.version.id, result.version.id]);
  assert.equal(visible.some((v) => v.id === v1.version.id), false);

  // The evicted blob is now unreferenced; GC reclaims exactly those bytes.
  const gc = await archive.gc();
  assert.equal(gc.removedBytes, 4);
  assert.equal(gc.removedBlobIds.includes(v1.version.files[0]!.blobId), true);

  await archive.close();
});

test('quota eviction skips pinned versions', async (t) => {
  const sandbox = await makeSandbox(t);
  const archive = await SnapshotArchive.open(`${sandbox}/archive`, { quotaBytes: 9 });

  const s1 = `${sandbox}/v1`;
  const s2 = `${sandbox}/v2`;
  const s3 = `${sandbox}/v3`;
  await writeTree(s1, { f: 'aaaa' }); // 4 pinned
  await writeTree(s2, { f: 'bbbb' }); // 4
  await writeTree(s3, { f: 'cccc' }); // 4 => 12

  const v1 = await archive.createSnapshot(s1, { pinned: true });
  const v2 = await archive.createSnapshot(s2);
  const v3 = await archive.createSnapshot(s3);

  assert.deepEqual(v3.evictedVersions.map((v) => v.id), [v2.version.id]);
  const ids = (await archive.listVersions({ order: 'asc' })).map((v) => v.id);
  assert.deepEqual(ids, [v1.version.id, v3.version.id]);
  assert.equal((await archive.getVersion(v1.version.id)).pinned, true);

  await archive.close();
});

test('rejects ingestion without changing history when all evictable versions are insufficient', async (t) => {
  const sandbox = await makeSandbox(t);
  const archive = await SnapshotArchive.open(`${sandbox}/archive`, { quotaBytes: 5 });

  const s1 = `${sandbox}/v1`;
  const tooLarge = `${sandbox}/large`;
  await writeTree(s1, { 'small.txt': 'aa' }); // 2
  await writeTree(tooLarge, { 'big.txt': 'bbbbbb' }); // 6 > quota

  const v1 = await archive.createSnapshot(s1);
  await assert.rejects(archive.createSnapshot(tooLarge), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'QUOTA_EXCEEDED');
    return true;
  });

  const versions = await archive.listVersions({ order: 'asc' });
  assert.deepEqual(versions.map((v) => v.id), [v1.version.id]);
  assert.equal((await archive.stats()).usedBytes, 2);

  // Rejection is planned before CAS publication, so the only content is the preserved v1.
  const gc = await archive.gc();
  assert.equal(gc.removedBlobIds.includes(v1.version.files[0]!.blobId), false);
  assert.equal((await archive.listVersions()).length, 1);

  await archive.close();
});

test('pinned content can make a new snapshot impossible and rejection preserves it', async (t) => {
  const sandbox = await makeSandbox(t);
  const archive = await SnapshotArchive.open(`${sandbox}/archive`, { quotaBytes: 5 });

  const s1 = `${sandbox}/pinned`;
  const s2 = `${sandbox}/unpinned`;
  const huge = `${sandbox}/huge`;
  await writeTree(s1, { f: 'aa' }); // 2 pinned
  await writeTree(s2, { f: 'bbb' }); // 3, total 5
  await writeTree(huge, { f: 'cccccc' }); // 6; evict v2 leaves 2+6=8 > 5

  const pinned = await archive.createSnapshot(s1, { pinned: true });
  await archive.createSnapshot(s2);

  await assert.rejects(archive.createSnapshot(huge), { code: 'QUOTA_EXCEEDED' });
  const ids = (await archive.listVersions({ order: 'asc' })).map((v) => v.id);
  assert.deepEqual(ids, [pinned.version.id, 'v2']);
  assert.equal((await archive.stats()).usedBytes, 5);

  await archive.close();
});
