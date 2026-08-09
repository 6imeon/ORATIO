import { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import log from 'electron-log/main'
import type { ExportFormat, ExportSource } from './formats'
import {
  FORMATS,
  toMarkdown,
  toPlainText,
  toSrt,
  toTranscriptJson,
  toVtt,
} from './formats'
import { toHtml } from './html'
import { buildDocx } from './docx'

/**
 * Write one meeting to one file.
 *
 * The dialog and the vault reads happen in the IPC handler; this takes loaded
 * data and a path and produces the file, so every format can be exercised
 * without a window or a user.
 */

export interface ExportOptions {
  /** Append the full transcript after the notes. Ignored by transcript-only formats. */
  includeTranscript: boolean
}

export async function writeExport(
  src: ExportSource,
  format: ExportFormat,
  destination: string,
  opts: ExportOptions,
): Promise<void> {
  const spec = FORMATS[format]

  // Checked here rather than only in the UI: the menu disables these when there
  // is no transcript, but an export triggered by a shortcut or a stale window
  // would otherwise write a file containing the word "undefined".
  if (spec.needsTranscript && !src.transcript) {
    throw new Error('This meeting has not been transcribed yet, so there is nothing to export.')
  }

  switch (format) {
    case 'md':
      return writeFile(destination, toMarkdown(src), 'utf8')
    case 'txt':
      return writeFile(destination, toPlainText(src), 'utf8')
    case 'srt':
      return writeFile(destination, toSrt(src.transcript!), 'utf8')
    case 'vtt':
      return writeFile(destination, toVtt(src.transcript!), 'utf8')
    case 'json':
      return writeFile(destination, toTranscriptJson(src.transcript!), 'utf8')
    case 'pdf':
      return writePdf(toHtml(src, opts), destination)
    case 'docx':
      return writeDocx(src, opts, destination)
  }
}

/**
 * PDF via a hidden WebContents.
 *
 * Electron already contains a complete layout engine and a PDF writer, so
 * pulling in a PDF library would mean shipping a second, worse one — and every
 * JS PDF library needs its own font handling, which is where they go wrong on
 * anything but ASCII. `printToPDF` gets the system fonts and correct text
 * shaping for free.
 *
 * `loadURL` with a data: URL rather than a temp file, so a failed export leaves
 * nothing behind and there is no path to collide with a concurrent one.
 */
async function writePdf(html: string, destination: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // Nothing in this document needs privileges, and it contains model output
      // and user text. `offscreen` keeps it off the screen even momentarily;
      // no preload and no node integration mean the page cannot reach anything
      // if the escaping in html.ts is ever wrong.
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: false,
    },
  })

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    const pdf = await win.webContents.printToPDF({
      // Margins come from the @page rule in the document's own stylesheet, so
      // the HTML controls its layout and this stays a transport.
      printBackground: true,
      pageSize: 'A4',
    })

    await writeFile(destination, pdf)
  } finally {
    // Always, including on a load failure — an orphaned offscreen window is
    // invisible by definition, so it would never be noticed.
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Word, as real OOXML.
 *
 * The tempting shortcut is HTML with Word's XML namespaces and a `.docx`
 * extension — Word opens it. But the file is a lie: it is not a ZIP, not
 * OOXML, and Word says so on save, Pages and Google Docs handle it
 * inconsistently, and anything that inspects the file properly rejects it.
 * "Export to Word" that produces a file Word complains about is not the
 * feature.
 *
 * `docx` builds the real thing — a ZIP of OOXML parts — in pure JS with no
 * native addon and no DOM, so it bundles normally and stays out of the
 * asarUnpack list that better-sqlite3, sherpa and audiotee live on.
 */
async function writeDocx(src: ExportSource, opts: ExportOptions, destination: string): Promise<void> {
  const buffer = await buildDocx(src, opts)
  await writeFile(destination, buffer)
  log.info('[export] wrote Word document', { destination })
}
