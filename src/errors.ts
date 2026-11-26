/**
 * Stable error codes used by the snapshot archive.
 * Library callers can branch on `error.code` instead of matching messages.
 */
export const ErrorCode = {
  ArchiveClosed: 'ARCHIVE_CLOSED',
  SourceNotFound: 'SOURCE_NOT_DIRECTORY',
  VersionNotFound: 'VERSION_NOT_FOUND',
  TargetExists: 'TARGET_EXISTS',
  QuotaExceeded: 'QUOTA_EXCEEDED',
  SnapshotCorrupt: 'SNAPSHOT_CORRUPT',
  UnsupportedFileType: 'UNSUPPORTED_FILE_TYPE',
  InvalidPath: 'INVALID_PATH',
  InvalidOptions: 'INVALID_OPTIONS',
  IoError: 'IO_ERROR',
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

export class SnapshotError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.details = details;
  }
}

export class VersionNotFoundError extends SnapshotError {
  constructor(versionId: string) {
    super(ErrorCode.VersionNotFound, `找不到已发布版本：${versionId}`, { versionId });
    this.name = 'VersionNotFoundError';
  }
}

export class TargetExistsError extends SnapshotError {
  constructor(targetDir: string) {
    super(ErrorCode.TargetExists, `恢复目标必须是尚不存在的新目录：${targetDir}`, { targetDir });
    this.name = 'TargetExistsError';
  }
}

export class QuotaExceededError extends SnapshotError {
  readonly quotaBytes?: number;
  readonly requiredBytes?: number;

  constructor(message: string, details?: unknown) {
    super(ErrorCode.QuotaExceeded, message, details);
    if (details && typeof details === 'object') {
      const record = details as Record<string, unknown>;
      if (typeof record.quotaBytes === 'number') this.quotaBytes = record.quotaBytes;
      if (typeof record.requiredBytes === 'number') this.requiredBytes = record.requiredBytes;
      if (typeof record.irreducibleBytes === 'number') this.requiredBytes = record.irreducibleBytes;
    }
    this.name = 'QuotaExceededError';
  }
}

export interface CorruptionIssue {
  code: 'MISSING_BLOB' | 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'READ_ERROR';
  blobId: string;
  /** Manifest paths affected by this damaged content. */
  files: string[];
  message: string;
  expected?: string | number;
  actual?: string | number;
}

export class SnapshotCorruptionError extends SnapshotError {
  readonly issues: CorruptionIssue[];
  readonly affectedFiles: string[];
  /** Aliases for callers using different naming conventions. */
  readonly damagedFiles: string[];
  readonly filePaths: string[];

  constructor(issues: CorruptionIssue[]) {
    const affectedFiles = Array.from(new Set(issues.flatMap((issue) => issue.files))).sort();
    const message =
      `快照整版校验失败：${issues.length} 个内容块损坏，影响 ${affectedFiles.length} 个文件；` +
      '未交付恢复目录。';
    super(ErrorCode.SnapshotCorrupt, message, { issues, affectedFiles });
    this.name = 'SnapshotCorruptionError';
    this.issues = issues;
    this.affectedFiles = affectedFiles;
    this.damagedFiles = affectedFiles;
    this.filePaths = affectedFiles;
  }
}
