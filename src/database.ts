import { DatabaseSync } from 'node:sqlite';

export interface VersionRow {
  id: string;
  seq: number | bigint;
  created_at: string;
  message: string | null;
  pinned: number | bigint;
  file_count: number | bigint;
  logical_bytes: number | bigint;
  distinct_bytes: number | bigint;
}

export interface FileRow {
  version_id: string;
  path: string;
  blob_id: string;
  size: number | bigint;
  mode: number | bigint | null;
}

export interface BlobRow {
  id: string;
  size: number | bigint;
}

export function openDatabase(databasePath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS archive_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      message TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL,
      logical_bytes INTEGER NOT NULL,
      distinct_bytes INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      blob_id TEXT NOT NULL,
      size INTEGER NOT NULL,
      mode INTEGER,
      PRIMARY KEY (version_id, path)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_files_blob_id ON files(blob_id);

    CREATE TABLE IF NOT EXISTS directories (
      version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      mode INTEGER,
      PRIMARY KEY (version_id, path)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY,
      size INTEGER NOT NULL
    );
  `);

  return db;
}

/** node:sqlite may return INTEGER values as numbers unless readBigInts is set. */
export function toNumber(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}
