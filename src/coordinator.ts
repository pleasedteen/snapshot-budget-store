import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ErrorCode, SnapshotError } from './errors.js';

export type OperationKind = 'create-snapshot' | 'restore' | 'verify' | 'gc';

export interface ActiveOperation {
  id: string;
  kind: OperationKind;
  blobIds: Set<string>;
  scratchDirs: Set<string>;
  /** Cross-process lease fields. Persistent operations survive in a lease file. */
  persistent?: boolean;
  ownerId?: string;
  pid?: number;
  startedAt?: string;
  startTick?: number | null;
  leasePath?: string;
  lockPath?: string;
  /** Held open with `BEGIN IMMEDIATE`; the kernel releases the lock on SIGKILL. */
  lockDb?: DatabaseSync;
}

/** Minimal promise mutex; every critical catalog/GC section is serialized in-process. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  async runExclusive<T>(callback: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

/** JSON document persisted for every operation that must be visible to other processes. */
export interface LeaseFileData {
  id: string;
  ownerId: string;
  pid: number;
  ppid: number;
  /** Linux `/proc/<pid>/stat` starttime ticks, used to detect PID reuse. */
  startTick: number | null;
  kind: OperationKind;
  startedAt: string;
  updatedAt: string;
  blobIds: string[];
  scratchDirs: string[];
}

export interface LeaseContribution {
  /** Blob IDs protected by leases held by live operations in any process. */
  liveBlobIds: Set<string>;
  /** Absolute scratch directories protected by live leases. */
  liveScratchDirs: Set<string>;
  /** Absolute scratch directories recorded by dead leases; safe to remove. */
  deadScratchDirs: string[];
  /** Lease IDs whose owner process/lock is gone and whose lease file was reaped. */
  reapedLeaseIds: string[];
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Detect SQLITE_BUSY(5) / SQLITE_LOCKED(6) across node:sqlite error shapes. */
export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { errcode?: number | bigint; code?: string; message?: string };
  const rawCode = record.errcode;
  const extended = typeof rawCode === 'bigint' ? Number(rawCode) : rawCode;
  // Extended result codes encode the primary code in the low 8 bits.
  if (typeof extended === 'number' && (extended & 0xff) === 5) return true;
  if (typeof extended === 'number' && (extended & 0xff) === 6) return true;
  if (record.code === 'SQLITE_BUSY' || record.code === 'SQLITE_LOCKED') return true;
  return (
    typeof record.message === 'string' &&
    /database is locked|database table is locked|sqlite_busy|sqlite_locked/i.test(record.message)
  );
}

let cachedProcessStartTick: number | null | undefined;

/**
 * Read field 22 (`starttime`) of `/proc/self/stat`. Returns null off Linux or
 * when the proc filesystem is unavailable.
 */
export function currentProcessStartTick(): number | null {
  if (cachedProcessStartTick !== undefined) return cachedProcessStartTick;
  cachedProcessStartTick = readProcessStartTick(process.pid);
  return cachedProcessStartTick;
}

function readProcessStartTick(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesized and may contain spaces/parens.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    // fields[0] is field 3 (state); field 22 starttime therefore is index 19.
    const value = Number(fields[19]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

type OwnerState = 'alive' | 'dead';

/**
 * Best-effort owner liveness. The SQLite operation lock is the authoritative
 * signal; this is only a defense-in-depth cross-check for filesystems where
 * fcntl locks might not be coherent.
 */
function ownerProcessState(lease: Pick<LeaseFileData, 'pid' | 'startTick'>): OwnerState {
  if (!Number.isInteger(lease.pid) || lease.pid <= 0) return 'dead';

  let exists = false;
  try {
    process.kill(lease.pid, 0);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') exists = true;
    else exists = false;
  }
  if (!exists) return 'dead';

  if (process.platform === 'linux') {
    try {
      const stat = fsSync.readFileSync(`/proc/${lease.pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = afterComm.split(' ');
      const state = fields[0];
      // Zombie/X means SIGKILLed but not yet reaped; fds and locks are already gone.
      if (state === 'Z' || state === 'X') return 'dead';
      const tick = Number(fields[19]);
      if (
        typeof lease.startTick === 'number' &&
        lease.startTick !== null &&
        Number.isFinite(tick) &&
        lease.startTick !== tick
      ) {
        // PID was reused by a different process.
        return 'dead';
      }
    } catch {
      // /proc entry disappeared between kill(0) and read: process is gone.
      return 'dead';
    }
  }

  return 'alive';
}

/**
 * Probe whether an operation lock is held by a live process.
 *
 * A dedicated SQLite file with an open `BEGIN IMMEDIATE` transaction is a
 * kernel-mediated lock: it is released automatically when the owner exits,
 * including SIGKILL. Returns `true` when held (owner live), `false` when the
 * lock is free (owner dead).
 */
export function probeSqliteLockHeld(lockPath: string): boolean {
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(lockPath);
    probe.exec('PRAGMA busy_timeout = 0');
    try {
      probe.exec('BEGIN IMMEDIATE');
      try {
        probe.exec('ROLLBACK');
      } catch {
        // Nothing to roll back if BEGIN failed; acquisition success is enough.
      }
      return false;
    } catch (error) {
      if (isSqliteBusyError(error)) return true;
      throw error;
    }
  } finally {
    try {
      probe?.close();
    } catch {
      // Probe close failures are non-fatal; caller decides liveness.
    }
  }
}

/**
 * State shared by all Archive handles for one resolved root in this process.
 * This makes multiple handles in tests/application code observe the same
 * critical-section lock, in-progress operation leases, and owner identity.
 *
 * Across processes, coordination uses:
 *  - `<root>/locks/catalog.lock` SQLite immediate transaction (global critical section);
 *  - `<root>/locks/operations/<op>.lock` per-operation liveness locks;
 *  - `<root>/leases/<op>.json` durable lease documents (protected blob/scratch sets).
 */
export class RootCoordinator {
  readonly root: string;
  readonly mutex = new AsyncMutex();
  readonly operations = new Map<string, ActiveOperation>();
  /** Unique identity of this Node process, used to recognize our own leases. */
  readonly ownerId = randomUUID();

  readonly locksDirectory: string;
  readonly leasesDirectory: string;
  readonly operationLocksDirectory: string;
  readonly catalogLockPath: string;

  constructor(root: string) {
    this.root = root;
    this.locksDirectory = path.join(root, 'locks');
    this.leasesDirectory = path.join(root, 'leases');
    this.operationLocksDirectory = path.join(this.locksDirectory, 'operations');
    this.catalogLockPath = path.join(this.locksDirectory, 'catalog.lock');
  }

  /** Create on-disk coordination directories. Safe to call repeatedly. */
  async ensureLayout(): Promise<void> {
    await fs.mkdir(this.operationLocksDirectory, { recursive: true });
    await fs.mkdir(this.leasesDirectory, { recursive: true });
  }

  startOperation(kind: OperationKind, operationId: string = randomUUID()): ActiveOperation {
    const operation: ActiveOperation = {
      id: operationId,
      kind,
      blobIds: new Set(),
      scratchDirs: new Set(),
      persistent: false,
      ownerId: this.ownerId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      startTick: currentProcessStartTick(),
    };
    this.operations.set(operation.id, operation);
    return operation;
  }

  /**
   * Register a cross-process operation. Must be called while the catalog lock
   * is held (see {@link beginOperation} and {@link withExclusive}) so GC can
   * never observe the intermediate state "lock acquired, lease not written".
   */
  async registerOperation(
    kind: OperationKind,
    init: {
      id?: string;
      blobIds?: Iterable<string>;
      scratchDirs?: Iterable<string>;
    } = {},
  ): Promise<ActiveOperation> {
    const operation = this.startOperation(kind, init.id);
    operation.persistent = true;
    operation.leasePath = path.join(this.leasesDirectory, `${operation.id}.json`);
    operation.lockPath = path.join(this.operationLocksDirectory, `${operation.id}.lock`);
    for (const blobId of init.blobIds ?? []) operation.blobIds.add(blobId);
    for (const scratchDir of init.scratchDirs ?? []) {
      operation.scratchDirs.add(path.resolve(scratchDir));
    }

    await fs.mkdir(this.operationLocksDirectory, { recursive: true });
    // Fresh UUID file: BEGIN IMMEDIATE always succeeds here. The transaction is
    // kept open until finishOperation; process death releases the lock in-kernel.
    operation.lockDb = new DatabaseSync(operation.lockPath);
    operation.lockDb.exec('PRAGMA busy_timeout = 0');
    operation.lockDb.exec('BEGIN IMMEDIATE');

    await this.writeLease(operation);
    return operation;
  }

  /** Acquire the catalog lock briefly just to publish a fresh operation lease. */
  async beginOperation(
    kind: OperationKind,
    init: { id?: string; blobIds?: Iterable<string>; scratchDirs?: Iterable<string> } = {},
  ): Promise<ActiveOperation> {
    return this.withExclusive(() => this.registerOperation(kind, init));
  }

  /** Atomically persist the current lease document (temp file + rename). */
  async writeLease(operation: ActiveOperation): Promise<void> {
    if (!operation.persistent || !operation.leasePath) return;
    const now = new Date().toISOString();
    const lease: LeaseFileData = {
      id: operation.id,
      ownerId: operation.ownerId ?? this.ownerId,
      pid: operation.pid ?? process.pid,
      ppid: process.ppid,
      startTick: operation.startTick === undefined ? currentProcessStartTick() : operation.startTick,
      kind: operation.kind,
      startedAt: operation.startedAt ?? now,
      updatedAt: now,
      blobIds: [...operation.blobIds],
      scratchDirs: [...operation.scratchDirs],
    };
    const temporaryPath = `${operation.leasePath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(temporaryPath, JSON.stringify(lease), { encoding: 'utf8', mode: 0o644 });
    await fs.rename(temporaryPath, operation.leasePath);
  }

  /** Record an additional scratch directory (e.g. a restore temp dir) durably. */
  async attachScratchDirectory(operationId: string, directory: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    const resolved = path.resolve(directory);
    if (operation.scratchDirs.has(resolved)) return;
    operation.scratchDirs.add(resolved);
    await this.writeLease(operation);
  }

  /**
   * Finish an operation and release all cross-process state. Safe to call more
   * than once and after errors. Lock/transaction release happens synchronously
   * before the returned promise resolves, so a subsequent GC cannot see us live.
   */
  async finishOperation(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    this.operations.delete(operationId);
    if (!operation || !operation.persistent) return;

    // Remove the lease document while the kernel lock is still held. That
    // ordering means a concurrent GC either sees no lease (operation already
    // finished) or reads the lease and then probes a still-held lock; it never
    // observes the contradictory "lease present + lock free" pair.
    if (operation.leasePath) {
      await fs.rm(operation.leasePath, { force: true }).catch(() => undefined);
    }

    const lockDb = operation.lockDb;
    operation.lockDb = undefined;
    if (lockDb) {
      try {
        lockDb.exec('ROLLBACK');
      } catch {
        // Transaction may already be finished.
      }
      try {
        lockDb.close();
      } catch {
        // Closing is best effort.
      }
    }

    const lockArtifacts = [
      operation.lockPath,
      operation.lockPath ? `${operation.lockPath}-wal` : undefined,
      operation.lockPath ? `${operation.lockPath}-shm` : undefined,
      operation.lockPath ? `${operation.lockPath}-journal` : undefined,
    ].filter((item): item is string => Boolean(item));

    await Promise.all(
      lockArtifacts.map((artifactPath) => fs.rm(artifactPath, { force: true }).catch(() => undefined)),
    );
  }

  activeBlobIds(): Set<string> {
    const result = new Set<string>();
    for (const operation of this.operations.values()) {
      for (const blobId of operation.blobIds) result.add(blobId);
    }
    return result;
  }

  isScratchDirectoryActive(directory: string): boolean {
    const resolved = path.resolve(directory);
    for (const operation of this.operations.values()) {
      if (operation.scratchDirs.has(resolved) || operation.scratchDirs.has(directory)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Cross-process catalog lock
  // ---------------------------------------------------------------------------

  /**
   * Run `callback` while holding the process-wide AsyncMutex AND the
   * cross-process catalog lock. The catalog lock is a held-open
   * `BEGIN IMMEDIATE` transaction on a dedicated SQLite file, so it is
   * released automatically by the kernel if this process is killed.
   */
  async withExclusive<T>(callback: () => T | Promise<T>): Promise<T> {
    return this.mutex.runExclusive(() => this.withCatalogLock(callback));
  }

  async withCatalogLock<T>(
    callback: () => T | Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    await fs.mkdir(this.locksDirectory, { recursive: true });
    const lockDb = await this.acquireCatalogLock(timeoutMs);
    try {
      return await callback();
    } finally {
      try {
        lockDb.exec('ROLLBACK');
      } catch {
        // The lock transaction is rollback-only.
      }
      try {
        lockDb.close();
      } catch {
        // Best-effort close.
      }
    }
  }

  private async acquireCatalogLock(timeoutMs: number): Promise<DatabaseSync> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    for (;;) {
      const lockDb = new DatabaseSync(this.catalogLockPath);
      try {
        lockDb.exec('PRAGMA busy_timeout = 0');
        lockDb.exec('BEGIN IMMEDIATE');
        return lockDb;
      } catch (error) {
        try {
          lockDb.close();
        } catch {
          // Ignore close error on failed acquisition.
        }
        if (!isSqliteBusyError(error)) {
          throw new SnapshotError(
            ErrorCode.IoError,
            `无法获取归档库跨进程锁：${(error as Error).message}`,
            error,
          );
        }
        if (Date.now() >= deadline) {
          throw new SnapshotError(
            ErrorCode.IoError,
            '等待归档库跨进程锁超时：另一个进程的关键区长时间未结束',
            error,
          );
        }
        const exponential = Math.min(160, 10 * 2 ** Math.min(attempt, 4));
        const jitter = Math.floor(Math.random() * 25);
        attempt += 1;
        await sleep(exponential + jitter);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lease inspection and dead-operation reaping (used by GC)
  // ---------------------------------------------------------------------------

  /** Decide whether a lease belongs to a live operation in any process. */
  async isLeaseLive(lease: LeaseFileData): Promise<boolean> {
    if (lease.ownerId === this.ownerId) {
      return this.operations.has(lease.id);
    }

    const lockPath =
      lease.id && /^[A-Za-z0-9-]+$/.test(lease.id)
        ? path.join(this.operationLocksDirectory, `${lease.id}.lock`)
        : undefined;

    // Normally the signals agree on the first probe. They can transiently
    // disagree in the brief window after SIGKILL is delivered but before the
    // kernel releases the file lock / reaps the process, so re-evaluate
    // contradictory pairs for a short grace period instead of making an
    // irreversible deletion decision on a single reading.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let lockHeld: boolean | null = null;
      if (lockPath) {
        try {
          lockHeld = probeSqliteLockHeld(lockPath);
        } catch {
          lockHeld = null;
        }
      }
      const ownerState = ownerProcessState(lease);

      if (lockHeld === true && ownerState === 'alive') return true;
      if (lockHeld === false && ownerState === 'dead') return false;

      await sleep(25);
    }

    // Persistent contradiction (e.g. a filesystem with unreliable locks).
    // Prefer protecting data: only declare dead when the owner is verifiably gone.
    return ownerProcessState(lease) === 'alive';
  }

  /**
   * Read every lease file, classify live vs dead, and remove lease documents
   * and lock artifacts of dead owners. Must be called while holding the
   * catalog lock.
   */
  async collectLeasesForGc(): Promise<LeaseContribution> {
    const contribution: LeaseContribution = {
      liveBlobIds: new Set<string>(),
      liveScratchDirs: new Set<string>(),
      deadScratchDirs: [],
      reapedLeaseIds: [],
    };

    let leaseFiles: string[] = [];
    try {
      leaseFiles = await fs.readdir(this.leasesDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return contribution;
    }

    for (const fileName of leaseFiles) {
      if (!fileName.endsWith('.json')) continue;
      const leasePath = path.join(this.leasesDirectory, fileName);

      let lease: LeaseFileData;
      try {
        lease = JSON.parse(await fs.readFile(leasePath, 'utf8')) as LeaseFileData;
      } catch {
        // Lease documents are atomically renamed, so an unparseable file is
        // corrupt rather than partial. Leave it alone instead of risking a
        // wrong liveness decision.
        continue;
      }
      if (!lease || typeof lease.id !== 'string' || typeof lease.ownerId !== 'string') continue;

      if (await this.isLeaseLive(lease)) {
        for (const blobId of lease.blobIds ?? []) {
          if (typeof blobId === 'string') contribution.liveBlobIds.add(blobId);
        }
        for (const scratchDir of lease.scratchDirs ?? []) {
          if (typeof scratchDir === 'string' && scratchDir) {
            contribution.liveScratchDirs.add(path.resolve(scratchDir));
          }
        }
        continue;
      }

      for (const scratchDir of lease.scratchDirs ?? []) {
        if (typeof scratchDir === 'string' && scratchDir) {
          contribution.deadScratchDirs.push(path.resolve(scratchDir));
        }
      }
      contribution.reapedLeaseIds.push(lease.id);
      await this.removeLeaseArtifacts(lease);
    }

    await this.sweepOrphanOperationLocks();
    return contribution;
  }

  async removeLeaseArtifacts(lease: Pick<LeaseFileData, 'id'> & Partial<LeaseFileData>): Promise<void> {
    const leasePath =
      typeof lease.id === 'string' && /^[A-Za-z0-9-]+$/.test(lease.id)
        ? path.join(this.leasesDirectory, `${lease.id}.json`)
        : undefined;
    const lockPath =
      typeof lease.id === 'string' && /^[A-Za-z0-9-]+$/.test(lease.id)
        ? path.join(this.operationLocksDirectory, `${lease.id}.lock`)
        : undefined;

    const paths = [
      leasePath,
      lockPath,
      lockPath ? `${lockPath}-wal` : undefined,
      lockPath ? `${lockPath}-shm` : undefined,
      lockPath ? `${lockPath}-journal` : undefined,
    ].filter((item): item is string => Boolean(item));

    await Promise.all(paths.map((artifactPath) => fs.rm(artifactPath, { force: true }).catch(() => undefined)));
  }

  /**
   * Remove operation lock files that have no lease document and are not held.
   * Given the registration ordering under the catalog lock, such files can only
   * be leftovers of processes killed during registration.
   */
  async sweepOrphanOperationLocks(): Promise<void> {
    let lockNames: string[] = [];
    try {
      lockNames = await fs.readdir(this.operationLocksDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }

    for (const lockName of lockNames) {
      if (!lockName.endsWith('.lock')) continue;
      const operationId = lockName.slice(0, -'.lock'.length);
      const leasePath = path.join(this.leasesDirectory, `${operationId}.json`);

      let leaseExists = false;
      try {
        await fs.access(leasePath);
        leaseExists = true;
      } catch {
        leaseExists = false;
      }
      if (leaseExists) continue;

      const lockPath = path.join(this.operationLocksDirectory, lockName);
      let held = false;
      try {
        held = probeSqliteLockHeld(lockPath);
      } catch {
        held = true; // Cannot determine state: leave it untouched.
      }
      if (held) continue;

      await Promise.all(
        [lockPath, `${lockPath}-wal`, `${lockPath}-shm`, `${lockPath}-journal`].map((p) =>
          fs.rm(p, { force: true }).catch(() => undefined),
        ),
      );
    }
  }
}

const coordinators = new Map<string, RootCoordinator>();

export function coordinatorForRoot(resolvedRoot: string): RootCoordinator {
  let coordinator = coordinators.get(resolvedRoot);
  if (!coordinator) {
    coordinator = new RootCoordinator(resolvedRoot);
    coordinators.set(resolvedRoot, coordinator);
  }
  return coordinator;
}

/** Test helper: forget coordinators between explicitly isolated scenarios. */
export function resetCoordinatorRegistryForTests(): void {
  coordinators.clear();
}
