import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, SessionMeta, Transcript } from '@shared/types'

/**
 * The vault: a plain folder the user chooses, holding one directory per
 * session.
 *
 *   <vault>/
 *     2026.08.08-1430-standup/
 *       mic.wav          your side
 *       system.wav       everyone else
 *       meta.json        timings, per-track offsets, model used
 *       transcript.json  canonical transcript
 *       notes.md         your notes + AI summary (YAML frontmatter)
 *       transcribe.log
 *     index.sqlite       search index — DERIVED, safe to delete
 *
 * Two rules make this a real differentiator rather than a detail:
 *
 *   1. PLAIN FILES ARE THE SOURCE OF TRUTH. Markdown and JSON, greppable,
 *      diffable, git-friendly, readable in thirty years by anything. Granola
 *      encrypted its local database and broke every workflow users had built
 *      on top of it; people left for plain markdown in git and said so
 *      loudly. Be the opposite of that.
 *
 *   2. SQLITE IS ONLY AN INDEX. Delete it and the app rebuilds it by
 *      rescanning the vault. Nothing may live there that is not recoverable
 *      from the files.
 *
 * Because the vault is an ordinary folder, iCloud/Dropbox sync works for free
 * if the user puts it there — their choice, not ours.
 */

export const FILES = {
  mic: 'mic.wav',
  system: 'system.wav',
  meta: 'meta.json',
  transcript: 'transcript.json',
  notes: 'notes.md',
  log: 'transcribe.log',
} as const

export function sessionDir(vaultPath: string, sessionId: string): string {
  return join(vaultPath, sessionId)
}

/**
 * Session id doubles as the directory name, so it must sort chronologically
 * and survive a filesystem round-trip: `2026.08.08-1430`.
 */
export function makeSessionId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}.${p(date.getMonth() + 1)}.${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}`
  )
}

export async function createSessionDir(vaultPath: string, date = new Date()): Promise<string> {
  const base = makeSessionId(date)
  let dir = join(vaultPath, base)
  let n = 2
  while (existsSync(dir)) {
    dir = join(vaultPath, `${base}-${n}`)
    n++
  }
  await mkdir(dir, { recursive: true })
  return dir
}

export async function readMeta(dir: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(join(dir, FILES.meta), 'utf8')) as SessionMeta
  } catch {
    return null
  }
}

export async function writeMeta(dir: string, meta: SessionMeta): Promise<void> {
  await writeFile(join(dir, FILES.meta), JSON.stringify(meta, null, 2), 'utf8')
}

export async function readTranscript(dir: string): Promise<Transcript | null> {
  try {
    return JSON.parse(await readFile(join(dir, FILES.transcript), 'utf8')) as Transcript
  } catch {
    return null
  }
}

export async function readNotes(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, FILES.notes), 'utf8')
  } catch {
    return ''
  }
}

export async function writeNotes(dir: string, markdown: string): Promise<void> {
  await writeFile(join(dir, FILES.notes), markdown, 'utf8')
}

/** Enumerate every session by scanning the vault — no database involved. */
export async function listSessions(vaultPath: string): Promise<Session[]> {
  let entries: string[]
  try {
    entries = await readdir(vaultPath)
  } catch {
    return []
  }

  const sessions: Session[] = []

  for (const name of entries) {
    const dir = join(vaultPath, name)
    let s
    try {
      s = await stat(dir)
    } catch {
      continue
    }
    if (!s.isDirectory()) continue

    const meta = await readMeta(dir)
    if (!meta) continue

    const hasTranscript = existsSync(join(dir, FILES.transcript))
    sessions.push({
      id: meta.id,
      dir,
      title: meta.title,
      startedAt: meta.startedAt,
      durationSeconds: meta.durationSeconds,
      status: hasTranscript ? 'ready' : 'pending',
      hasNotes: existsSync(join(dir, FILES.notes)),
    })
  }

  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export async function deleteSession(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Render notes.md. YAML frontmatter keeps it useful in Obsidian and any other
 * markdown tool without extra export machinery.
 */
export function renderNotes(opts: {
  title: string
  startedAt: string
  durationSeconds: number
  userNotes: string
  summary?: string
}): string {
  const mins = Math.round(opts.durationSeconds / 60)
  const lines = [
    '---',
    `title: ${JSON.stringify(opts.title)}`,
    `date: ${opts.startedAt}`,
    `duration_minutes: ${mins}`,
    'tags: [meeting]',
    '---',
    '',
    `# ${opts.title}`,
    '',
  ]

  if (opts.summary) lines.push('## Summary', '', opts.summary.trim(), '')
  if (opts.userNotes.trim()) lines.push('## Notes', '', opts.userNotes.trim(), '')

  return lines.join('\n')
}
