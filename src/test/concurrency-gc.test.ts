import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SnapshotArchive } from '../index.js';
import { blobPath, deferred, makeSandbox, writeTree } from './helpers.js';
import { pathExists } from '../fs-util.js';

test('queries, restores, and GC remain available while snapshot preparation is blocked', async (t) => {
  const sandbox = await makeSandbox(t);
  const archive = await SnapshotArchive.open(path.join(sandbox, 'archive'));
  const source1 = path.join(sandbox, 'one');
  const source2 = path.join(sandbox, 'two');
  await writeTree(source1, { 'published.txt': 'ready' });
  await writeTree(source2, { 'new.txt': 'being prepared' });

  const v1 = await archive.createSnapshot(source1);
  const preparedEntered = deferred();
  const releasePreparation = deferred();

  const publishPromise = archive.createSnapshot(source2, {
    hooks: {
      beforePublish: () => {
        preparedEntered.resolve();
        return releasePreparation.promise;
      },
    },
  });

  await preparedEntered.promise;

  const list = await archive.listVersions();
  assert.deepEqual(list.map((v) => v.id), [v1.version.id]);

  const restoreWhilePreparing = path.join(sandbox, 'restore-while-preparing');
  const restored = await archive.restoreVersion(v1.version.id, restoreWhilePreparing);
  assert.equal(restored.verified, true);
  assert.equal(await readFile(path.join(restoreWhilePreparing, 'published.txt'), 'utf8'), 'ready');

  const gcDuringPreparation = await archive.gc();
  assert.deepEqual(gcDuringPreparation.removedBlobIds, []);

  releasePreparation.resolve();
  const published = await publishPromise;
  assert.equal(published.version.fileCount, 1);
  assert.equal((await archive.listVersions()).length, 2);

  await archive.close();
});

test('a started restore finishes after eviction and concurrent GC; blob is reclaimed afterwards', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const archive = await SnapshotArchive.open(archiveRoot, { quotaBytes: 8 });

  const source1 = path.join(sandbox, 'old-build');
  const source2 = path.join(sandbox, 'new-build');
  await writeTree(source1, { 'old-map.bin': 'aaaa' }); // 4 bytes
  await writeTree(source2, { 'new-map.bin': 'bbbbbbbb' }); // 8 bytes

  const v1 = await archive.createSnapshot(source1);
  const oldBlobId = v1.version.files[0]!.blobId;
  const target = path.join(sandbox, 'restored-after-eviction');

  const leaseEntered = deferred();
  const releaseRestore = deferred();
  const restorePromise = archive.restoreVersion(v1.version.id, target, {
    hooks: {
      afterLease: () => {
        leaseEntered.resolve();
        return releaseRestore.promise;
      },
    },
  });

  await leaseEntered.promise;

  const replacement = await archive.createSnapshot(source2);
  assert.deepEqual(replacement.evictedVersions.map((v) => v.id), ['v1']);
  assert.equal((await archive.listVersions({ order: 'asc' })).map((v) => v.id).join(','), 'v2');

  const gcWhileRestoreActive = await archive.gc();
  assert.equal(gcWhileRestoreActive.removedBlobIds.includes(oldBlobId), false);
  assert.equal(await pathExists(blobPath(archiveRoot, oldBlobId)), true);

  releaseRestore.resolve();
  const restored = await restorePromise;
  assert.equal(restored.verified, true);
  assert.equal(await readFile(path.join(target, 'old-map.bin'), 'utf8'), 'aaaa');

  const gcAfterRestore = await archive.gc();
  assert.equal(gcAfterRestore.removedBlobIds.includes(oldBlobId), true);
  assert.equal(await pathExists(blobPath(archiveRoot, oldBlobId)), false);

  await archive.close();
});
