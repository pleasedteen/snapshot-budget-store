import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SnapshotArchive } from '../index.js';
import { blobPath, makeSandbox, writeTree } from './helpers.js';
import { pathExists } from '../fs-util.js';

const workerScript = fileURLToPath(new URL('./xproc-worker.js', import.meta.url));
const crashChildScript = fileURLToPath(new URL('./crash-child.js', import.meta.url));

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: any;
  error?: { name?: string; message: string; code?: string };
}

interface BarrierWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** JSON-lines client for one real child process running xproc-worker.js. */
class WorkerClient {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private readonly barriers = new Map<string, BarrierWaiter>();
  private stdoutBuffer = '';
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Warnings/noise are buffered only for failure diagnostics.
      this.stderr += chunk;
    });
    child.on('close', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`worker exited before replying (code=${code} signal=${signal})`));
      }
      this.pending.clear();
      for (const [token, waiter] of this.barriers) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`worker exited while waiting for barrier ${token}`));
        this.barriers.delete(token);
      }
    });
  }

  stderr = '';

  static spawn(archiveRoot: string): WorkerClient {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', workerScript, archiveRoot],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return new WorkerClient(child);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.event === 'barrier' && typeof message.token === 'string') {
        const waiter = this.barriers.get(message.token);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.barriers.delete(message.token);
          waiter.resolve();
        }
        continue;
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        pending.resolve(message as WorkerResponse);
      }
    }
  }

  request(command: Record<string, unknown>): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  async open(options?: Record<string, unknown>): Promise<void> {
    const response = await this.request({ cmd: 'open', options });
    assert.equal(response.ok, true, response.error?.message);
  }

  waitForBarrier(token: string, timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.barriers.delete(token);
        reject(new Error(`timed out waiting for barrier ${token}\nstderr: ${this.stderr}`));
      }, timeoutMs);
      this.barriers.set(token, { resolve, reject, timer });
    });
  }

  async release(token: string): Promise<void> {
    await this.request({ cmd: 'release', token });
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.exitSignal !== null) return;
    await new Promise<void>((resolve) => {
      this.child.once('close', () => resolve());
      this.child.kill('SIGKILL');
    });
  }

  async closeGracefully(): Promise<void> {
    try {
      await this.request({ cmd: 'close' });
    } catch {
      // Child may already be gone.
    }
    if (this.child.exitCode === null && this.exitSignal === null) {
      await new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    }
  }
}

async function listStagingIds(archiveRoot: string): Promise<string[]> {
  try {
    return await readdir(path.join(archiveRoot, 'staging'));
  } catch {
    return [];
  }
}

test('subprocess: query, restore and GC proceed while another process prepares a snapshot', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'one');
  const source2 = path.join(sandbox, 'two');
  await writeTree(source1, { 'published.txt': 'ready-content' });
  await writeTree(source2, { 'new.txt': 'being prepared across processes' });

  const parent = await SnapshotArchive.open(archiveRoot);
  const v1 = await parent.createSnapshot(source1);

  const worker = WorkerClient.spawn(archiveRoot);
  await worker.open();

  const barrier = worker.waitForBarrier('prep');
  const publishResponse = worker.request({
    cmd: 'publish',
    source: source2,
    barrier: 'beforePublish',
    token: 'prep',
  });
  await barrier;

  // Another process (this test process) can query, restore and GC.
  const list = await parent.listVersions();
  assert.deepEqual(list.map((v) => v.id), [v1.version.id]);

  const restoreWhilePreparing = path.join(sandbox, 'restore-while-preparing');
  const restored = await parent.restoreVersion(v1.version.id, restoreWhilePreparing);
  assert.equal(restored.verified, true);
  assert.equal(
    await readFile(path.join(restoreWhilePreparing, 'published.txt'), 'utf8'),
    'ready-content',
  );

  const stagingBeforeGc = await listStagingIds(archiveRoot);
  assert.equal(stagingBeforeGc.length, 1);

  const gc = await parent.gc();
  assert.deepEqual(gc.removedBlobIds, []);
  assert.deepEqual(gc.removedStagingDirs, []);
  // The live subprocess staging directory is protected.
  const stagingAfterGc = await listStagingIds(archiveRoot);
  assert.deepEqual(stagingAfterGc, stagingBeforeGc);

  await worker.release('prep');
  const response = await publishResponse;
  assert.equal(response.ok, true, response.error?.message);
  assert.equal(response.result.version.fileCount, 1);

  const versions = await parent.listVersions();
  assert.equal(versions.length, 2);
  const restoreV2 = path.join(sandbox, 'restore-v2');
  await parent.restoreVersion(response.result.version.id, restoreV2);
  assert.equal(
    await readFile(path.join(restoreV2, 'new.txt'), 'utf8'),
    'being prepared across processes',
  );

  await worker.closeGracefully();
  await parent.close();
});

test('subprocess: blocked restore reads original after cross-process eviction and GC', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'old-build');
  const source2 = path.join(sandbox, 'new-build');
  await writeTree(source1, { 'old-map.bin': 'aaaa' });
  await writeTree(source2, { 'new-map.bin': 'bbbbbbbb' });

  const parent = await SnapshotArchive.open(archiveRoot, { quotaBytes: 8 });
  const v1 = await parent.createSnapshot(source1);
  const oldBlobId = v1.version.files[0]!.blobId;

  const worker = WorkerClient.spawn(archiveRoot);
  await worker.open();

  const target = path.join(sandbox, 'restored-by-child');
  const barrier = worker.waitForBarrier('lease');
  const restoreResponse = worker.request({
    cmd: 'restore',
    version: v1.version.id,
    target,
    barrier: 'afterLease',
    token: 'lease',
  });
  await barrier;

  // A different process publishes under quota and evicts v1.
  const replacement = await parent.createSnapshot(source2);
  assert.deepEqual(replacement.evictedVersions.map((v) => v.id), ['v1']);

  const gcWhileActive = await parent.gc();
  assert.equal(gcWhileActive.removedBlobIds.includes(oldBlobId), false);
  assert.equal(await pathExists(blobPath(archiveRoot, oldBlobId)), true);

  await worker.release('lease');
  const response = await restoreResponse;
  assert.equal(response.ok, true, response.error?.message);
  assert.equal(response.result.verified, true);
  assert.equal(await readFile(path.join(target, 'old-map.bin'), 'utf8'), 'aaaa');

  // Once the cross-process operation has ended, the unreferenced blob is reclaimed.
  const gcAfter = await parent.gc();
  assert.equal(gcAfter.removedBlobIds.includes(oldBlobId), true);
  assert.equal(await pathExists(blobPath(archiveRoot, oldBlobId)), false);

  await worker.closeGracefully();
  await parent.close();
});

test('subprocess: GC after SIGKILLed publisher reaps its staging while protecting a live publisher', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'one');
  const sourceA = path.join(sandbox, 'a');
  const sourceB = path.join(sandbox, 'b');
  await writeTree(source1, { 'base.txt': 'base' });
  await writeTree(sourceA, { 'a.txt': 'aaaaaaaa' });
  await writeTree(sourceB, { 'b.txt': 'bbbbbbbbbb' });

  const parent = await SnapshotArchive.open(archiveRoot);
  await parent.createSnapshot(source1);

  const workerA = WorkerClient.spawn(archiveRoot);
  const workerB = WorkerClient.spawn(archiveRoot);
  await Promise.all([workerA.open(), workerB.open()]);

  const barrierA = workerA.waitForBarrier('a');
  const publishA = workerA
    .request({ cmd: 'publish', source: sourceA, barrier: 'beforePublish', token: 'a' })
    .then(
      (result) => ({ ok: true as const, result }),
      (error: Error) => ({ ok: false as const, error }),
    );
  await barrierA;

  const barrierB = workerB.waitForBarrier('b');
  const publishB = workerB.request({ cmd: 'publish', source: sourceB, barrier: 'beforePublish', token: 'b' });
  await barrierB;

  const stagingBefore = await listStagingIds(archiveRoot);
  assert.equal(stagingBefore.length, 2);

  // Strong-kill publisher A while it is blocked before commit.
  await workerA.kill();
  const publishAResponse = await publishA;
  assert.equal(publishAResponse.ok, false);

  const gc = await parent.gc();
  assert.equal(gc.removedStagingDirs.length, 1);
  const stagingAfterGc = await listStagingIds(archiveRoot);
  assert.equal(stagingAfterGc.length, 1);
  // GC removed exactly one of the two staging directories.
  assert.equal(stagingBefore.filter((id) => !stagingAfterGc.includes(id)).length, 1);

  // No lease left for the dead process; exactly the live worker's lease remains.
  const leaseFiles = await readdir(path.join(archiveRoot, 'leases'));
  assert.equal(leaseFiles.length, 1);

  // The still-running publisher B's staging survived and it can publish.
  await workerB.release('b');
  const responseB = await publishB;
  assert.equal(responseB.ok, true, responseB.error?.message);

  const ids = (await parent.listVersions({ order: 'asc' })).map((v) => v.id);
  assert.deepEqual(ids, ['v1', 'v2']);

  const restoreB = path.join(sandbox, 'restore-b');
  await parent.restoreVersion(responseB.result.version.id, restoreB);
  assert.equal(await readFile(path.join(restoreB, 'b.txt'), 'utf8'), 'bbbbbbbbbb');

  // Published base version is intact.
  const restoreBase = path.join(sandbox, 'restore-base');
  await parent.restoreVersion('v1', restoreBase);

  await workerB.closeGracefully();
  await parent.close();
});

test('subprocess: GC after SIGKILLed restorer reclaims its blob but protects another live restore', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'old');
  const source2 = path.join(sandbox, 'new');
  await writeTree(source1, { 'old-map.bin': 'aaaa' });
  await writeTree(source2, { 'new-map.bin': 'bbbbbbbb' });

  const parent = await SnapshotArchive.open(archiveRoot, { quotaBytes: 8 });
  const v1 = await parent.createSnapshot(source1);
  const oldBlobId = v1.version.files[0]!.blobId;

  const workerA = WorkerClient.spawn(archiveRoot);
  const workerB = WorkerClient.spawn(archiveRoot);
  await Promise.all([workerA.open(), workerB.open()]);

  const targetA = path.join(sandbox, 'restore-A');
  const targetB = path.join(sandbox, 'restore-B');

  const barrierA = workerA.waitForBarrier('ra');
  const restoreA = workerA
    .request({ cmd: 'restore', version: 'v1', target: targetA, barrier: 'afterLease', token: 'ra' })
    .then(
      () => ({ ok: true as const }),
      () => ({ ok: false as const }),
    );
  await barrierA;

  const barrierB = workerB.waitForBarrier('rb');
  const restoreB = workerB.request({ cmd: 'restore', version: 'v1', target: targetB, barrier: 'afterLease', token: 'rb' });
  await barrierB;

  // Evict v1 and run GC with both restores active: blob must survive.
  await parent.createSnapshot(source2);
  let gc = await parent.gc();
  assert.equal(gc.removedBlobIds.includes(oldBlobId), false);

  // Kill restorer A. Its lease becomes dead; B remains live.
  await workerA.kill();
  await restoreA;

  gc = await parent.gc();
  assert.equal(gc.removedBlobIds.includes(oldBlobId), false, 'live restorer B still protects the blob');
  assert.equal(await pathExists(blobPath(archiveRoot, oldBlobId)), true);
  const leaseFiles = await readdir(path.join(archiveRoot, 'leases'));
  assert.equal(leaseFiles.length, 1);

  // B completes its read of the original bytes.
  await workerB.release('rb');
  const responseB = await restoreB;
  assert.equal(responseB.ok, true, responseB.error?.message);
  assert.equal(await readFile(path.join(targetB, 'old-map.bin'), 'utf8'), 'aaaa');

  gc = await parent.gc();
  assert.equal(gc.removedBlobIds.includes(oldBlobId), true);

  await workerB.closeGracefully();
  await parent.close();
});

test('subprocess: quota admission respects retention marker committed by another process', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const pinnedSource = path.join(sandbox, 'pinned');
  const bigSource = path.join(sandbox, 'big');
  await writeTree(pinnedSource, { 'pinned.txt': 'aa' }); // 2 bytes
  await writeTree(bigSource, { 'big.txt': 'bbbbbb' }); // 6 bytes

  const parent = await SnapshotArchive.open(archiveRoot, { quotaBytes: 5 });
  await parent.createSnapshot(pinnedSource); // v1 = 2 bytes

  const worker = WorkerClient.spawn(archiveRoot);
  await worker.open();

  // Another process commits the retention marker before admission planning.
  const pin = await worker.request({ cmd: 'setRetention', version: 'v1', retained: true });
  assert.equal(pin.ok, true, pin.error?.message);
  assert.equal(pin.result.pinned, true);

  // Give WAL readers a moment; the publishing connection must observe the
  // already-committed marker without being reopened.
  await new Promise((resolve) => setTimeout(resolve, 25));

  // 2 pinned + 6 > 5 and the pinned version cannot be evicted: reject in the
  // parent process, which did not perform the pin.
  await assert.rejects(parent.createSnapshot(bigSource), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'QUOTA_EXCEEDED');
    return true;
  });

  const ids = (await parent.listVersions({ order: 'asc' })).map((v) => v.id);
  assert.deepEqual(ids, ['v1']);
  assert.equal((await parent.stats()).usedBytes, 2);

  await worker.closeGracefully();
  await parent.close();
});

test('subprocess: concurrent publishers and GC workers leave a complete restorable history', { timeout: 60_000 }, async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');

  const parent = await SnapshotArchive.open(archiveRoot);
  await parent.close();

  const workerCount = 3;
  const workers: WorkerClient[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    const worker = WorkerClient.spawn(archiveRoot);
    await worker.open();
    workers.push(worker);
  }
  const gcWorker = WorkerClient.spawn(archiveRoot);
  await gcWorker.open();

  // Continuously request GC from a fourth real process.
  let gcStopped = false;
  let gcLoopError: unknown;
  const gcLoop = (async () => {
    while (!gcStopped) {
      try {
        const response = await gcWorker.request({ cmd: 'gc' });
        if (!response.ok && !/exited/.test(response.error?.message ?? '')) {
          throw new Error(response.error?.message ?? 'gc failed');
        }
      } catch (error) {
        if (!gcStopped) gcLoopError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();

  const roundsPerWorker = 3;
  const publishTasks: Promise<WorkerResponse>[] = [];
  for (let w = 0; w < workerCount; w += 1) {
    for (let round = 0; round < roundsPerWorker; round += 1) {
      const source = path.join(sandbox, `src-w${w}-r${round}`);
      // Some content is shared across workers/rounds to exercise dedup + races.
      await writeTree(source, {
        'shared/stable.bin': `shared-content-${round % 2 ? 'odd' : 'even'}`,
        [`worker-${w}/file-${round}.txt`]: `payload-${w}-${round}-`.repeat(8),
      });
      publishTasks.push(workers[w]!.request({ cmd: 'publish', source }));
    }
  }

  const responses = await Promise.all(publishTasks);
  for (const response of responses) {
    assert.equal(response.ok, true, response.error?.message);
  }

  gcStopped = true;
  // Drain one final GC and stop the GC worker.
  await gcLoop;
  if (gcLoopError) throw gcLoopError;

  const parent2 = await SnapshotArchive.open(archiveRoot);
  const versions = await parent2.listVersions({ order: 'asc' });
  assert.equal(versions.length, workerCount * roundsPerWorker);
  // Serialized seq allocation yields contiguous v1..vN ids.
  assert.deepEqual(
    versions.map((v) => v.id),
    Array.from({ length: workerCount * roundsPerWorker }, (_, i) => `v${i + 1}`),
  );

  // Every published version must restore byte-complete despite concurrent GC.
  for (const version of versions) {
    const target = path.join(sandbox, `verify-${version.id}`);
    const restored = await parent2.restoreVersion(version.id, target);
    assert.equal(restored.verified, true);
  }

  await parent2.gc();
  // Everything listed is still referenced, so a final GC keeps all blobs.
  const afterGc = await parent2.listVersions();
  assert.equal(afterGc.length, workerCount * roundsPerWorker);

  for (const worker of workers) await worker.closeGracefully();
  await gcWorker.closeGracefully();
  await parent2.close();
});

function runCrashChild(
  args: string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', crashChildScript, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
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

test('subprocess: GC in another process cleans SIGKILLed before-commit publisher leftovers', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'v1');
  const source2 = path.join(sandbox, 'v2');
  await writeTree(source1, { 'old.txt': 'aaaa' });
  await writeTree(source2, { 'new.txt': 'bbbbbbbb' });

  const parent = await SnapshotArchive.open(archiveRoot);
  await parent.createSnapshot(source1);

  const crash = await runCrashChild([archiveRoot, source2, 'before-commit']);
  assert.equal(crash.signal, 'SIGKILL', crash.stderr);

  // Give the killed process a moment to be reaped by the test runner.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const gc = await parent.gc();
  // Dead staging directory is reported and removed.
  assert.equal(gc.removedStagingDirs.length >= 1, true);
  assert.deepEqual(await listStagingIds(archiveRoot), []);
  // The uncommitted blob placement is reclaimed as well.
  assert.equal(gc.removedBlobIds.length, 1);

  const ids = (await parent.listVersions({ order: 'asc' })).map((v) => v.id);
  assert.deepEqual(ids, ['v1']);
  const target = path.join(sandbox, 'restore-v1');
  await parent.restoreVersion('v1', target);
  assert.equal(await readFile(path.join(target, 'old.txt'), 'utf8'), 'aaaa');

  // The archive keeps working normally after cross-process cleanup.
  const next = await parent.createSnapshot(source2);
  assert.deepEqual((await parent.listVersions({ order: 'asc' })).map((v) => v.id), ['v1', next.version.id]);

  await parent.close();
});

test('subprocess: after-commit SIGKILL leaves a GC-cleanable stage but a fully restorable new version', async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');
  const source1 = path.join(sandbox, 'v1');
  const source2 = path.join(sandbox, 'v2');
  await writeTree(source1, { 'old-map.bin': 'aaaa' });
  await writeTree(source2, { 'new-map.bin': 'bbbbbbbb' });

  const parent = await SnapshotArchive.open(archiveRoot, { quotaBytes: 8 });
  const v1 = await parent.createSnapshot(source1);
  const oldBlobId = v1.version.files[0]!.blobId;

  const crash = await runCrashChild([archiveRoot, source2, 'after-commit', '8']);
  assert.equal(crash.signal, 'SIGKILL', crash.stderr);
  await new Promise((resolve) => setTimeout(resolve, 50));

  let versions = await parent.listVersions({ order: 'asc' });
  assert.deepEqual(versions.map((v) => v.id), ['v2']);

  const gc = await parent.gc();
  assert.equal(gc.removedStagingDirs.length >= 1, true);
  // v1 was evicted in the same committed transaction, so its blob is now free.
  assert.equal(gc.removedBlobIds.includes(oldBlobId), true);

  const target = path.join(sandbox, 'restore-v2');
  const restored = await parent.restoreVersion('v2', target);
  assert.equal(restored.verified, true);
  assert.equal(await readFile(path.join(target, 'new-map.bin'), 'utf8'), 'bbbbbbbb');

  versions = await parent.listVersions({ order: 'asc' });
  assert.deepEqual(versions.map((v) => v.id), ['v2']);
  await parent.close();
});

test('subprocess: several processes can initialize a fresh archive root concurrently', { timeout: 30_000 }, async (t) => {
  const sandbox = await makeSandbox(t);
  const archiveRoot = path.join(sandbox, 'archive');

  const clients: WorkerClient[] = [];
  for (let i = 0; i < 4; i += 1) clients.push(WorkerClient.spawn(archiveRoot));
  await Promise.all(clients.map((client) => client.open()));

  const responses = await Promise.all(
    clients.map(async (client, index) => {
      const source = path.join(sandbox, `init-src-${index}`);
      await writeTree(source, { [`file-${index}.txt`]: `content-${index}` });
      return client.request({ cmd: 'publish', source });
    }),
  );

  for (const response of responses) assert.equal(response.ok, true, response.error?.message);

  const verifier = await SnapshotArchive.open(archiveRoot);
  const versions = await verifier.listVersions({ order: 'asc' });
  assert.equal(versions.length, 4);
  assert.deepEqual(versions.map((v) => v.id), ['v1', 'v2', 'v3', 'v4']);
  for (const version of versions) {
    const target = path.join(sandbox, `init-restore-${version.id}`);
    assert.equal((await verifier.restoreVersion(version.id, target)).verified, true);
  }
  await verifier.close();
  for (const client of clients) await client.closeGracefully();
});
