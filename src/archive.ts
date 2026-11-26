import { promises as fs } from 'node:fs';
import path from 'node:path';
import { coordinatorForRoot, type RootCoordinator } from './coordinator.js';
import { openDatabase, toNumber, type BlobRow, type FileRow, type VersionRow } from './database.js';
import {
  ErrorCode,
  QuotaExceededError,
  SnapshotCorruptionError,
  SnapshotError,
  TargetExistsError,
  VersionNotFoundError,
} from './errors.js';
import {
  blobPathFor,
  directorySize,
  ensureDirectory,
  hashAndCopyFile,
  hashFile,
  isDirectory,
  manifestRelativePath,
  pathExists,
  placeBlobFromStage,
  resolveWithin,
  walkTree,
} from './fs-util.js';
import { assertQuotaPlan, planQuota, type QuotaVersionLike } from './quota.js';
import type {
  ArchiveStats,
  CreateSnapshotOptions,
  EvictedVersion,
  FileEntry,
  GcResult,
  OpenArchiveOptions,
  PublishResult,
  QuotaInfo,
  RestoreOptions,
  RestoreResult,
  RetentionValue,
  VerificationResult,
  VersionDetails,
  VersionSummary,
} from './types.js';
import { materializeFiles, verifyVersionBlobs } from './verify.js';
import type { DatabaseSync } from 'node:sqlite';

interface PreparedSnapshot {
  sourceRoot: string;
  operationId: string;
  stageObjectsDirectory: string;
  entries: FileEntry[];
  directories: string[];
  blobSizes: Map<string, number>;
  logicalBytes: number;
  options: CreateSnapshotOptions;
}

function isRetainedValue(value: unknown): boolean {
  return value === true || value === 'pinned' || value === 'retained' || value === 'pin' || value === 'keep';
}

/**
 * A local, persistent, content-deduplicated snapshot archive.
 *
 * Metadata is stored in an embedded SQLite database. File bytes are stored in a
 * SHA-256 content-addressed object store below the archive root.
 */
export class SnapshotArchive {
  readonly root: string;
  readonly objectsDirectory: string;
  readonly stagingDirectory: string;
  readonly databasePath: string;

  private readonly db: DatabaseSync;
  private readonly coordinator: RootCoordinator;
  private closed = false;
  private readonly crashPoint?: OpenArchiveOptions['crashPoint'];

  private constructor(
    root: string,
    db: DatabaseSync,
    coordinator: RootCoordinator,
    crashPoint?: OpenArchiveOptions['crashPoint'],
  ) {
    this.root = root;
    this.db = db;
    this.coordinator = coordinator;
    this.objectsDirectory = path.join(root, 'objects');
    this.stagingDirectory = path.join(root, 'staging');
    this.databasePath = path.join(root, 'archive.sqlite');
    this.crashPoint = crashPoint;
  }

  static async open(archiveRoot: string, options: OpenArchiveOptions = {}): Promise<SnapshotArchive> {
    const resolved = path.resolve(archiveRoot);
    await ensureDirectory(resolved);
    const root = await fs.realpath(resolved);

    const objectsDirectory = path.join(root, 'objects');
    const shards = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));
    await Promise.all([
      ensureDirectory(objectsDirectory),
      ensureDirectory(path.join(root, 'staging')),
      ...shards.slice(0, 16).map((shard) => ensureDirectory(path.join(objectsDirectory, shard))),
    ]);

    const db = openDatabase(path.join(root, 'archive.sqlite'));
    const coordinator = coordinatorForRoot(root);
    const archive = new SnapshotArchive(root, db, coordinator, options.crashPoint);
    archive.initializeQuota(options.quotaBytes);
    return archive;
  }

  // ---------------------------------------------------------------------------
  // Quota and metadata
  // ---------------------------------------------------------------------------

  private initializeQuota(quotaBytes: number | null | undefined): void {
    if (quotaBytes === undefined) return;
    this.setQuotaSync(quotaBytes);
  }

  private validateQuota(quotaBytes: number | null): void {
    if (quotaBytes !== null && (!Number.isInteger(quotaBytes) || quotaBytes < 0)) {
      throw new SnapshotError(ErrorCode.InvalidOptions, 'quotaBytes 必须是 null 或不小于 0 的整数');
    }
  }

  private setQuotaSync(quotaBytes: number | null): void {
    this.validateQuota(quotaBytes);
    this.db
      .prepare(
        `INSERT INTO archive_meta(key, value) VALUES('quota_bytes', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(quotaBytes === null ? '' : String(quotaBytes));
  }

  async setQuota(quotaBytes: number | null): Promise<QuotaInfo> {
    this.checkOpen();
    await this.coordinator.mutex.runExclusive(() => {
      this.checkOpen();
      this.setQuotaSync(quotaBytes);
    });
    return this.getQuotaInfo();
  }

  private readQuotaBytes(): number | undefined {
    const row = this.db.prepare(`SELECT value FROM archive_meta WHERE key = 'quota_bytes'`).get() as
      | { value: string }
      | undefined;
    if (!row || row.value === '') return undefined;
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SnapshotError(ErrorCode.InvalidOptions, `归档配额元数据无效：${row.value}`);
    }
    return value;
  }

  private getQuotaInfo(): QuotaInfo {
    const quotaBytes = this.readQuotaBytes();
    const usedRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(size), 0) AS used
         FROM blobs
         WHERE id IN (SELECT DISTINCT blob_id FROM files)`,
      )
      .get() as { used: number | bigint };
    const usedBytes = toNumber(usedRow.used);
    return {
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
      usedBytes,
      ...(quotaBytes === undefined ? {} : { availableBytes: Math.max(0, quotaBytes - usedBytes) }),
    };
  }

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  private checkOpen(): void {
    if (this.closed) throw new SnapshotError(ErrorCode.ArchiveClosed, '快照库已关闭');
  }

  private mapSummary(row: VersionRow): VersionSummary {
    const pinned = toNumber(row.pinned) === 1;
    const summary: VersionSummary = {
      id: row.id,
      seq: toNumber(row.seq),
      createdAt: row.created_at,
      pinned,
      retention: pinned ? 'pinned' : 'normal',
      fileCount: toNumber(row.file_count),
      logicalBytes: toNumber(row.logical_bytes),
      distinctBytes: toNumber(row.distinct_bytes),
    };
    if (row.message !== null) summary.message = row.message;
    return summary;
  }

  private requireVersionRow(versionId: string): VersionRow {
    const row = this.db.prepare(`SELECT * FROM versions WHERE id = ?`).get(versionId) as
      | VersionRow
      | undefined;
    if (!row) throw new VersionNotFoundError(versionId);
    return row;
  }

  private loadDetails(row: VersionRow): VersionDetails {
    const fileRows = this.db
      .prepare(`SELECT * FROM files WHERE version_id = ? ORDER BY path ASC`)
      .all(row.id) as unknown as FileRow[];

    const files: FileEntry[] = fileRows.map((fileRow) => {
      const entry: FileEntry = {
        path: fileRow.path,
        blobId: fileRow.blob_id,
        size: toNumber(fileRow.size),
      };
      const mode = toNumber(fileRow.mode);
      if (mode > 0) entry.mode = mode;
      return entry;
    });

    const directoryRows = this.db
      .prepare(`SELECT path FROM directories WHERE version_id = ? ORDER BY path ASC`)
      .all(row.id) as unknown as Array<{ path: string }>;

    return { ...this.mapSummary(row), files, directories: directoryRows.map((item) => item.path) };
  }

  async listVersions(options: { order?: 'asc' | 'desc' } = {}): Promise<VersionSummary[]> {
    this.checkOpen();
    const direction = options.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`SELECT * FROM versions ORDER BY seq ${direction}`).all() as unknown as VersionRow[];
    return rows.map((row) => this.mapSummary(row));
  }

  async list(options: { order?: 'asc' | 'desc' } = {}): Promise<VersionSummary[]> {
    return this.listVersions(options);
  }

  /** Alias for callers using “snapshot” rather than “version” terminology. */
  async listSnapshots(options: { order?: 'asc' | 'desc' } = {}): Promise<VersionSummary[]> {
    return this.listVersions(options);
  }

  async listPublished(options: { order?: 'asc' | 'desc' } = {}): Promise<VersionSummary[]> {
    return this.listVersions(options);
  }

  async getSnapshot(versionId: string): Promise<VersionDetails> {
    return this.getVersion(versionId);
  }

  async getVersion(versionId: string): Promise<VersionDetails> {
    this.checkOpen();
    return this.loadDetails(this.requireVersionRow(versionId));
  }

  async setRetention(versionId: string, retained: RetentionValue): Promise<VersionSummary> {
    this.checkOpen();
    const shouldRetain = isRetainedValue(retained);
    return this.coordinator.mutex.runExclusive(() => {
      this.checkOpen();
      const row = this.requireVersionRow(versionId);
      this.db.prepare(`UPDATE versions SET pinned = ? WHERE id = ?`).run(shouldRetain ? 1 : 0, versionId);
      return this.mapSummary({ ...row, pinned: shouldRetain ? 1 : 0 });
    });
  }

  async pinVersion(versionId: string): Promise<VersionSummary> {
    return this.setRetention(versionId, true);
  }

  async unpinVersion(versionId: string): Promise<VersionSummary> {
    return this.setRetention(versionId, false);
  }

  async unsetRetention(versionId: string): Promise<VersionSummary> {
    return this.setRetention(versionId, false);
  }

  async removeRetention(versionId: string): Promise<VersionSummary> {
    return this.setRetention(versionId, false);
  }

  async pin(versionId: string): Promise<VersionSummary> {
    return this.pinVersion(versionId);
  }

  async unpin(versionId: string): Promise<VersionSummary> {
    return this.unpinVersion(versionId);
  }

  // ---------------------------------------------------------------------------
  // Create and publish snapshots
  // ---------------------------------------------------------------------------

  async createSnapshot(sourceDirectory: string, options: CreateSnapshotOptions = {}): Promise<PublishResult> {
    this.checkOpen();

    const sourceRoot = path.resolve(sourceDirectory);
    const operation = this.coordinator.startOperation('create-snapshot');
    const operationStagingDirectory = path.join(this.stagingDirectory, operation.id);
    operation.scratchDirs.add(operationStagingDirectory);
    const stageObjectsDirectory = path.join(operationStagingDirectory, 'objects');

    try {
      if (!(await isDirectory(sourceRoot))) {
        throw new SnapshotError(ErrorCode.SourceNotFound, `源目录不存在或不是目录：${sourceRoot}`, {
          sourceDirectory,
        });
      }

      await ensureDirectory(stageObjectsDirectory);
      const tree = await walkTree(sourceRoot);
      const absoluteFiles = tree.files;
      const directories = tree.directories.map((absolutePath) =>
        manifestRelativePath(sourceRoot, absolutePath),
      );
      const entries: FileEntry[] = [];
      const blobSizes = new Map<string, number>();
      let logicalBytes = 0;

      for (let index = 0; index < absoluteFiles.length; index += 1) {
        const absolutePath = absoluteFiles[index]!;
        const manifestPath = manifestRelativePath(sourceRoot, absolutePath);
        const temporaryFile = path.join(operationStagingDirectory, `file-${index}.tmp`);
        const hashed = await hashAndCopyFile(absolutePath, temporaryFile);
        const stageBlobPath = path.join(stageObjectsDirectory, hashed.blobId);

        try {
          await fs.link(temporaryFile, stageBlobPath);
          await fs.rm(temporaryFile, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await fs.rm(temporaryFile, { force: true });
        }

        const stat = await fs.stat(absolutePath);
        entries.push({
          path: manifestPath,
          blobId: hashed.blobId,
          size: hashed.size,
          mode: stat.mode,
        });
        operation.blobIds.add(hashed.blobId);
        blobSizes.set(hashed.blobId, hashed.size);
        logicalBytes += hashed.size;
      }

      entries.sort((a, b) => a.path.localeCompare(b.path));
      await options.hooks?.beforePublish?.();

      const prepared: PreparedSnapshot = {
        sourceRoot,
        operationId: operation.id,
        stageObjectsDirectory,
        entries,
        directories,
        blobSizes,
        logicalBytes,
        options,
      };

      return await this.coordinator.mutex.runExclusive(() => this.publishPrepared(prepared));
    } finally {
      this.coordinator.finishOperation(operation.id);
      await fs.rm(operationStagingDirectory, { recursive: true, force: true });
    }
  }

  /** Ergonomic alias for callers modeling the operation as publication. */
  async createFromDirectory(sourceDirectory: string, options: CreateSnapshotOptions = {}): Promise<PublishResult> {
    return this.createSnapshot(sourceDirectory, options);
  }

  async snapshotDirectory(sourceDirectory: string, options: CreateSnapshotOptions = {}): Promise<PublishResult> {
    return this.createSnapshot(sourceDirectory, options);
  }

  private maybeCrash(point: NonNullable<OpenArchiveOptions['crashPoint']>): void {
    const configured = this.crashPoint ?? process.env.SNAPSHOT_LAB_CRASH_POINT;
    if (configured !== point) return;
    // Test-only fault injection. SIGKILL avoids graceful shutdown semantics.
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  }

  private collectQuotaCandidates(): {
    versions: QuotaVersionLike[];
    rows: VersionRow[];
    blobSizes: Map<string, number>;
  } {
    const rows = this.db.prepare(`SELECT * FROM versions ORDER BY seq ASC`).all() as unknown as VersionRow[];
    const blobRows = this.db.prepare(`SELECT id, size FROM blobs`).all() as unknown as BlobRow[];
    const blobSizes = new Map<string, number>(blobRows.map((row) => [row.id, toNumber(row.size)]));

    const versions: QuotaVersionLike[] = rows.map((row) => {
      const files = this.db
        .prepare(`SELECT DISTINCT blob_id FROM files WHERE version_id = ?`)
        .all(row.id) as Array<{ blob_id: string }>;
      return {
        id: row.id,
        seq: toNumber(row.seq),
        pinned: toNumber(row.pinned) === 1,
        blobIds: new Set(files.map((file) => file.blob_id)),
      };
    });

    return { versions, rows, blobSizes };
  }

  private async publishPrepared(prepared: PreparedSnapshot): Promise<PublishResult> {
    this.checkOpen();

    if (prepared.options.quotaBytes !== undefined) {
      this.setQuotaSync(prepared.options.quotaBytes);
    }
    const quotaBytes = this.readQuotaBytes();
    const { versions, rows, blobSizes } = this.collectQuotaCandidates();
    for (const [blobId, size] of prepared.blobSizes) blobSizes.set(blobId, size);

    const nextBlobIds = new Set(prepared.blobSizes.keys());
    const plan = planQuota({ quotaBytes, versions, nextBlobIds, blobSizes });
    if (!plan.allowed) assertQuotaPlan(plan);

    const existingReferencedBlobIds = new Set<string>();
    for (const version of versions) for (const blobId of version.blobIds) existingReferencedBlobIds.add(blobId);
    const newBlobIds = [...nextBlobIds].filter((blobId) => !existingReferencedBlobIds.has(blobId));

    // Put bytes in the CAS before the durable metadata commit. GC cannot run
    // between this placement and commit because both take the root mutex.
    for (const blobId of nextBlobIds) {
      const stagePath = path.join(prepared.stageObjectsDirectory, blobId);
      const targetPath = blobPathFor(this.objectsDirectory, blobId);
      await placeBlobFromStage(stagePath, targetPath);
    }

    const nextSeq = rows.reduce((max, row) => Math.max(max, toNumber(row.seq)), 0) + 1;
    const versionId = `v${nextSeq}`;
    const createdAt = new Date().toISOString();
    const retentionCandidate =
      prepared.options.retention ??
      prepared.options.pin ??
      prepared.options.retained ??
      prepared.options.pinned ??
      false;
    const pinned = isRetainedValue(retentionCandidate) ? 1 : 0;
    const distinctBytes = [...prepared.blobSizes.values()].reduce((sum, size) => sum + size, 0);
    const evictedIds = new Set(plan.evictVersionIds);
    const evictedVersions: EvictedVersion[] = rows
      .filter((row) => evictedIds.has(row.id))
      .map((row) => ({ id: row.id, seq: toNumber(row.seq), pinned: toNumber(row.pinned) === 1 }));

    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db
        .prepare(
          `INSERT INTO versions
             (id, seq, created_at, message, pinned, file_count, logical_bytes, distinct_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          nextSeq,
          createdAt,
          prepared.options.message ?? null,
          pinned,
          prepared.entries.length,
          prepared.logicalBytes,
          distinctBytes,
        );

      const insertFile = this.db.prepare(
        `INSERT INTO files(version_id, path, blob_id, size, mode) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const entry of prepared.entries) {
        insertFile.run(versionId, entry.path, entry.blobId, entry.size, entry.mode ?? null);
      }

      const insertDirectory = this.db.prepare(
        `INSERT OR IGNORE INTO directories(version_id, path) VALUES (?, ?)`,
      );
      for (const directory of prepared.directories) {
        insertDirectory.run(versionId, directory);
      }

      const insertBlob = this.db.prepare(`INSERT OR IGNORE INTO blobs(id, size) VALUES (?, ?)`);
      for (const [blobId, size] of prepared.blobSizes) insertBlob.run(blobId, size);

      for (const evictedId of plan.evictVersionIds) {
        this.db.prepare(`DELETE FROM versions WHERE id = ?`).run(evictedId);
      }

      this.maybeCrash('before-commit');
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      if (error instanceof QuotaExceededError) throw error;
      throw new SnapshotError(ErrorCode.IoError, `发布快照失败：${(error as Error).message}`, error);
    }

    this.maybeCrash('after-commit');

    const version = await this.getVersion(versionId);
    const quota: QuotaInfo & { beforeBytes: number } = {
      ...this.getQuotaInfo(),
      beforeBytes: plan.beforeBytes,
    };

    return { version, evictedVersions, quota, newBlobIds };
  }

  // ---------------------------------------------------------------------------
  // Restore and verification
  // ---------------------------------------------------------------------------

  private async loadVersionAndLease(versionId: string): Promise<{ details: VersionDetails; operationId: string }> {
    return this.coordinator.mutex.runExclusive(() => {
      this.checkOpen();
      const row = this.requireVersionRow(versionId);
      const details = this.loadDetails(row);
      const operation = this.coordinator.startOperation('restore');
      for (const file of details.files) operation.blobIds.add(file.blobId);
      return { details, operationId: operation.id };
    });
  }

  async verifyVersion(versionId: string): Promise<VerificationResult> {
    this.checkOpen();
    const { details, operationId } = await this.loadVersionAndLease(versionId);
    try {
      const issues = await verifyVersionBlobs(this.objectsDirectory, details.files);
      const affectedFiles = Array.from(new Set(issues.flatMap((issue) => issue.files))).sort();
      return {
        versionId,
        healthy: issues.length === 0,
        fileCount: details.files.length,
        blobCount: new Set(details.files.map((file) => file.blobId)).size,
        issues,
        affectedFiles,
      };
    } finally {
      this.coordinator.finishOperation(operationId);
    }
  }

  async restoreVersion(
    versionId: string,
    targetDirectory: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    this.checkOpen();

    const targetDir = path.resolve(targetDirectory);
    const parentDir = path.dirname(targetDir);
    const baseName = path.basename(targetDir);
    if (!baseName || targetDir === path.parse(targetDir).root) {
      throw new SnapshotError(ErrorCode.InvalidPath, `恢复目标路径无效：${targetDirectory}`);
    }

    // Enroll in the catalog mutex before any slow filesystem check. Once this
    // returns, the manifest is selected and the blob lease is visible to GC.
    const { details, operationId } = await this.loadVersionAndLease(versionId);
    let temporaryDirectory: string | undefined;

    try {
      if (await pathExists(targetDir)) throw new TargetExistsError(targetDir);
      await options.hooks?.afterLease?.();

      await ensureDirectory(parentDir);
      if (await pathExists(targetDir)) throw new TargetExistsError(targetDir);

      temporaryDirectory = path.join(parentDir, `.${baseName}.restore-${operationId}`);
      await fs.mkdir(temporaryDirectory, { recursive: false });

      for (const directory of details.directories) {
        await fs.mkdir(resolveWithin(temporaryDirectory, directory), { recursive: true });
      }

      // Whole-version content verification happens before anything is delivered.
      const issues = await verifyVersionBlobs(this.objectsDirectory, details.files);
      if (issues.length > 0) throw new SnapshotCorruptionError(issues);

      await materializeFiles(temporaryDirectory, this.objectsDirectory, details.files);

      // Re-hash the private output copy as an end-to-end byte check.
      const materializedIssues = await this.verifyMaterializedOutputs(temporaryDirectory, details.files);
      if (materializedIssues.length > 0) throw new SnapshotCorruptionError(materializedIssues);

      if (await pathExists(targetDir)) throw new TargetExistsError(targetDir);
      await fs.rename(temporaryDirectory, targetDir);
      temporaryDirectory = undefined;
      await fsyncDirectoryBestEffort(parentDir);

      return {
        versionId: details.id,
        targetDir,
        fileCount: details.files.length,
        bytes: details.logicalBytes,
        verified: true,
      };
    } finally {
      this.coordinator.finishOperation(operationId);
      if (temporaryDirectory) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  private async verifyMaterializedOutputs(
    directory: string,
    files: readonly FileEntry[],
  ): Promise<import('./errors.js').CorruptionIssue[]> {
    const issues: import('./errors.js').CorruptionIssue[] = [];

    for (const file of files) {
      const outputPath = resolveWithin(directory, file.path);

      try {
        const actual = await hashFile(outputPath);
        if (actual.blobId !== file.blobId || actual.size !== file.size) {
          issues.push({
            code: actual.blobId !== file.blobId ? 'HASH_MISMATCH' : 'SIZE_MISMATCH',
            blobId: file.blobId,
            files: [file.path],
            message: `恢复临时文件校验失败：${file.path}`,
            expected: file.blobId,
            actual: actual.blobId,
          });
        }
      } catch (error) {
        issues.push({
          code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING_BLOB' : 'READ_ERROR',
          blobId: file.blobId,
          files: [file.path],
          message: `读取恢复临时文件失败：${(error as Error).message}`,
        });
      }
    }
    return issues;
  }

  /** Alias for callers who prefer `archive.restore(...)`. */
  async restore(versionId: string, targetDirectory: string, options?: RestoreOptions): Promise<RestoreResult> {
    return this.restoreVersion(versionId, targetDirectory, options);
  }

  async restoreSnapshot(
    versionId: string,
    targetDirectory: string,
    options?: RestoreOptions,
  ): Promise<RestoreResult> {
    return this.restoreVersion(versionId, targetDirectory, options);
  }

  // ---------------------------------------------------------------------------
  // Garbage collection and stats
  // ---------------------------------------------------------------------------

  async gc(): Promise<GcResult> {
    this.checkOpen();
    return this.coordinator.mutex.runExclusive(async () => {
      this.checkOpen();

      const referencedRows = this.db.prepare(`SELECT DISTINCT blob_id AS id FROM files`).all() as Array<{
        id: string;
      }>;
      const referenced = new Set(referencedRows.map((row) => row.id));
      const activeBlobIds = this.coordinator.activeBlobIds();

      const result: GcResult = {
        removedBlobIds: [],
        removedBytes: 0,
        removedStagingDirs: [],
        removedTemporaryFiles: [],
      };

      let shardEntries: import('node:fs').Dirent[] = [];
      try {
        shardEntries = await fs.readdir(this.objectsDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      for (const shardEntry of shardEntries) {
        const shardPath = path.join(this.objectsDirectory, shardEntry.name);

        if (!shardEntry.isDirectory()) {
          if (shardEntry.isFile() && shardEntry.name.includes('.tmp-')) {
            await fs.rm(shardPath, { force: true });
            result.removedTemporaryFiles.push(shardPath);
          }
          continue;
        }

        let objectNames: string[] = [];
        try {
          objectNames = await fs.readdir(shardPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          continue;
        }

        for (const objectName of objectNames) {
          const objectPath = path.join(shardPath, objectName);

          if (!/^[a-f0-9]{64}$/.test(objectName)) {
            if (objectName.endsWith('.tmp') || objectName.includes('.tmp-')) {
              await fs.rm(objectPath, { force: true });
              result.removedTemporaryFiles.push(objectPath);
            }
            continue;
          }

          if (referenced.has(objectName) || activeBlobIds.has(objectName)) continue;

          let size = 0;
          try {
            size = (await fs.stat(objectPath)).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            continue;
          }

          await fs.rm(objectPath, { force: true });
          result.removedBlobIds.push(objectName);
          result.removedBytes += size;
          this.db.prepare(`DELETE FROM blobs WHERE id = ?`).run(objectName);
        }

        try {
          await fs.rmdir(shardPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }

      let stagingEntries: import('node:fs').Dirent[] = [];
      try {
        stagingEntries = await fs.readdir(this.stagingDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      for (const entry of stagingEntries) {
        if (!entry.isDirectory()) continue;
        const stagingPath = path.join(this.stagingDirectory, entry.name);
        if (this.coordinator.isScratchDirectoryActive(stagingPath)) continue;
        await fs.rm(stagingPath, { recursive: true, force: true });
        result.removedStagingDirs.push(stagingPath);
      }

      return result;
    });
  }

  /** Friendly alias for garbage collection. */
  async reclaim(): Promise<GcResult> {
    return this.gc();
  }

  async garbageCollect(): Promise<GcResult> {
    return this.gc();
  }

  async collectGarbage(): Promise<GcResult> {
    return this.gc();
  }

  async reclaimUnused(): Promise<GcResult> {
    return this.gc();
  }

  async stats(): Promise<ArchiveStats> {
    this.checkOpen();
    const quota = this.getQuotaInfo();

    const versionRow = this.db
      .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(pinned), 0) AS pinned, COALESCE(SUM(logical_bytes), 0) AS logical FROM versions`)
      .get() as { count: number | bigint; pinned: number | bigint; logical: number | bigint };

    const referencedRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM (SELECT DISTINCT blob_id FROM files)`)
      .get() as { count: number | bigint };

    let storedBlobCount = 0;
    try {
      const shards = await fs.readdir(this.objectsDirectory, { withFileTypes: true });
      for (const shard of shards) {
        if (!shard.isDirectory()) continue;
        const names = await fs.readdir(path.join(this.objectsDirectory, shard.name));
        storedBlobCount += names.filter((name) => /^[a-f0-9]{64}$/.test(name)).length;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    return {
      ...quota,
      root: this.root,
      versionCount: toNumber(versionRow.count),
      pinnedVersionCount: toNumber(versionRow.pinned),
      referencedBlobCount: toNumber(referencedRow.count),
      storedBlobCount,
      logicalBytes: toNumber(versionRow.logical),
      stagingBytes: await directorySize(this.stagingDirectory),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.coordinator.mutex.runExclusive(() => {
      if (this.closed) return;
      this.closed = true;
      this.db.close();
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  const { fsyncDirectory } = await import('./fs-util.js');
  await fsyncDirectory(directory);
}

export async function openArchive(
  archiveRoot: string,
  options?: OpenArchiveOptions,
): Promise<SnapshotArchive> {
  return SnapshotArchive.open(archiveRoot, options);
}
