import type { DatabaseSync } from 'node:sqlite';

const V12_COLUMNS = ['adopted', 'origin', 'adopted_by', 'adopted_at', 'pull_requests', 'pull_requests_checked_at', 'workspace_kind', 'workspace_root_key', 'workspace_root_held_at', 'workspace_resume_tokens', 'probe_attempts', 'probe_retry_at'];

/**
 * Job columns added after this fork's version 11 barrier. Version 12 is a published no-op, version 13 adds `adopted`,
 * and versions 14-16 add the workspace, pull-request and origin columns upstream shipped as 12-14.
 */
export function rowsWithoutV12(db: DatabaseSync, table: string): Record<string, unknown>[] {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
  if (table !== 'jobs') return rows;
  return rows.map((row) => Object.assign(Object.create(null), Object.fromEntries(Object.entries(row).filter(([column]) => !V12_COLUMNS.includes(column)))));
}
