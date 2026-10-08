import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function asTimestamp(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function iso(value) {
  return value === null || value === undefined ? null : new Date(Number(value)).toISOString();
}

function rowToJob(row) {
  if (!row) return null;
  const note = parseJson(row.note_json, null);
  const state = parseJson(row.state_json, { published: {}, media: {} });
  const plan = parseJson(row.plan_json, null);
  return {
    id: row.id,
    noteId: row.id,
    note,
    payload: note,
    note_json: row.note_json,
    plan,
    plan_json: row.plan_json,
    state,
    state_json: row.state_json,
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextRetryAt: row.next_retry_at === null ? null : iso(row.next_retry_at),
    next_retry_at: row.next_retry_at === null ? null : iso(row.next_retry_at),
    error: row.last_error || null,
    last_error: row.last_error || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    completed_at: iso(row.completed_at),
  };
}

/** Synchronous SQLite queue. One process owns connection; transactions make claims atomic. */
export function createStore(databasePath = process.env.DATABASE_PATH || '/data/misskey-to-x.sqlite') {
  if (databasePath !== ':memory:' && !String(databasePath).startsWith('file::memory:')) {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      note_json TEXT NOT NULL,
      plan_json TEXT,
      state_json TEXT NOT NULL DEFAULT '{"published":{},"media":{}}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retry', 'completed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(status, next_retry_at, created_at);
  `);

  const selectById = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, note_json, plan_json, state_json, status, attempts, next_retry_at, last_error, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'queued', 0, NULL, NULL, ?, ?)
  `);

  function getJob(id) { return rowToJob(selectById.get(String(id))); }

  function insertJob(noteOrJob) {
    const note = noteOrJob?.note || noteOrJob?.payload || noteOrJob;
    const id = String(noteOrJob?.noteId || noteOrJob?.id || note?.id || '');
    if (!id) throw new TypeError('note.id is required');
    const timestamp = Date.now();
    const initialState = noteOrJob?.state || { published: {}, media: {} };
    const result = insert.run(id, JSON.stringify(note), JSON.stringify(initialState), timestamp, timestamp);
    const inserted = Number(result.changes || 0) === 1;
    return { inserted, duplicate: !inserted, job: getJob(id) };
  }

  function claimNextJob(now = Date.now()) {
    const timestamp = asTimestamp(now);
    db.exec('BEGIN IMMEDIATE');
    try {
      const candidate = db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('queued', 'retry')
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at ASC LIMIT 1
      `).get(timestamp);
      if (!candidate) { db.exec('COMMIT'); return null; }
      const update = db.prepare(`
        UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'retry')
      `).run(Date.now(), candidate.id);
      if (Number(update.changes || 0) !== 1) { db.exec('COMMIT'); return null; }
      const claimed = getJob(candidate.id);
      db.exec('COMMIT');
      return claimed;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve original failure. */ }
      throw error;
    }
  }

  function recoverProcessing(now = Date.now()) {
    const timestamp = asTimestamp(now);
    const result = db.prepare(`
      UPDATE jobs SET status = 'retry', next_retry_at = ?,
        last_error = COALESCE(last_error, 'worker restarted'), updated_at = ?
      WHERE status = 'processing'
    `).run(timestamp, timestamp);
    return Number(result.changes || 0);
  }

  function savePlanAndState(id, plan, state) {
    const result = db.prepare(`
      UPDATE jobs SET plan_json = ?, state_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(plan ?? null), JSON.stringify(state || { published: {}, media: {} }), Date.now(), String(id));
    return Number(result.changes || 0) === 1;
  }

  function saveState(id, state) {
    const result = db.prepare('UPDATE jobs SET state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state || { published: {}, media: {} }), Date.now(), String(id));
    return Number(result.changes || 0) === 1;
  }

  function markCompleted(id, state) {
    const timestamp = Date.now();
    const result = db.prepare(`
      UPDATE jobs SET status = 'completed', state_json = COALESCE(?, state_json), next_retry_at = NULL,
        last_error = NULL, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(state ? JSON.stringify(state) : null, timestamp, timestamp, String(id));
    return Number(result.changes || 0) === 1;
  }

  function markRetry(id, attempts, error, nextRetryAt, state) {
    const timestamp = Date.now();
    const result = db.prepare(`
      UPDATE jobs SET status = 'retry', attempts = ?, state_json = COALESCE(?, state_json),
        last_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ?
    `).run(
      Math.max(0, Math.trunc(Number(attempts) || 0)),
      state ? JSON.stringify(state) : null,
      error == null ? null : String(error).slice(0, 4000),
      asTimestamp(nextRetryAt, timestamp), timestamp, String(id),
    );
    return Number(result.changes || 0) === 1;
  }

  function markDead(id, error, state) {
    const timestamp = Date.now();
    const result = db.prepare(`
      UPDATE jobs SET status = 'dead', state_json = COALESCE(?, state_json), next_retry_at = NULL,
        last_error = ?, updated_at = ? WHERE id = ?
    `).run(state ? JSON.stringify(state) : null, error == null ? null : String(error).slice(0, 4000), timestamp, String(id));
    return Number(result.changes || 0) === 1;
  }

  function close() { db.close(); }

  return {
    insertJob,
    claimNextJob,
    loadJob: getJob,
    getJob,
    savePlanAndState,
    saveState,
    markCompleted,
    markRetry,
    markDead,
    recoverProcessing,
    close,
  };
}

export default createStore;
