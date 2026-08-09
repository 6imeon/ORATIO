import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import log from 'electron-log/main'

const run = promisify(execFile)

/**
 * Resolve bundle IDs to the process IDs Core Audio needs for an exclusion list.
 *
 * Nothing here may throw. An exclusion is a preference about recording
 * *quality*; the recording itself matters far more, so every failure below
 * degrades to "this app is not excluded" rather than to a failed start.
 */

/**
 * How long each lookup gets before it is abandoned.
 *
 * Both commands are local and normally answer in milliseconds. The timeout is
 * here because this runs on the path between pressing record and audio flowing,
 * and a hung Spotlight query must cost a missed exclusion rather than a missed
 * meeting.
 */
const LOOKUP_TIMEOUT_MS = 2_000

/**
 * Bundle ID → the app's install path.
 *
 * Spotlight rather than a hardcoded `/Applications/<name>.app`, because the
 * name is not derivable from the bundle ID and the directory is not fixed:
 * `com.apple.Music` lives in `/System/Applications`, not `/Applications`.
 */
async function appPath(bundleId: string): Promise<string | null> {
  try {
    const { stdout } = await run('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
      timeout: LOOKUP_TIMEOUT_MS,
    })
    // Multiple hits mean several copies are installed (a stale one in
    // ~/Downloads is the usual cause). The first is as good a guess as any,
    // and picking wrong costs an exclusion that does not apply.
    return stdout.split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}

/**
 * PIDs that Core Audio can actually name in a tap.
 *
 * This filter is not optional, and getting it wrong is fatal rather than
 * cosmetic. AudioTee translates every PID given to `--exclude-processes` into
 * an AudioObjectID and **exits with "Error: failure" if any one of them fails**
 * — it does not skip the bad entry. Only processes that have produced audio
 * have an object, so passing an app's whole process tree aborts the recording:
 * measured on this machine, Spotify runs 7 processes of which 1 is an audio
 * object, and Chrome runs 38 of which 3 are.
 *
 * The list comes from a small bundled binary because nothing in the shell
 * reports it correctly. `lsof` on the CoreAudio frameworks was compared against
 * this property and disagreed in both directions — it named processes with no
 * audio object and missed two of Chrome's three.
 */
async function audioObjectPids(): Promise<Set<number>> {
  /*
   * Resolved from `app.getAppPath()`, never from `__dirname`: rollup owns
   * `out/main/` and moves modules into `chunks/` when a second entry point
   * imports them, which silently shifts every relative walk by a level
   * (CLAUDE.md build rule 5).
   */
  const appPath = app.getAppPath()
  const binary = appPath.endsWith('.asar')
    ? join(`${appPath}.unpacked`, 'resources', 'audio-processes')
    : join(appPath, 'resources', 'audio-processes')

  const { stdout } = await run(binary, [], { timeout: LOOKUP_TIMEOUT_MS })
  return new Set(
    stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  )
}

/**
 * Every PID belonging to the app at `path`.
 *
 * Matching the executable path rather than looking up one PID by bundle ID is
 * the load-bearing part: a modern app is a process *tree*, and the audio does
 * not necessarily come from the one you would name. Chrome's audio comes from
 * its main process AND two helpers, so excluding only the PID you would name
 * leaves two thirds of it audible.
 *
 * Anchored with `^` so this matches processes that ARE the app, not unrelated
 * processes that merely mention its path in their arguments.
 */
async function pidsUnder(path: string): Promise<number[]> {
  try {
    const { stdout } = await run('pgrep', ['-f', `^${path}/`], { timeout: LOOKUP_TIMEOUT_MS })
    return stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    // pgrep exits 1 when nothing matched, which `execFile` surfaces as a
    // rejection. An app that is installed but not running is the normal case,
    // not an error.
    return []
  }
}

/**
 * PIDs to keep out of the system track, for the apps the user chose to exclude.
 *
 * Resolved at spawn time rather than cached, because PIDs are only meaningful
 * for as long as the process lives: an app quit and reopened between two
 * recordings has entirely different ones, and a stale PID either excludes
 * nothing or — worse — excludes whatever process inherited the number.
 *
 * Own PID excluded from the results is not needed: we never play audio.
 */
export async function resolveExcludedPids(bundleIds: string[]): Promise<number[]> {
  if (bundleIds.length === 0) return []

  const [resolved, tappable] = await Promise.all([
    Promise.all(
      bundleIds.map(async (bundleId) => {
        const path = await appPath(bundleId)
        if (!path) {
          // Not installed, or Spotlight is not indexing that volume. Either way
          // there is nothing running to exclude.
          log.debug('[audio] could not locate app for exclusion', { bundleId })
          return []
        }
        return pidsUnder(path)
      }),
    ),
    audioObjectPids(),
  ])

  // Deduplicated: two bundle IDs can resolve to the same bundle (Music and
  // iTunes on an upgraded machine), and a repeated PID in the argv is noise.
  const tree = [...new Set(resolved.flat())]

  /*
   * Keep only what Core Audio can name. An app that is running but has never
   * played a sound has no audio object at all — verified: Preview and TextEdit
   * yield none — so this correctly returns nothing to exclude for it rather
   * than a PID that would abort the recording.
   */
  const pids = tree.filter((pid) => tappable.has(pid))

  log.info('[audio] resolved app exclusions', {
    bundleIds,
    // Both numbers, because the gap between them is the whole point: it is
    // normal and means helper processes were correctly filtered out.
    processesFound: tree.length,
    tappable: pids,
  })
  return pids
}

/**
 * Apps the user could plausibly want to exclude, for the Settings picker.
 *
 * Restricted to apps with a user-visible presence. The full process list is 74
 * entries on this machine, of which 66 are background agents — a list nobody
 * can find Spotify in is not a picker. Filtering to foreground apps leaves the
 * eight things actually open, which is the set worth choosing from.
 *
 * Names come from the same source as the bundle IDs so the picker can show
 * "Google Chrome" rather than `com.google.Chrome`.
 */
export async function listRunningApps(): Promise<{ bundleId: string; name: string }[]> {
  let stdout: string
  try {
    ;({ stdout } = await run('lsappinfo', ['list'], { timeout: LOOKUP_TIMEOUT_MS }))
  } catch (err) {
    log.warn('[audio] could not list running apps', err)
    return []
  }

  /*
   * lsappinfo prints a stanza per app; the display name and bundle ID sit on
   * different lines, and `type=` distinguishes a real app from an agent.
   * Parsed as a block rather than line-by-line because the association between
   * the three fields is positional.
   */
  const apps = new Map<string, string>()
  for (const block of stdout.split(/\n(?=\s*\d+\)\s)/)) {
    if (!block.includes('type="Foreground"')) continue
    const bundleId = /bundleID="([^"]+)"/.exec(block)?.[1]
    const name = /"([^"]+)"\s+ASN:/.exec(block)?.[1]
    if (bundleId && name) apps.set(bundleId, name)
  }

  return [...apps]
    .map(([bundleId, name]) => ({ bundleId, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
