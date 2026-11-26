import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SnapshotArchive } from '../index.js';
import { makeSandbox, writeTree } from './helpers.js';

const childScript = fileURLToPath(new URL('./crash-child.js', import.meta.url));

function runCrashChild(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', childScript, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`crash child timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 20_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('process kill during publication leaves either the old or complete new history', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'v1');
  const source2 = path.join(sandbox, 'v2');
  await writeTree(source1, { 'old.txt': 'aaaa' });
  await writeTree(source2, { 'new.txt': 'bbbbbbbb' });

  const initial = await SnapshotArchive.open(archiveRoot, { quotaBytes: 8 });
  await initial.createSnapshot(source1);
  await initial.close();

  const beforeCommit = await runCrashChild([archiveRoot, source2, 'before-commit']);
  assert.equal(beforeCommit.signal, 'SIGKILL', beforeCommit.stderr);

  let reopened = await SnapshotArchive.open(archiveRoot);
  let versions = await reopened.listVersions({ order: 'asc' });
  assert.deepEqual(versions.map((v) => v.id), ['v1']);
  await reopened.restoreVersion('v1', path.join(sandbox, 'restore-old-after-rollback'));
  await reopened.close();

  const afterCommit = await runCrashChild([archiveRoot, source2, 'after-commit']);
  assert.equal(afterCommit.signal, 'SIGKILL', afterCommit.stderr);

  reopened = await SnapshotArchive.open(archiveRoot);
  versions = await reopened.listVersions({ order: 'asc' });
  // New version visible and quota-selected old version evicted in the same committed transaction.
  assert.deepEqual(versions.map((v) => v.id), ['v2']);
  const restored = await reopened.restoreVersion('v2', path.join(sandbox, 'restore-new-after-commit'));
  assert.equal(restored.verified, true);
  await reopened.close();
});
