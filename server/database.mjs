import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function stringify(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

export class ArchiveStore {
  constructor(path = ':memory:', { Database = DatabaseSync } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archives (
        archive_id TEXT PRIMARY KEY,
        archived_at_ms INTEGER NOT NULL,
        transaction_digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS archives_by_time
        ON archives (archived_at_ms DESC, archive_id ASC);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS comments_by_archive
        ON comments (archive_id, created_at DESC, id DESC);
    `);

    this.selectArchive = this.db.prepare(
      'SELECT payload_json FROM archives WHERE archive_id = ?',
    );
    this.selectArchives = this.db.prepare(
      'SELECT payload_json FROM archives ORDER BY archived_at_ms DESC, archive_id ASC',
    );
    this.insertArchive = this.db.prepare(`
      INSERT INTO archives (
        archive_id, archived_at_ms, transaction_digest, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.updateArchive = this.db.prepare(`
      UPDATE archives SET
        archived_at_ms = ?, transaction_digest = ?, payload_json = ?, updated_at = ?
      WHERE archive_id = ?
    `);
    this.selectMeta = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
    this.upsertMeta = this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);
    this.deleteMeta = this.db.prepare('DELETE FROM metadata WHERE key = ?');
    this.selectCount = this.db.prepare('SELECT COUNT(*) AS count FROM archives');
    this.insertCommentStmt = this.db.prepare(`
      INSERT INTO comments (id, archive_id, text, created_at)
      VALUES (?, ?, ?, ?)
    `);
    this.selectCommentsStmt = this.db.prepare(`
      SELECT id, archive_id, text, created_at
      FROM comments
      WHERE archive_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);
  }

  upsertArchive(archive, now = new Date().toISOString()) {
    const archiveId = String(archive?.archiveId || '');
    if (!archiveId) throw new TypeError('archive.archiveId is required');

    const existing = this.selectArchive.get(archiveId);
    const payload = stringify(archive);
    const archivedAtMs = Number.isFinite(Number(archive.archivedAtMs))
      ? Number(archive.archivedAtMs)
      : 0;
    const transactionDigest = String(archive.transactionDigest || '');

    if (existing) {
      this.updateArchive.run(archivedAtMs, transactionDigest, payload, now, archiveId);
      return { archive, inserted: false, changed: existing.payload_json !== payload };
    }

    this.insertArchive.run(
      archiveId,
      archivedAtMs,
      transactionDigest,
      payload,
      now,
      now,
    );
    return { archive, inserted: true, changed: true };
  }

  getArchive(archiveId) {
    const row = this.selectArchive.get(archiveId);
    return row ? JSON.parse(row.payload_json) : null;
  }

  listArchives() {
    return this.selectArchives.all().map((row) => JSON.parse(row.payload_json));
  }

  countArchives() {
    return Number(this.selectCount.get().count);
  }

  getMeta(key) {
    return this.selectMeta.get(key)?.value ?? null;
  }

  setMeta(key, value) {
    if (value === null || value === undefined) {
      this.deleteMeta.run(key);
      return;
    }
    this.upsertMeta.run(key, String(value));
  }

  insertComment({ archiveId, text, id, createdAt = new Date().toISOString() }) {
    const archive = String(archiveId || '');
    const body = String(text || '').trim();
    if (!archive) throw new TypeError('comment.archiveId is required');
    if (!body) throw new TypeError('comment.text is required');
    const commentId = String(id || randomUUID());
    this.insertCommentStmt.run(commentId, archive, body, createdAt);
    return { id: commentId, archiveId: archive, text: body, createdAt };
  }

  listComments(archiveId, limit = 50) {
    const archive = String(archiveId || '');
    if (!archive) return [];
    const rows = this.selectCommentsStmt.all(archive, Number.isFinite(limit) ? limit : 50);
    return rows.map((row) => ({
      id: row.id,
      archiveId: row.archive_id,
      text: row.text,
      createdAt: row.created_at,
    }));
  }

  close() {
    this.db.close();
  }
}
