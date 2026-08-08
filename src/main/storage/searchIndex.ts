import Database from 'better-sqlite3'
import log from 'electron-log/main'
import type { SearchHit, Transcript } from '@shared/types'

// Lives in shared/types because it crosses to the renderer. Re-exported here so
// callers that think in terms of the index import it from the index.
export type { SearchHit }

/**
 * Full-text search across every meeting.
 *
 * This index is DERIVED. It can be deleted at any time and rebuilt by
 * rescanning the vault — nothing lives here that is not already in the plain
 * files. That constraint is what keeps the "your data is just files" promise
 * honest.
 *
 * FTS5 ships inside SQLite, so this costs no extra dependency and gives BM25
 * relevance ranking. Vector search (sqlite-vec) is deliberately deferred: for
 * meeting notes, keywords plus date and participant filters cover almost
 * every real query.
 */
export class SearchIndex {
  #db: Database.Database

  constructor(dbPath: string) {
    this.#db = new Database(dbPath)
    this.#db.pragma('journal_mode = WAL')
    this.#migrate()
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        duration_s  INTEGER NOT NULL DEFAULT 0,
        indexed_at  TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS segments USING fts5(
        session_id UNINDEXED,
        start_ms   UNINDEXED,
        speaker    UNINDEXED,
        text,
        tokenize = 'porter unicode61'
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_started
        ON sessions(started_at DESC);
    `)
  }

  /** Replace a session's rows wholesale. Idempotent, so re-indexing is safe. */
  indexSession(
    sessionId: string,
    meta: { title: string; startedAt: string; durationSeconds: number },
    transcript: Transcript,
  ): void {
    const tx = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId)
      this.#db
        .prepare(
          `INSERT INTO sessions (id, title, started_at, duration_s, indexed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             started_at = excluded.started_at,
             duration_s = excluded.duration_s,
             indexed_at = excluded.indexed_at`,
        )
        .run(
          sessionId,
          meta.title,
          meta.startedAt,
          meta.durationSeconds,
          new Date().toISOString(),
        )

      const insert = this.#db.prepare(
        'INSERT INTO segments (session_id, start_ms, speaker, text) VALUES (?, ?, ?, ?)',
      )
      for (const seg of transcript.segments) {
        insert.run(sessionId, seg.startMs, seg.speaker, seg.text)
      }
    })

    try {
      tx()
    } catch (err) {
      log.error('[search] failed to index', sessionId, err)
    }
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = toMatchQuery(query)
    if (!q) return []

    try {
      return this.#db
        .prepare(
          `SELECT s.session_id AS sessionId,
                  ss.title     AS title,
                  ss.started_at AS startedAt,
                  s.start_ms   AS startMs,
                  s.speaker    AS speaker,
                  snippet(segments, 3, '<mark>', '</mark>', '…', 20) AS snippet
             FROM segments s
             JOIN sessions ss ON ss.id = s.session_id
            WHERE segments MATCH ?
            ORDER BY bm25(segments), ss.started_at DESC
            LIMIT ?`,
        )
        .all(q, limit) as SearchHit[]
    } catch (err) {
      log.warn('[search] query failed', err)
      return []
    }
  }

  removeSession(sessionId: string): void {
    const tx = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId)
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    })
    tx()
  }

  isIndexed(sessionId: string): boolean {
    return (
      this.#db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined
    )
  }

  /**
   * Every session id the index knows about.
   *
   * Drives the incremental catch-up at startup: the vault is the truth, so
   * anything on disk that is missing here needs indexing, and anything here
   * that is missing on disk was deleted outside the app.
   */
  indexedIds(): string[] {
    const rows = this.#db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /**
   * Empty both tables, keeping the schema and the file.
   *
   * Used by rebuild. Deliberately not "delete the file and reopen": the caller
   * may be mid-rebuild when it crashes, and a truncated-but-valid database
   * rebuilds cleanly on the next launch, whereas a half-written file does not.
   * VACUUM afterwards because FTS5 leaves a lot of freed pages behind and a
   * rebuild is exactly the moment nobody is waiting on a query.
   */
  clear(): void {
    const tx = this.#db.transaction(() => {
      this.#db.exec('DELETE FROM segments')
      this.#db.exec('DELETE FROM sessions')
    })
    tx()
    this.#db.exec('VACUUM')
  }

  close(): void {
    this.#db.close()
  }
}

/**
 * Turn user input into an FTS5 MATCH expression.
 *
 * Quoting each term keeps punctuation and stray operators from being parsed
 * as FTS syntax — an unescaped `"` or `*` would otherwise throw. A trailing
 * `*` on the final term gives as-you-type prefix matching.
 */
function toMatchQuery(input: string): string | null {
  const terms = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*()]/g, ''))
    .filter(Boolean)

  if (terms.length === 0) return null
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ')
}
