import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CorruptionIssue } from './errors.js';
import { blobPathFor, hashFile, resolveWithin } from './fs-util.js';
import type { FileEntry } from './types.js';

/** Group manifest entries by their content-addressed blob ID. */
export function groupFilesByBlob(files: readonly FileEntry[]): Map<string, FileEntry[]> {
  const result = new Map<string, FileEntry[]>();
  for (const file of files) {
    const group = result.get(file.blobId) ?? [];
    group.push(file);
    result.set(file.blobId, group);
  }
  return result;
}

/**
 * Verify every unique blob once. Returning all issues lets the caller report
 * every affected manifest path in one failure instead of stopping at the first.
 */
export async function verifyVersionBlobs(
  objectsDirectory: string,
  files: readonly FileEntry[],
): Promise<CorruptionIssue[]> {
  const grouped = groupFilesByBlob(files);
  const issues: CorruptionIssue[] = [];

  for (const [blobId, blobFiles] of grouped) {
    const affectedPaths = blobFiles.map((file) => file.path).sort();
    const expectedSize = blobFiles[0]?.size ?? 0;
    const blobPath = blobPathFor(objectsDirectory, blobId);

    try {
      const stat = await fs.stat(blobPath);
      if (!stat.isFile()) {
        issues.push({
          code: 'MISSING_BLOB',
          blobId,
          files: affectedPaths,
          message: `内容块不是普通文件：${blobId}`,
        });
        continue;
      }

      const actualSize = stat.size;
      const { blobId: actualHash, size: hashedSize } = await hashFile(blobPath);

      if (expectedSize !== actualSize || expectedSize !== hashedSize) {
        issues.push({
          code: 'SIZE_MISMATCH',
          blobId,
          files: affectedPaths,
          message: `内容块大小不符：期望 ${expectedSize} 字节，实际 ${actualSize} 字节`,
          expected: expectedSize,
          actual: actualSize,
        });
      }

      if (actualHash !== blobId) {
        issues.push({
          code: 'HASH_MISMATCH',
          blobId,
          files: affectedPaths,
          message: `内容块 SHA-256 校验失败：期望 ${blobId}，实际 ${actualHash}`,
          expected: blobId,
          actual: actualHash,
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        issues.push({
          code: 'MISSING_BLOB',
          blobId,
          files: affectedPaths,
          message: `缺少内容块：${blobId}`,
        });
      } else {
        issues.push({
          code: 'READ_ERROR',
          blobId,
          files: affectedPaths,
          message: `读取内容块失败：${(error as Error).message}`,
        });
      }
    }
  }

  return issues;
}

/** Copy already-verified blobs into a private restore staging directory. */
export async function materializeFiles(
  stagingDirectory: string,
  objectsDirectory: string,
  files: readonly FileEntry[],
): Promise<void> {
  for (const entry of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const source = blobPathFor(objectsDirectory, entry.blobId);
    const destination = resolveWithin(stagingDirectory, entry.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);

    if (typeof entry.mode === 'number') {
      const mode = entry.mode & 0o777;
      if (mode !== 0) {
        try {
          await fs.chmod(destination, mode);
        } catch {
          // Permission bits are best-effort; path and byte restoration are guaranteed.
        }
      }
    }
  }
}
