import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

export async function makeSandbox(t?: TestContext, prefix = 'snapshot-lab-'): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t?.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export type Tree = Record<string, string | Buffer | Uint8Array>;

export async function writeTree(root: string, tree: Tree): Promise<void> {
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
}

export function projectFixtureRoot(): string {
  // Compiled file is dist/test/helpers.js, so ../../fixtures is <project>/fixtures.
  return fileURLToPath(new URL('../../fixtures/', import.meta.url));
}

export function blobPath(archiveRoot: string, blobId: string): string {
  return path.join(archiveRoot, 'objects', blobId.slice(0, 2), blobId);
}

export function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
