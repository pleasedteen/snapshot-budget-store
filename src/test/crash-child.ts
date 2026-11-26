import { SnapshotArchive } from '../index.js';

const [archiveRoot, sourceDirectory, crashPoint, quota] = process.argv.slice(2) as [
  string | undefined,
  string | undefined,
  'before-commit' | 'after-commit' | undefined,
  string | undefined,
];

if (!archiveRoot || !sourceDirectory || !crashPoint) {
  console.error('usage: crash-child.js <archive-root> <source-dir> <before-commit|after-commit> [quota]');
  process.exit(64);
}

const archive = await SnapshotArchive.open(archiveRoot, {
  crashPoint,
  ...(quota === undefined ? {} : { quotaBytes: Number(quota) }),
});

try {
  const result = await archive.createSnapshot(sourceDirectory, { message: `crash-${crashPoint}` });
  console.log(`PUBLISHED ${result.version.id}`);
  await archive.close();
} catch (error) {
  console.error('CHILD_ERROR', error);
  process.exit(1);
}
