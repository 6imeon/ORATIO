import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Compile the Core Audio process-list probe.
 *
 * Run before packaging (see the `build` script). Its output is committed to
 * `resources/` so a plain `pnpm dev` on a fresh clone works without a compiler
 * — this only has to run when the C source changes.
 *
 * Built universal despite `build:mac` targeting arm64 only. The extra slice
 * costs about 50 KB, and the failure it prevents is the silent kind this
 * codebase keeps getting bitten by: an Intel build would ship a binary that
 * cannot exec, exclusions would quietly stop working, and nothing would say so.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native', 'audio-processes.c')
const out = join(root, 'resources', 'audio-processes')

mkdirSync(dirname(out), { recursive: true })

execFileSync(
  'clang',
  [
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-O2',
    // Matches electron-builder.yml's minimum. Building against a newer SDK
    // without this can reference symbols that are absent on macOS 13.
    '-mmacosx-version-min=13.0',
    '-framework',
    'CoreAudio',
    // CFStringRef, for the bundle IDs watch mode reports.
    '-framework',
    'CoreFoundation',
    '-o',
    out,
    source,
  ],
  { stdio: 'inherit' },
)

if (!existsSync(out)) throw new Error(`clang reported success but ${out} is missing`)

// Proof it runs, rather than proof it compiled. A binary for the wrong
// architecture links fine and fails only on exec.
execFileSync(out, { stdio: 'ignore' })

console.log(`[native] built ${out}`)
