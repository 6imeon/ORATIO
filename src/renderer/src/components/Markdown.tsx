import { useMemo } from 'react'

/**
 * The small Markdown subset a summary actually contains.
 *
 * Deliberately not `marked` or `react-markdown`. Both emit HTML, which means
 * `dangerouslySetInnerHTML` and a sanitiser on a string that came from a
 * language model over the network — an XSS surface added to a local-first app
 * in exchange for CommonMark features (tables, footnotes, raw HTML, images,
 * autolinks) that nothing in SYSTEM_PROMPT asks for and nothing in a meeting
 * summary produces.
 *
 * This renders to React elements instead, so there is no HTML parsing step and
 * no injection to sanitise: a `<script>` in the model's output is text, and
 * renders as the characters it is.
 *
 * The supported set is exactly what the prompt asks the model for:
 *   - **bold** and *italic* (and _italic_)
 *   - `code`
 *   - "- " / "* " bullet lists
 *   - blank-line-separated paragraphs
 *
 * Anything else falls through as literal text, which is the correct failure
 * mode for a summary — an unrecognised construct shows up verbatim rather than
 * silently disappearing.
 */

/** One inline run: plain text or a styled span. */
type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean }

/**
 * Matches the three inline forms in one pass, longest-delimiter-first.
 *
 * `**` must be tried before `*` or the opening pair of a bold run would match
 * as an empty italic. Backticks come first overall because their content is
 * literal — `**not bold**` inside code has to stay as written.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g

function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0

  for (const m of text.matchAll(INLINE)) {
    const at = m.index
    if (at > last) out.push({ text: text.slice(last, at) })

    const token = m[0]
    if (m[1]) out.push({ text: token.slice(1, -1), code: true })
    else if (m[2]) out.push({ text: token.slice(2, -2), bold: true })
    else out.push({ text: token.slice(1, -1), italic: true })

    last = at + token.length
  }

  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return parseInline(text).map((run, i) => {
    const key = `${keyPrefix}-${i}`
    if (run.code) {
      return (
        <code key={key} className="rounded bg-(--color-raised) px-1 py-0.5 font-mono text-[12px]">
          {run.text}
        </code>
      )
    }
    if (run.bold) {
      return (
        <strong key={key} className="font-semibold text-(--color-ink)">
          {run.text}
        </strong>
      )
    }
    if (run.italic) return <em key={key}>{run.text}</em>
    return <span key={key}>{run.text}</span>
  })
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }

/**
 * Group lines into paragraphs and lists.
 *
 * Line-based rather than a real block parser because the input is one section
 * of a summary, not a document: there are no nested lists, no code fences and
 * no headings to get wrong. A list is any run of consecutive bullet lines, and
 * everything else accumulates into a paragraph until a blank line ends it.
 */
function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []

  const flush = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: 'p', lines: para })
      para = []
    }
  }

  for (const raw of src.split('\n')) {
    const line = raw.trimEnd()

    if (line.trim() === '') {
      flush()
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      const item = bullet[1] ?? ''
      const prev = blocks.at(-1)
      // Merged into the previous list rather than starting a new one, so a
      // three-item list is one <ul> and gets one set of margins.
      if (prev?.kind === 'ul') prev.items.push(item)
      else blocks.push({ kind: 'ul', items: [item] })
      continue
    }

    para.push(line)
  }

  flush()
  return blocks
}

/**
 * Memoised on the source string.
 *
 * This matters more here than anywhere else in the app: a summary streams in
 * token by token, and every token is a state update that re-renders this
 * component. Without the memo each section would be re-parsed on every token —
 * quadratic in the length of the section, on the UI thread, while the user
 * watches it fill in. With it, the parse happens once per delta and the cost is
 * linear in what actually changed.
 */
export function Markdown({ children }: { children: string }): React.JSX.Element {
  const blocks = useMemo(() => parseBlocks(children), [children])

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) =>
        block.kind === 'ul' ? (
          <ul key={i} className="flex list-disc flex-col gap-1 pl-4.5">
            {block.items.map((item, j) => (
              <li key={j} className="text-[13px] leading-relaxed text-(--color-ink-dim)">
                {renderInline(item, `${i}-${j}`)}
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="text-[13px] leading-relaxed text-(--color-ink-dim)">
            {/*
              Soft line breaks inside a paragraph are preserved. The model wraps
              its prose, and joining those lines with a space would be more
              correct CommonMark but would also silently reflow a deliberate
              break — and here the model's line structure is usually meaningful.
            */}
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {renderInline(line, `${i}-${j}`)}
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  )
}
