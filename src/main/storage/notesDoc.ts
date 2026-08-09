import { SUMMARY_SECTIONS, type SummarySection } from '../ai/AIProvider'

/**
 * `notes.md`, parsed.
 *
 * The user's notes and the AI summary live in ONE file rather than two,
 * because plain files are the source of truth (vault.ts) and a meeting whose
 * record is split across `notes.md` and `summary.md` is not a record — it is
 * two halves the user has to reassemble in Obsidian. One file also means the
 * summary syncs, greps, and diffs with everything else for free.
 *
 * But one file means the two halves have to be separable again on read, and
 * that is the whole reason this module exists. The renderer round-trips the
 * user's half through a textarea and autosaves it 600 ms later; if a parse
 * ever misclassifies summary text as user text, that autosave writes the
 * model's words into the user's notes and the original is gone. So the
 * boundary is an explicit marker, not a heuristic.
 */
export interface NotesDoc {
  /** What the user typed. The only half the textarea may ever write. */
  userNotes: string
  /**
   * The AI summary, by section, in `SUMMARY_SECTIONS` order. Empty when the
   * meeting has never been summarised — which is the normal state, since the
   * AI layer is strictly optional.
   */
  summary: Partial<Record<SummarySection, string>>
  /** When the summary was produced, and by whom. Null when there is none. */
  generatedAt: string | null
  provider: string | null
}

/**
 * The line that separates the user's half from the model's.
 *
 * An HTML comment, so every Markdown renderer — Obsidian, GitHub, a static
 * site generator — displays the file as ordinary prose with no stray syntax
 * visible. It survives a round trip through those tools untouched, which a
 * bare `---` rule or a YAML key would not: `---` is ambiguous with frontmatter
 * and with a horizontal rule the user might type themselves.
 *
 * Deliberately verbose rather than a terse sentinel. Someone opening this file
 * in a text editor with no knowledge of Oratio should be able to work out what
 * the line is for and that deleting it is safe.
 */
const SUMMARY_OPEN = '<!-- oratio:summary -->'
const SUMMARY_CLOSE = '<!-- /oratio:summary -->'

/** Per-section heading inside the summary block. */
const sectionHeading = (s: SummarySection): string => `## ${s}`

/**
 * Split `notes.md` into its two halves.
 *
 * Never throws and never returns null: a file the user has edited by hand,
 * truncated, or half-deleted still has to open. Anything this cannot classify
 * as summary is returned as user notes, which is the safe direction to fail —
 * showing the user some machine text in their editor is recoverable, silently
 * dropping a paragraph they wrote is not.
 */
export function parseNotes(markdown: string): NotesDoc {
  const open = markdown.indexOf(SUMMARY_OPEN)
  if (open === -1) {
    return { userNotes: stripHeader(markdown), summary: {}, generatedAt: null, provider: null }
  }

  const closeAt = markdown.indexOf(SUMMARY_CLOSE, open)
  // An unterminated block means the app died mid-write. Treat the rest of the
  // file as the summary rather than as notes: the alternative would hand the
  // half-written model output back to the textarea, whose autosave would then
  // adopt it as the user's own text.
  const body = markdown.slice(
    open + SUMMARY_OPEN.length,
    closeAt === -1 ? undefined : closeAt,
  )

  const after = closeAt === -1 ? '' : markdown.slice(closeAt + SUMMARY_CLOSE.length)

  return {
    // Notes can exist on both sides of the block if the user typed below it.
    userNotes: stripHeader(markdown.slice(0, open) + after),
    ...parseSummaryBody(body),
  }
}

function parseSummaryBody(body: string): Omit<NotesDoc, 'userNotes'> {
  const summary: Partial<Record<SummarySection, string>> = {}
  let generatedAt: string | null = null
  let provider: string | null = null

  let current: SummarySection | null = null
  let buffer: string[] = []

  const commit = (): void => {
    if (!current) return
    const text = buffer.join('\n').trim()
    if (text) summary[current] = text
    buffer = []
  }

  for (const line of body.split('\n')) {
    const meta = /^<!--\s*oratio:meta\s+(.*?)\s*-->$/.exec(line)
    if (meta?.[1]) {
      generatedAt = /generatedAt="([^"]*)"/.exec(meta[1])?.[1] ?? null
      provider = /provider="([^"]*)"/.exec(meta[1])?.[1] ?? null
      continue
    }

    const heading = SUMMARY_SECTIONS.find((s) => line.trim() === sectionHeading(s))
    if (heading) {
      commit()
      current = heading
      continue
    }
    if (current) buffer.push(line)
  }
  commit()

  return { summary, generatedAt, provider }
}

/**
 * Render the two halves back into one file.
 *
 * The user's notes go FIRST, above the summary, because they are what the user
 * wrote and this is their file. It also means opening `notes.md` anywhere else
 * shows their own words at the top rather than a wall of generated text.
 *
 * Frontmatter is included so the file drops into an Obsidian vault and is
 * immediately queryable by date and duration with no export step — the
 * "nothing to export because plain files *are* the storage" claim in UI.md
 * only holds if the files are actually well-formed for the tools people use.
 */
export function renderNotesDoc(opts: {
  title: string
  startedAt: string
  durationSeconds: number
  doc: NotesDoc
}): string {
  const { doc } = opts
  const mins = Math.round(opts.durationSeconds / 60)

  const out = [
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

  const notes = doc.userNotes.trim()
  if (notes) out.push(notes, '')

  const sections = SUMMARY_SECTIONS.filter((s) => doc.summary[s]?.trim())
  if (sections.length > 0) {
    out.push(SUMMARY_OPEN)
    out.push(
      `<!-- oratio:meta generatedAt="${doc.generatedAt ?? ''}" provider="${doc.provider ?? ''}" -->`,
    )
    out.push('')
    for (const s of sections) {
      out.push(sectionHeading(s), '', doc.summary[s]?.trim() ?? '', '')
    }
    out.push(SUMMARY_CLOSE, '')
  }

  return out.join('\n')
}

/**
 * Strip the frontmatter and title heading this module itself emits.
 *
 * Applied inside `parseNotes`, so `userNotes` is only ever what the user
 * typed — never YAML they did not write. That matters beyond tidiness: the
 * renderer round-trips `userNotes` through a textarea and hands it straight
 * back to be re-rendered, so a header left in the field would be re-emitted
 * below the fresh one and the file would grow a copy per save.
 *
 * Idempotent, and safe on a file that has no header at all — a vault synced
 * from an older version, or one the user wrote by hand.
 */
export function stripHeader(userNotes: string): string {
  let text = userNotes
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) text = text.slice(text.indexOf('\n', end + 1) + 1)
  }
  // Drop a single leading `# Title` — the window already shows the title, and
  // leaving it makes the first line of every meeting's notes redundant.
  return text.replace(/^\s*#\s+[^\n]*\n?/, '').trim()
}
