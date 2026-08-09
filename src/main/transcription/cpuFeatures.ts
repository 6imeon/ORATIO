/**
 * CPU feature detection, for one specific purpose: deciding whether
 * onnxruntime can run on this machine at all.
 *
 * onnxruntime's published builds use **AVX2 as their CPU baseline**, and they
 * execute AVX2 during *thread-pool initialisation* — before any inference is
 * requested and before any of our code can catch a failure. On a CPU without
 * it the process does not throw; it dies with `STATUS_ILLEGAL_INSTRUCTION`
 * (Windows) or `SIGILL` (POSIX).
 *
 * Because our VAD is itself an ONNX session, that crash lands at **recording
 * start, regardless of which ASR model is selected** — so no model choice is a
 * workaround, and the failure arrives at the worst possible moment. See
 * docs/WINDOWS.md §7 and ARCHITECTURE §4.6.
 *
 * Near-moot on macOS: every supported Intel Mac is Haswell or later, and Apple
 * Silicon is ARM (where onnxruntime uses NEON and this whole question does not
 * arise). It is a live population on Windows — pre-2013 CPUs, and more
 * commonly low-end or virtualised machines where AVX2 is masked off by the
 * hypervisor even though the physical CPU has it. That masking is why this
 * probes the *runtime* rather than reading a CPU model name.
 */

import { execFileSync } from 'node:child_process'
import { arch, platform } from 'node:process'
import log from 'electron-log/main'

export interface CpuFeatures {
  /**
   * Whether an onnxruntime session can be created without crashing the
   * process. False means every ONNX path must be avoided, not retried.
   */
  canRunOnnx: boolean
  /** Why, in words, for the log and the UI caveat. */
  reason: string
}

/**
 * Detection is cached for the process lifetime.
 *
 * The answer cannot change while the app runs, and the Windows probe shells
 * out — doing that once per recording would be a needless cost on the hot path
 * to starting a meeting.
 */
let cached: CpuFeatures | null = null

export function detectCpuFeatures(): CpuFeatures {
  if (!cached) {
    cached = probe()
    log.info('[cpu] feature detection', cached)
  }
  return cached
}

/** Test seam: forces a value so the fallback path can be exercised. */
export function __setCpuFeaturesForTesting(features: CpuFeatures | null): void {
  cached = features
}

function probe(): CpuFeatures {
  /*
   * ARM64 never needs AVX2 — onnxruntime targets NEON there, which is
   * architectural rather than optional. Apple Silicon and Windows-on-ARM both
   * land here.
   *
   * (Windows-on-ARM has no sherpa binary at all, so it cannot reach this code
   * in practice; that is a packaging decision recorded in docs/WINDOWS.md, not
   * something to re-derive at runtime.)
   */
  if (arch === 'arm64') {
    return { canRunOnnx: true, reason: 'arm64 — onnxruntime uses NEON, AVX2 not required' }
  }

  if (arch !== 'x64') {
    // 32-bit x86 is not a build target. If we somehow run there, prefer the
    // fallback over a crash.
    return { canRunOnnx: false, reason: `unsupported architecture ${arch}` }
  }

  try {
    const hasAvx2 = probeAvx2()
    return hasAvx2
      ? { canRunOnnx: true, reason: 'x64 with AVX2' }
      : {
          canRunOnnx: false,
          reason:
            'this CPU does not support AVX2, which onnxruntime requires. ' +
            'Common on pre-2013 processors and on virtual machines where AVX2 is masked off.',
        }
  } catch (err) {
    /*
     * A probe that fails to answer must not be read as "yes".
     *
     * Guessing wrong in the optimistic direction crashes the process at
     * recording start with no diagnostic; guessing wrong pessimistically costs
     * some VAD accuracy on a machine that could have done better. Those are not
     * remotely symmetric, so an unknown answer degrades.
     */
    log.warn('[cpu] AVX2 probe failed; assuming absent', err)
    return { canRunOnnx: false, reason: 'could not determine AVX2 support; assuming absent' }
  }
}

/**
 * Ask the OS whether the CPU exposes AVX2 *to this process*.
 *
 * Deliberately not parsed from a CPU model name. A hypervisor can mask AVX2
 * off a CPU that physically has it, and that masked case is the more common
 * one in the field — a model-name lookup reports the hardware and misses the
 * mask entirely, which is precisely the population this guard exists for.
 */
function probeAvx2(): boolean {
  if (platform === 'darwin') {
    // `machdep.cpu.leaf7_features` is where AVX2 appears on Intel Macs; the
    // key is absent on Apple Silicon, but arm64 returned before reaching here.
    const out = execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.leaf7_features'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    })
    return /\bAVX2\b/i.test(out)
  }

  if (platform === 'win32') {
    /*
     * PowerShell rather than a native call, to keep this dependency-free.
     *
     * `IsProcessorFeaturePresent(40)` is PF_AVX2_INSTRUCTIONS_AVAILABLE — the
     * documented Win32 query, and the one that reflects what the *process* can
     * actually execute, so it accounts for hypervisor masking. Reading a
     * registry CPU name would not.
     */
    const script =
      'Add-Type -MemberDefinition ' +
      "'[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint f);' " +
      "-Name N -Namespace W -PassThru | Out-Null; [W.N]::IsProcessorFeaturePresent(40)"
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    )
    return out.trim().toLowerCase() === 'true'
  }

  if (platform === 'linux') {
    const out = execFileSync('/bin/sh', ['-c', 'grep -m1 ^flags /proc/cpuinfo'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    })
    return /\bavx2\b/.test(out)
  }

  throw new Error(`no AVX2 probe for platform ${platform}`)
}

/**
 * Long enough for a cold PowerShell start on a slow machine, short enough that
 * a hung probe cannot block the start of a recording. Timing out is not fatal —
 * it degrades to the fallback via the catch above.
 */
const PROBE_TIMEOUT_MS = 5_000
