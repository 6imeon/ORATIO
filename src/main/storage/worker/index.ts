import { SearchIndex } from '../searchIndex'
import type { IndexWorkerRequest, IndexWorkerResponse } from './protocol'

/**
 * Index worker entry point — runs inside a `utilityProcess`.
 *
 * better-sqlite3 is synchronous by design: every query blocks the thread it
 * runs on until SQLite returns. In main that thread also draws the tray menu
 * and services the recording controller's 30 Hz state pushes, so a full-table
 * FTS scan over a year of meetings would freeze the menu bar — the one surface
 * of this app the user can always see. ARCHITECTURE §5 puts it here for that
 * reason, and notes the isolation is cheap precisely because the index is
 * derived: if this process dies, main rescans the vault and nothing is lost.
 *
 * Long-lived, unlike the ASR worker. SQLite's footprint is bounded by its page
 * cache rather than by job size, so there is nothing that only process exit can
 * reclaim, and respawning per query would cost a database open every keystroke.
 */

let index: SearchIndex | null = null

function send(msg: IndexWorkerResponse): void {
  // parentPort is always present under utilityProcess; the guard covers this
  // file being loaded directly by a test harness.
  process.parentPort?.postMessage(msg)
}

function handle(req: IndexWorkerRequest): void {
  try {
    switch (req.type) {
      case 'open':
        // Idempotent: a second open on the same path would leak the first
        // handle and leave two connections fighting over WAL.
        index?.close()
        index = new SearchIndex(req.dbPath)
        send({ type: 'ok', id: req.id })
        break

      case 'index':
        db().indexSession(req.sessionId, req.meta, req.transcript)
        send({ type: 'ok', id: req.id })
        break

      case 'search':
        send({ type: 'ok', id: req.id, hits: db().search(req.query, req.limit) })
        break

      case 'remove':
        db().removeSession(req.sessionId)
        send({ type: 'ok', id: req.id })
        break

      case 'rebuild': {
        const target = db()
        target.clear()
        for (const s of req.sessions) {
          target.indexSession(s.sessionId, s.meta, s.transcript)
        }
        send({ type: 'ok', id: req.id, count: req.sessions.length })
        break
      }

      case 'indexedIds':
        send({ type: 'ok', id: req.id, ids: db().indexedIds() })
        break
    }
  } catch (err) {
    // Every failure comes back as a reply rather than an unhandled throw. An
    // uncaught error here exits the process, and the host would see only a mute
    // `exit` — a search box that silently stops returning results with nothing
    // in the log to explain it.
    send({
      type: 'err',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * The database, or a real error naming what went wrong.
 *
 * A request arriving before `open` means the host's startup sequence broke.
 * Saying so beats a null-dereference stack trace from inside better-sqlite3.
 */
function db(): SearchIndex {
  if (!index) throw new Error('index worker received a request before open')
  return index
}

// Attached before `ready` is sent. If the host's first request arrived with no
// listener registered, `exit` would beat `message` and the reply would be lost
// with no error anywhere — the ordering trap ARCHITECTURE §1.3 documents.
process.parentPort?.on('message', (e) => handle(e.data as IndexWorkerRequest))

// Exiting silently would strand the host on a promise that never settles.
// Better to die visibly, with the reason attached.
process.on('uncaughtException', (err) => {
  send({ type: 'err', id: -1, message: `index worker crashed: ${err.message}` })
  process.exit(1)
})

send({ type: 'ready' })
