import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SnapshotArchive } from '../index.js';
import { makeSandbox, writeTree } from './helpers.js';

test('creates a snapshot, restores relative paths and bytes, and deduplicates content', async (t) => {
  const sandbox = await makeSandbox(t);
  const source = path.join(sandbox, 'source');
  const archiveRoot = path.join(sandbox, 'archive');
  const restoreTarget = path.join(sandbox, 'restored', 'day-01');

  await writeTree(source, {
    'manifest.json': JSON.stringify({ map: 'cuenca' }),
    'tiles/10/0/0.bin': Buffer.from([0, 1, 2, 3, 255, 254]),
    'tiles/10/0/1.bin': Buffer.from('same-tile-bytes'),
    'copied/1.bin': Buffer.from('same-tile-bytes'),
  });

  const archive = await SnapshotArchive.open(archiveRoot);
  const published = await archive.createSnapshot(source, { message: 'first build' });

  assert.equal(published.version.fileCount, 4);
  assert.equal(published.version.pinned, false);
  assert.equal(published.evictedVersions.length, 0);
  assert.equal(published.version.files.find((f) => f.path === 'tiles/10/0/1.bin')?.blobId,
    published.version.files.find((f) => f.path === 'copied/1.bin')?.blobId);

  const statsAfterFirst = await archive.stats();
  assert.equal(statsAfterFirst.versionCount, 1);
  // "same-tile-bytes" appears in two paths but is one distinct blob.
  assert.equal(statsAfterFirst.referencedBlobCount, 3);
  assert.equal(statsAfterFirst.storedBlobCount, 3);

  const restored = await archive.restoreVersion(published.version.id, restoreTarget);
  assert.equal(restored.verified, true);
  assert.equal(restored.fileCount, 4);

  assert.equal(await readFile(path.join(restoreTarget, 'manifest.json'), 'utf8'), '{"map":"cuenca"}');
  assert.deepEqual(await readFile(path.join(restoreTarget, 'tiles/10/0/0.bin')), Buffer.from([0, 1, 2, 3, 255, 254]));
  assert.equal(
    await readFile(path.join(restoreTarget, 'copied/1.bin'), 'utf8'),
    await readFile(path.join(restoreTarget, 'tiles/10/0/1.bin'), 'utf8'),
  );

  await assert.rejects(archive.restoreVersion(published.version.id, restoreTarget), {
    code: 'TARGET_EXISTS',
  });

  await archive.close();
});

test('preserves explicitly archived empty directories', async (t) => {
  const sandbox = await makeSandbox(t);
  const source = path.join(sandbox, 'source');
  await writeTree(source, { 'non-empty/file.txt': 'x' });
  await mkdir(path.join(source, 'tiles', 'empty-zoom'), { recursive: true });

  const archive = await SnapshotArchive.open(path.join(sandbox, 'archive'));
  const version = await archive.createSnapshot(source);
  assert.deepEqual(version.version.directories.sort(), ['non-empty', 'tiles', 'tiles/empty-zoom']);

  const target = path.join(sandbox, 'restored');
  await archive.restoreVersion(version.version.id, target);
  const stat = await import('node:fs/promises').then((fs) => fs.stat(path.join(target, 'tiles', 'empty-zoom')));
  assert.equal(stat.isDirectory(), true);
  await archive.close();
});

test('lists versions in publication order and persists retention across reopen', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'src1');
  const source2 = path.join(sandbox, 'src2');
  await writeTree(source1, { 'a.txt': 'one' });
  await writeTree(source2, { 'a.txt': 'two-two' });

  const archive = await SnapshotArchive.open(archiveRoot);
  const v1 = await archive.createSnapshot(source1, { message: 'v1' });
  const v2 = await archive.createSnapshot(source2, { message: 'v2' });

  const newestFirst = await archive.listVersions();
  assert.deepEqual(newestFirst.map((v) => v.id), [v2.version.id, v1.version.id]);
  const oldestFirst = await archive.listVersions({ order: 'asc' });
  assert.deepEqual(oldestFirst.map((v) => v.id), [v1.version.id, v2.version.id]);

  const pinned = await archive.setRetention(v1.version.id, true);
  assert.equal(pinned.pinned, true);
  assert.equal((await archive.getVersion(v1.version.id)).pinned, true);

  await archive.close();

  const reopened = await SnapshotArchive.open(archiveRoot);
  const persisted = await reopened.listVersions({ order: 'asc' });
  assert.deepEqual(persisted.map((v) => v.id), ['v1', 'v2']);
  assert.equal(persisted[0]?.pinned, true);
  assert.equal(persisted[1]?.pinned, false);

  const unpinned = await reopened.unpinVersion('v1');
  assert.equal(unpinned.pinned, false);
  await reopened.close();
});

test('cross-version identical content is stored once and restart keeps confirmed history', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'day1');
  const source2 = path.join(sandbox, 'day2');

  await writeTree(source1, {
    'stable.txt': 'do-not-change',
    'day1-only.txt': 'old',
  });
  await writeTree(source2, {
    'stable.txt': 'do-not-change',
    'day2-only.txt': 'new-content',
  });

  let archive = await SnapshotArchive.open(archiveRoot);
  const first = await archive.createSnapshot(source1);
  const second = await archive.createSnapshot(source2);
  const stats = await archive.stats();

  assert.equal(first.version.files.find((f) => f.path === 'stable.txt')?.blobId,
    second.version.files.find((f) => f.path === 'stable.txt')?.blobId);
  // stable + old + new = three distinct blobs, not four.
  assert.equal(stats.referencedBlobCount, 3);
  assert.equal(stats.storedBlobCount, 3);
  assert.equal(stats.usedBytes, Buffer.byteLength('do-not-change') + 3 + 11);

  await archive.close();
  archive = await SnapshotArchive.open(archiveRoot);

  const versions = await archive.listVersions({ order: 'asc' });
  assert.equal(versions.length, 2);
  const restoreTarget = path.join(sandbox, 'restore-after-restart');
  await archive.restoreVersion(second.version.id, restoreTarget);
  assert.equal(await readFile(path.join(restoreTarget, 'stable.txt'), 'utf8'), 'do-not-change');
  assert.equal(await readFile(path.join(restoreTarget, 'day2-only.txt'), 'utf8'), 'new-content');

  const gc = await archive.gc();
  assert.deepEqual(gc.removedBlobIds, []);
  await archive.close();
});
