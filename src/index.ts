export { SnapshotArchive, openArchive } from './archive.js';
export {
  AsyncMutex,
  RootCoordinator,
  coordinatorForRoot,
  resetCoordinatorRegistryForTests,
  probeSqliteLockHeld,
  isSqliteBusyError,
} from './coordinator.js';
export type { ActiveOperation, LeaseFileData, LeaseContribution, OperationKind } from './coordinator.js';
export {
  ErrorCode,
  QuotaExceededError,
  SnapshotCorruptionError,
  SnapshotError,
  TargetExistsError,
  VersionNotFoundError,
} from './errors.js';
export type { CorruptionIssue } from './errors.js';
export { planQuota, unionBytes } from './quota.js';
export type { QuotaPlan, QuotaVersionLike } from './quota.js';
export type {
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

import { SnapshotArchive, openArchive } from './archive.js';

export { SnapshotArchive as Archive };
export { SnapshotArchive as SnapshotLibrary };
export const createArchive = SnapshotArchive.open;
export const createSnapshotArchive = SnapshotArchive.open;
export const openSnapshotLibrary = openArchive;

export default {
  SnapshotArchive,
  Archive: SnapshotArchive,
  SnapshotLibrary: SnapshotArchive,
  openArchive,
  createArchive,
  createSnapshotArchive,
  openSnapshotLibrary,
};
