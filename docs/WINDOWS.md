# Windows — what the port actually needs

Research completed 9 Aug 2026, against Electron 43.2.0 and the phase 12
codebase. Nothing here is built. This is the plan and the findings behind it,
written before any Windows code exists so that the reasoning survives contact
with the implementation.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the process topology this has to
fit into, and [IMPLEMENTATION.md](IMPLEMENTATION.md) for the macOS phases that
established the interfaces named below.

**Sources are cited inline.** Where a widely-repeated claim is wrong, the wrong
version is recorded next to the right one — that is the part worth keeping, and
the part that gets silently "corrected" back by the next person who reads a
stale blog post.

---

## 0. Where the codebase actually stands

Better than expected, with two specific debts.

**There are zero platform branches outside `src/main/audio/`.** No
`process.platform` checks scattered through main, the IPC layer, or the
renderer. The `AudioCapture` contract did its job.

**The microphone is already platform-independent.** It comes from the
renderer's `getUserMedia` and is pushed into the capture via `pushMicPcm`
(`src/main/audio/micPort.ts`, added in phase 3 because a menu-bar app has no
window to hold the mic). Only *system* audio is macOS-specific. The Windows
work is therefore **one loopback helper, not a capture implementation** — which
is roughly half of what the phase-11 planning assumed.

Two debts to clear first. Both are mechanical, both are worth doing regardless
of whether Windows ever ships, and both are much cheaper now than alongside a
second implementation:

1. **Four files import the concrete `MacAudioCapture`, not the interface** —
   `RecordingController.ts:40`, `ipc/index.ts:51`, `micPort.ts:14`, and the
   construction site at `index.ts:394`. They call four methods `AudioCapture`
   does not declare: `pushMicPcm`, `noteMicDiscontinuity`, `noteMicEnded`,
   `noteSuspend`. **None of these are macOS concepts** — the interface is
   simply incomplete, and the concrete type leaked in to cover the gap.
2. **`sherpa-onnx-win-*` is not installed.** This is the warning the macOS
   release build already emits. pnpm 10+ does not pull transitive platform
   binaries automatically.

---

## 1. WASAPI process loopback — the advantage is real, the floor is high

`ActivateAudioInterfaceAsync` with `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` and
`AUDIOCLIENT_ACTIVATION_PARAMS` captures **a process tree**, include or exclude,
**pre-volume**, needing **no permission at all**.

That is better than macOS on every axis that cost us time: no TCC grant, no
consent prompt, no screen-recording indicator, and no post-mixer problem. The
"record Zoom without recording Spotify" win that `AudioCapture`'s header comment
has promised since phase 3 is genuinely available here.

| | Classic loopback | Process loopback |
|---|---|---|
| Scope | One endpoint, everything on it | One process tree, include **or** exclude |
| Volume | Post-mixer | Pre-mixer |
| Self-exclusion | Impossible | `EXCLUDE_TARGET_PROCESS_TREE` on our own PID |

**Minimum: Windows 10 Build 20348.** Verified directly against Microsoft's
requirements table on
[PROCESS_LOOPBACK_MODE](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode)
— `req.target-min-winverclnt: Windows 10 Build 20348` — not from the sample
repo or a blog. That is 21H2-era; treat it as **Windows 11 and late Windows 10
only**.

> **The commonly-cited "Windows 10 2004+" is wrong.** The `loopback-capture`
> README says it. 2004 is build 19041, four builds short. Trust Microsoft's
> table. This matters because 19041 machines are numerous enough that shipping
> against the wrong floor would fail in the field rather than in testing, and
> the API does not fail loudly — it fails at activation.

Below 20348 there is only classic device loopback: post-mixer, no
self-exclusion. That is the same compromise `desktopCapturer` was rejected for
on macOS, so it is a **degraded path, and should be labelled as one in the UI**
rather than silently substituted.

**Shared-mode capture only.** And loopback yields nothing while nothing is
playing — silence arrives as `AUDCLNT_BUFFERFLAGS_SILENT`, or possibly as no
buffer at all (see §7, untested). The helper must synthesize silence to keep
the two tracks aligned; this is the Windows form of the phase-3 lesson that
duration comes from sample counts, never wall-clock.

---

## 2. Don't take a native-addon dependency

The npm ecosystem for process loopback is thin enough that depending on it
would be the riskiest decision in this port.

- **`loopback-capture`** ([WerdoxDev](https://github.com/WerdoxDev/loopback-capture))
  is the only package doing real process loopback. Verified against the npm
  registry on 9 Aug 2026: **one published version** (2.0.0, 2026-07-20), 10
  GitHub stars, and — decisively — `scripts` contains `compile`/`clean`/`build`
  but **no `install`**. It ships a committed `.node` built against plain Node
  with nothing wired to rebuild it, so under Electron it is the wrong ABI.
  `napi_versions: [9]` is declared, which would in principle make it
  ABI-stable, but a checked-in binary with no `prebuilds/` layout defeats the
  detection paths in both `@electron/rebuild` and `prebuild-install`.
  **Excellent reference source; not a dependency.**
- `audify`, `naudiodon` — device loopback at best; `naudiodon` last published
  2021.
- `electron-audio-loopback` — wraps `desktopCapturer`, reintroducing the
  screen-recording permission we deliberately avoided.

**Ship a small C++ helper `.exe` writing PCM to stdout, exactly as AudioTee
works today.** Microsoft's
[ApplicationLoopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
is directly reusable (~300 lines).

The reason is not preference — it is that **a child process sidesteps every
native-module scar already recorded in CLAUDE.md**: no `@electron/rebuild`, no
per-Electron-version prebuild matrix, no `.node` ABI coupling, and no
`process.dlopen` thread-safety concern. Four of the five build-config rules in
CLAUDE.md exist because of bundled natives. A helper binary has none of them,
and a crash in it cannot take down main.

**The asar rules carry over verbatim.** Resolve the helper from
`app.getAppPath() + '.unpacked'`, never `__dirname`, and check the containing
directory with `statSync(dir).isDirectory()` — `existsSync` is faked by the
asar shim on Windows too, so it returns `true` in exactly the case where
unpacking failed.

---

## 3. Exclude-mode is the better default

Given both modes, **exclude our own process tree** rather than include the
meeting's.

Include-mode needs a correct meeting PID before capture can be correct, which
makes the most fragile component — detection — load-bearing for the most
important guarantee. Exclude-mode captures everything except us, so it survives
a user switching from Zoom to Meet mid-call, an app nobody anticipated, and a
detector that guessed wrong. It also removes our own notification sounds and
playback from the "them" track for free.

This is the same reasoning as phase 11's exclusion-not-inclusion decision, and
it lands the same way: **exclusion fails toward recording too much, inclusion
fails toward recording nothing.** Detection then serves only the UX question
("a meeting seems to have started — record?"), where a false positive costs one
click.

---

## 4. The microphone will silently destroy speaker attribution

**Open the mic with `echoCancellation`, `noiseSuppression` and
`autoGainControl` all explicitly `false`.**

Chromium enables AEC by default on Windows, and AEC works by *subtracting
system audio from the mic signal* — which is precisely the mic/system
separation the whole two-track design exists to preserve. Left on, it degrades
speaker attribution in a way that looks like a transcription-quality problem,
not a capture bug, so it would be debugged in the wrong place.

This is the Windows analogue of the macOS voice-processing trap in CLAUDE.md
§3, and it fails just as quietly. Unlike that one it produces plausible audio
rather than digital silence, so `LIVENESS_CHECK_MS` will not catch it.

Otherwise `getUserMedia` is sufficient and materially easier than macOS:
`systemPreferences.askForMediaAccess()` is macOS-only and does not exist as a
functioning call on Windows ([electron#23283](https://github.com/electron/electron/issues/23283)),
because there is no per-app prompt to trigger. A `setPermissionRequestHandler`
in main is still required or the request may be auto-denied.

---

## 5. Permissions — weaker than TCC, and only reactively detectable

Unpackaged (NSIS) Electron apps are classed as **desktop apps** and governed by
one global toggle: *"Let desktop apps access your microphone."* On by default
since 1903. There is **no per-desktop-app allow/deny** — the list beneath that
toggle is informational. Enterprise GPO can force it off via
`LetAppsAccessMicrophone`.

`Windows.Media.Capture` is an MSIX/UWP manifest concept and does not apply.

**Detection is reactive only.** `getUserMedia` rejects with `NotAllowedError`
when the OS toggle is off — the same error as a Chromium-level denial, so the
exception alone cannot distinguish them. Reading the registry toggle
disambiguates. With no prompt to trigger, the correct UX is to catch the
failure and deep-link to `ms-settings:privacy-microphone` via
`shell.openExternal`.

**System-audio loopback needs no permission whatsoever**, so the macOS gotcha
about un-queryable system-audio TCC state has no Windows counterpart. That
whole class of problem disappears.

---

## 6. Meeting detection — better than macOS, for once

`IAudioSessionManager2::GetSessionEnumerator` on a **capture** endpoint,
filtered to `AudioSessionStateActive`, with owners resolved via
`IAudioSessionControl2::GetProcessId`. This is the true analogue of
`kAudioProcessPropertyIsRunningInput`.

**It is event-driven** — `IAudioSessionNotification` / `IAudioSessionEvents` —
so unlike phase 12 on macOS there is no polling and no 1 s tick. The phase 12
finding that macOS listeners cannot work (a new app opening the mic appears as
a *new* object, so no listener is on it yet) does not apply here.

`GetProcessId` returns `AUDCLNT_S_NO_SINGLE_PROCESS` for multi-process sessions
and yields only the creating PID. Browsers and Electron-based meeting apps are
exactly that case — the same shape as the phase-12 discovery that one Chrome
call spans three bundle IDs. Process-*tree* semantics largely absorb it.

**The registry is a tempting shortcut and should stay a pre-filter at most.**
`HKCU\...\CapabilityAccessManager\ConsentStore\microphone`, with desktop apps
under `NonPackaged` keyed by exe path (`\` → `#`), where **`LastUsedTimeStop ==
0` means in use**. Readable from pure Node with no native code — but it is
undocumented by Microsoft, version-sensitive, per-user, and reports **exe paths
rather than PIDs**, so it cannot drive capture on its own.

---

## 7. Untested — verify empirically before committing

Flagged explicitly because each would be discovered late and expensively:

- **Does idle process loopback deliver silence-flagged buffers, or no buffers
  at all?** No authoritative documentation found. This **directly determines
  two-track time alignment** and therefore the correctness of every merged
  transcript. Test first; it shapes the helper's buffer loop.
- **`ConsentStore` behaviour on the actual target builds.** Undocumented and
  known to have shifted across versions.
- **Multi-process PID resolution** for browsers and Electron-based meeting
  apps.
- **Whether sherpa-onnx's Windows binaries load cleanly in a `utilityProcess`**
  — the macOS equivalent (no `DYLD_LIBRARY_PATH`, no relinking) is upstream's
  property, not ours, and CLAUDE.md already requires re-verifying it after
  every sherpa upgrade. It cannot be assumed to hold on a different platform.

### AVX2 is the one that will actually bite

Already established in [ARCHITECTURE.md §4.6](ARCHITECTURE.md) and repeated
here because it is the **most severe Windows-specific risk in this document**,
and it is not in any of the research above.

onnxruntime is built with **AVX2 as the CPU baseline** and executes it during
*thread pool init*, before any inference runs. Pre-Haswell machines die with
`STATUS_ILLEGAL_INSTRUCTION`. Because our VAD is itself an ONNX session, this
crashes **at recording start, regardless of which ASR model is selected** — so
no model choice is a workaround, and the failure lands at the worst possible
moment.

Near-moot on macOS (all supported Intel Macs are Haswell+, Apple Silicon is
ARM). On Windows it is a live population: pre-2013 CPUs and, more commonly,
low-end and virtualised machines where AVX2 is masked off.

**Pre-flight CPU feature detection with an energy-based VAD fallback is
mandatory**, and it belongs in W2 alongside the build-20348 gate — both are
"detect the floor before capture starts, degrade visibly rather than crash".

---

## 8. Signing and distribution

**Target `nsis`.** Per-user install to `%LOCALAPPDATA%`, no admin rights,
integrates with `electron-updater`. MSIX is actively wrong here: its container
would complicate filesystem access to a user-chosen vault folder, which is
**directly at odds with the plain-files-are-the-source-of-truth invariant**.
MSI is for enterprise GPO deployment; Squirrel is legacy.

> **The EV certificate SmartScreen bypass was removed in 2024.** EV now builds
> reputation exactly like OV, and Microsoft states the premium is no longer
> justified. Every guide recommending EV-for-SmartScreen predates this — this
> is the single most expensive piece of stale advice in the Windows ecosystem.

Options, given hardware key storage has been mandatory for OV since June 2023:

| | Cost | Note |
|---|---|---|
| SignPath Foundation | Free | Qualifying open-source only — **likely the best fit** |
| Azure Artifact Signing | ~$10/mo | **Individuals: USA/Canada only** — check eligibility *first* |
| OV cert | $150–300/yr | Hardware token; painful in CI |

Azure "Trusted Signing" was renamed **Azure Artifact Signing**; both names
appear in docs, and electron-builder's key remains `azureSignOptions` (mutually
exclusive with `signtoolOptions`).

**Reputation accrues per file hash**, so every release resets it. Expect
SmartScreen warnings on new releases regardless of which option is chosen — no
non-Store path buys instant trust.

---

## Phase W1 — Make the interface honest *(no Windows code)*

Worth doing regardless of whether Windows ships. Pure refactor, fully
verifiable on macOS.

- [ ] Add `pushMicPcm`, `noteMicDiscontinuity`, `noteMicEnded`, `noteSuspend` to the `AudioCapture` interface
- [ ] Switch `RecordingController`, `ipc/index.ts` and `micPort.ts` to import the interface, not `MacAudioCapture`
- [ ] Keep the concrete type only at the construction site in `index.ts`
- [ ] Add `sherpa-onnx-win-*` to `optionalDependencies`
- [ ] Confirm no `process.platform` branch has crept in above `src/main/audio/`

### Verification

- [ ] `pnpm typecheck` clean
- [ ] Record on macOS, mic and system tracks unchanged — this phase must be behaviour-neutral
- [ ] `grep` shows no `MacAudioCapture` import outside `src/main/audio/` and `index.ts`

---

## Phase W2 — The loopback helper

- [ ] C++ helper from the ApplicationLoopback sample; PCM to stdout, framed as AudioTee's output is
- [ ] Default to `EXCLUDE_TARGET_PROCESS_TREE` on our own PID (§3)
- [ ] **Test the idle-silence question first** (§7) — it determines the buffer loop
- [ ] Synthesize silence so the system track stays aligned with the mic track
- [ ] Detect build 20348 at runtime; fall back to classic loopback with a **visible** quality caveat
- [ ] **Pre-flight AVX2 detection with an energy-based VAD fallback** (§7) — without it, recording start crashes outright on pre-Haswell and AVX2-masked machines
- [ ] Add to `asarUnpack`; resolve via `app.getAppPath() + '.unpacked'`, guard with `statSync(dir).isDirectory()`
- [ ] Attach a permanent `error` listener at spawn — an unhandled `error` event kills main (phases 11 and 12 both hit this)

### Verification

- [ ] System track captures a meeting with our own playback excluded
- [ ] Sample counts match between tracks across a recording with long silences
- [ ] Verify the spawned argv by logging it, not by inferring it from the audio
- [ ] Helper dies with its parent; no orphan after quit or crash
- [ ] Correct and executable from inside a packaged app, not just in dev
- [ ] Behaviour on a sub-20348 machine is the labelled fallback, not a failure
- [ ] Recording starts on a machine without AVX2 — test with AVX2 masked in a VM, not by assuming

---

## Phase W3 — Mic and permissions

- [ ] `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl` **explicitly false** (§4)
- [ ] `setPermissionRequestHandler` in main
- [ ] Catch `NotAllowedError`; deep-link to `ms-settings:privacy-microphone`
- [ ] Read the registry toggle to distinguish OS denial from Chromium denial
- [ ] Confirm no macOS-only Electron API is called on Windows (`askForMediaAccess`)

### Verification

- [ ] Record speech on both tracks simultaneously; confirm the mic track does **not** have system audio subtracted — the AEC failure is silent and plausible, so this must be checked deliberately
- [ ] Denial path reaches the right Settings page
- [ ] Mic hot-plug mid-recording produces a discontinuity, not a dead track

---

## Phase W4 — Detection

- [ ] `IAudioSessionManager2` capture-endpoint enumeration in the helper
- [ ] Event-driven via `IAudioSessionNotification`; **no polling** (§6)
- [ ] Handle `AUDCLNT_S_NO_SINGLE_PROCESS` for multi-process apps
- [ ] Reuse the phase 12 suggestion UX unchanged — offer only, never auto-start
- [ ] Respect the existing `meetingSuggestions` setting

### Verification

- [ ] Fires once for a sustained call, not once per helper process
- [ ] Fires twice for two calls — proves call-end reset
- [ ] Silent for a non-meeting app using the mic
- [ ] Nothing at all with the setting off

---

## Phase W5 — Build and ship

- [ ] `nsis` target in `electron-builder.yml`
- [ ] Extend the `files` allow-list deliberately — it fails closed by design
- [ ] Resolve signing eligibility **before** building the pipeline (§8)
- [ ] `electron-updater` wired to the signed artifact

### Verification

- [ ] Installs and runs on a clean Windows 11 VM with no dev tools present
- [ ] Installs without admin rights
- [ ] Model download, transcription, search and export all work end to end
- [ ] Vault path with spaces and non-ASCII characters round-trips
- [ ] Uninstall leaves the vault untouched — it is the user's data, not ours

---

## What this does not change

The invariants hold unchanged on Windows, and none of the above requires
bending one:

- Transcription stays local — sherpa-onnx ships Windows binaries. "Inference
  ports for free" is the standing claim and it is **not quite true**: it is
  subject to §7's `utilityProcess` load check and, more seriously, the AVX2
  pre-flight. The *code* ports for free; the *deployment* does not.
- The two tracks are still never mixed.
- Plain files remain the source of truth; the SQLite index stays derived.
- VAD still runs before ASR.
- The filesystem is still the queue.
