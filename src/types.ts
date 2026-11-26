import type { CorruptionIssue } from './errors.js';

export interface FileEntry {
  /** Portable relative path using `/` separators. */
  path: string;
  /** Content-addressed blob ID, currently SHA-256 hex. */
  blobId: string;
  /** Raw byte length. */
  size: number;
  mode?: number;
}

export interface VersionSummary {
  id: string;
  /** Monotonic publication sequence; smaller means published earlier. */
  seq: number;
  createdAt: string;
  message?: string;
  pinned: boolean;
  /** Human-readable retention state mirroring `pinned`. */
  retention: 'pinned' | 'normal';
  fileCount: number;
  /** Sum of every file's bytes, including repeated content paths. */
  logicalBytes: number;
  /** Sum of distinct blob sizes used by this version. */
  distinctBytes: number;
}

export interface VersionDetails extends VersionSummary {
  files: FileEntry[];
  /** Explicitly archived subdirectories, including empty ones. */
  directories: string[];
}

export interface QuotaInfo {
  quotaBytes?: number;
  /** Distinct raw bytes currently referenced by published versions. */
  usedBytes: number;
  availableBytes?: number;
}

export interface EvictedVersion {
  id: string;
  seq: number;
  pinned: boolean;
}

export interface PublishResult {
  version: VersionDetails;
  evictedVersions: EvictedVersion[];
  quota: QuotaInfo & { beforeBytes: number };
  /** Blob IDs that were not referenced before this publication. */
  newBlobIds: string[];
}

export interface RestoreResult {
  versionId: string;
  targetDir: string;
  fileCount: number;
  bytes: number;
  verified: true;
}

export interface VerificationResult {
  versionId: string;
  healthy: boolean;
  fileCount: number;
  blobCount: number;
  issues: CorruptionIssue[];
  affectedFiles: string[];
}

export interface GcResult {
  removedBlobIds: string[];
  removedBytes: number;
  removedStagingDirs: string[];
  removedTemporaryFiles: string[];
}

export interface ArchiveStats extends QuotaInfo {
  root: string;
  versionCount: number;
  pinnedVersionCount: number;
  referencedBlobCount: number;
  storedBlobCount: number;
  logicalBytes: number;
  stagingBytes: number;
}

export interface OperationHooks {
  /** Test/diagnostic barrier after an operation lease becomes visible. */
  afterLease?: () => void | Promise<void>;
  /** Test/diagnostic barrier after source preparation and before publication. */
  beforePublish?: () => void | Promise<void>;
}

export type RetentionValue =
  | boolean
  | 'pinned'
  | 'unpinned'
  | 'retained'
  | 'unretained'
  | 'pin'
  | 'unpin'
  | 'keep'
  | 'release';

export interface CreateSnapshotOptions {
  message?: string;
  pinned?: boolean;
  /** Alias for `pinned`, matching the “retention marker” wording. */
  retained?: boolean;
  /** Alias for `pinned`. */
  pin?: boolean | RetentionValue;
  /** Flexible retention marker accepted in addition to `pinned`. */
  retention?: RetentionValue;
  /** Convenience override; when supplied it persists as the archive quota. */
  quotaBytes?: number | null;
  hooks?: OperationHooks;
}

export interface RestoreOptions {
  hooks?: OperationHooks;
}

export interface OpenArchiveOptions {
  /**
   * Maximum distinct referenced raw bytes. `null`/`undefined` means unlimited.
   * When provided, it is persisted as the archive's new quota policy.
   */
  quotaBytes?: number | null;
  /** @internal Fault-injection seam used by crash tests. */
  crashPoint?: 'before-commit' | 'after-commit';
}
