import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ErrorCode, SnapshotError } from './errors.js';

export interface HashedFile {
  blobId: string;
  size: number;
}

export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export interface WalkTreeResult {
  files: string[];
  directories: string[];
}

/** Recursively list files and subdirectories below `root`, following symlinks. */
export async function walkTree(root: string): Promise<WalkTreeResult> {
  const files: string[] = [];
  const directories: string[] = [];
  const visitedDirectories = new Set<string>();

  async function visit(dir: string, isRoot: boolean): Promise<void> {
    const real = await fs.realpath(dir);
    if (visitedDirectories.has(real)) return;
    visitedDirectories.add(real);
    if (!isRoot) directories.push(dir);

    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const stat = await fs.stat(absolute);
      if (stat.isDirectory()) {
        await visit(absolute, false);
      } else if (stat.isFile()) {
        files.push(absolute);
      } else {
        throw new SnapshotError(
          ErrorCode.UnsupportedFileType,
          `不是普通文件或目录，无法按文件字节归档：${absolute}`,
          { path: absolute },
        );
      }
    }
  }

  await visit(root, true);
  files.sort((a, b) => a.localeCompare(b));
  directories.sort((a, b) => a.localeCompare(b));
  return { files, directories };
}

/** Recursively list regular files below `root`, following symlinks to files. */
export async function walkFiles(root: string): Promise<string[]> {
  return (await walkTree(root)).files;
}

/** Hash a file without modifying it. */
export async function hashFile(filePath: string): Promise<HashedFile> {
  const hash = createHash('sha256');
  let size = 0;

  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    hash.update(buffer);
  }

  return { blobId: hash.digest('hex'), size };
}

/** Stream a file to a private destination while calculating its SHA-256. */
export async function hashAndCopyFile(source: string, destination: string): Promise<HashedFile> {
  await ensureDirectory(path.dirname(destination));
  const hash = createHash('sha256');
  let size = 0;

  await pipeline(
    createReadStream(source),
    async function* hashTransform(sourceStream: AsyncIterable<Buffer | string>) {
      for await (const chunk of sourceStream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        hash.update(buffer);
        yield buffer;
      }
    },
    createWriteStream(destination, { flags: 'wx' }),
  );

  await fsyncFile(destination);
  return { blobId: hash.digest('hex'), size };
}

export async function fsyncFile(filePath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    await handle.sync();
  } catch (error) {
    // Some virtual filesystems do not support fsync. Durability tests target local ext4/overlayfs.
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL' && (error as NodeJS.ErrnoException).code !== 'ENOTSUP') {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function fsyncDirectory(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Put a prepared blob into the content-addressed store.
 * A hard link is used on the same filesystem so publication is cheap and the
 * staging directory can be removed without affecting the published blob.
 */
export async function placeBlobFromStage(stagePath: string, blobPath: string): Promise<boolean> {
  await ensureDirectory(path.dirname(blobPath));

  let alreadyExisted = false;
  try {
    await fs.access(blobPath);
    alreadyExisted = true;
    return false;
  } catch {
    alreadyExisted = false;
  }

  const temporaryPath = `${blobPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    try {
      await fs.link(stagePath, temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV' || (error as NodeJS.ErrnoException).code === 'EPERM') {
        await fs.copyFile(stagePath, temporaryPath);
        await fsyncFile(temporaryPath);
      } else {
        throw error;
      }
    }

    await fs.rename(temporaryPath, blobPath);
    await fsyncDirectory(path.dirname(blobPath));
    return true;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export function manifestRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

/** Resolve a manifest path below base, rejecting absolute paths and `..`. */
export function resolveWithin(base: string, manifestPath: string): string {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0 || manifestPath.includes('\0')) {
    throw new SnapshotError(ErrorCode.InvalidPath, `非法相对路径：${String(manifestPath)}`);
  }
  if (path.isAbsolute(manifestPath) || /^[A-Za-z]:[\\/]/.test(manifestPath) || manifestPath.startsWith('\\\\')) {
    throw new SnapshotError(ErrorCode.InvalidPath, `快照路径不能是绝对路径：${manifestPath}`);
  }

  const segments = manifestPath.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new SnapshotError(ErrorCode.InvalidPath, `快照路径不能包含 ..：${manifestPath}`);
    }
  }

  const resolved = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw new SnapshotError(ErrorCode.InvalidPath, `快照路径逃逸出恢复目录：${manifestPath}`);
  }
  return resolved;
}

export function blobPathFor(objectsDirectory: string, blobId: string): string {
  if (!/^[a-f0-9]{64}$/.test(blobId)) {
    throw new SnapshotError(ErrorCode.InvalidPath, `非法内容 ID：${blobId}`);
  }
  return path.join(objectsDirectory, blobId.slice(0, 2), blobId);
}

export async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await directorySize(absolute);
      } else if (entry.isFile()) {
        total += (await fs.stat(absolute)).size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return total;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
