import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SnapshotArchive, SnapshotCorruptionError } from '../index.js';
import { blobPath, makeSandbox, writeTree } from './helpers.js';
import { pathExists } from '../fs-util.js';

test('reports every file affected by corruption, refuses delivery, and keeps healthy versions restorable', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const archive = await SnapshotArchive.open(archiveRoot);

  const source1 = path.join(sandbox, 'corrupt-candidate');
  const source2 = path.join(sandbox, 'healthy');
  const badBytes = Buffer.from('bad-tile!'); // 9 bytes
  await writeTree(source1, {
    'tiles/1/0/0.mvt': badBytes,
    'tiles/duplicate.mvt': badBytes,
    'good.txt': 'fine',
  });
  await writeTree(source2, {
    'manifest.json': '{"healthy":true}',
    'tiles/new.mvt': Buffer.from('healthy-bytes'),
  });

  const badVersion = await archive.createSnapshot(source1);
  const healthyVersion = await archive.createSnapshot(source2);
  const badBlobId = badVersion.version.files.find((f) => f.path === 'tiles/1/0/0.mvt')!.blobId;

  // Simulate bit rot / interrupted external overwrite while preserving length.
  await writeFile(blobPath(archiveRoot, badBlobId), Buffer.from('X'.repeat(badBytes.length)));

  const verification = await archive.verifyVersion(badVersion.version.id);
  assert.equal(verification.healthy, false);
  assert.equal(verification.issues[0]?.code, 'HASH_MISMATCH');
  assert.deepEqual(verification.affectedFiles, ['tiles/1/0/0.mvt', 'tiles/duplicate.mvt']);

  const badRestoreTarget = path.join(sandbox, 'should-not-exist');
  await assert.rejects(archive.restoreVersion(badVersion.version.id, badRestoreTarget), (error: unknown) => {
    assert.ok(error instanceof SnapshotCorruptionError);
    assert.equal(error.code, 'SNAPSHOT_CORRUPT');
    assert.deepEqual(error.affectedFiles, ['tiles/1/0/0.mvt', 'tiles/duplicate.mvt']);
    return true;
  });
  assert.equal(await pathExists(badRestoreTarget), false);

  const parentEntries = await import('node:fs/promises').then((fs) => fs.readdir(sandbox));
  assert.equal(parentEntries.some((name) => name.includes('.restore-')), false);

  const healthyTarget = path.join(sandbox, 'healthy-restored');
  const restored = await archive.restoreVersion(healthyVersion.version.id, healthyTarget);
  assert.equal(restored.verified, true);
  assert.equal(await readFile(path.join(healthyTarget, 'manifest.json'), 'utf8'), '{"healthy":true}');

  // GC must retain referenced-but-corrupt blobs; the failure is repairable by a future snapshot.
  const gc = await archive.gc();
  assert.equal(gc.removedBlobIds.includes(badBlobId), false);

  await archive.close();
});

test('reports a missing blob as affected files without delivering a partial restore', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const archive = await SnapshotArchive.open(archiveRoot);
  const source = path.join(sandbox, 'source');
  await writeTree(source, { 'a.txt': 'a', 'nested/b.txt': 'bb' });

  const version = await archive.createSnapshot(source);
  const blobA = version.version.files.find((f) => f.path === 'a.txt')!.blobId;
  const target = path.join(sandbox, 'missing-blob-restore');

  await import('node:fs/promises').then((fs) => fs.rm(blobPath(archiveRoot, blobA), { force: true }));

  await assert.rejects(archive.restoreVersion(version.version.id, target), (error: unknown) => {
    assert.ok(error instanceof SnapshotCorruptionError);
    const issue = error.issues.find((item) => item.blobId === blobA);
    assert.equal(issue?.code, 'MISSING_BLOB');
    assert.deepEqual(error.affectedFiles, ['a.txt']);
    return true;
  });
  assert.equal(await pathExists(target), false);

  await archive.close();
});
