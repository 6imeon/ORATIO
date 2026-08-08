# Oratio — implementation plan

**Status:** v1 plan
**Date:** 8 August 2026
**Reads with:** [ARCHITECTURE.md](ARCHITECTURE.md) (process topology, audio,
ASR, storage) and [UI.md](UI.md) (layout J, tray, summarisation).

Architecture first, UI second — but not strictly. Phases 1–5 build a working
recorder with a throwaway UI; phase 6 onward makes it the app. The ordering
rule is: **every phase ends in something you can run and judge.**

---

## 0. Where we actually are

3,898 lines. More is scaffolded than built, and the gaps are not where the
`TODO` comments are.

| Area | State |
|---|---|
| Build config, `utilityProcess`, sherpa load path | **Verified working** (ARCHITECTURE §1) |
| Vault, `meta.json`/`transcript.json`, atomic writes | Built |
| `TranscriptionQueue`, filesystem-as-queue, `resumePending()` | **Built and exercised end to end** (phase 2) |
| VAD wrapper + hallucination filter | **Verified against real audio** (phase 2) |
| System audio (AudioTee) | Built |
| SQLite FTS5 index | Built, runs in main (wrong process) |
| AI providers + prompt + section parser | Built and typechecked; never called |
| Tray | Renders; `toggle()` is a stub, no Settings item |
| Renderer (5 components) | Renders; wrong layout, drifting timer |
| **Mic capture** | **Does not exist** — only comments referring to it |
| Model download manager | **Built and verified against the network** (phase 1) |
| ASR engine | **Built and verified** — 3 config families (phase 2) |
| **Recording controller** | **Does not exist** — 3 IPC channels declared, unhandled |

**5 of the 25 request/response IPC channels have no handler** —
`RECORDING_START`, `RECORDING_STOP`, `RECORDING_STATE`, `SESSION_GET`, and
`AI_SUMMARIZE`. The preload exposes `recording.start()`; calling it resolves
to nothing. (The 6 `EVENTS` channels are main→renderer pushes and have no
handler by design.)

### The critical path, corrected

ARCHITECTURE §7 puts the ASR worker first. That is wrong by one step: **the
worker has no model to load.** Nothing can transcribe until a model is on
disk, so the download manager comes first. It is also, per ARCHITECTURE §4.4,
the single most likely thing to fail in this ecosystem — which makes it the
right thing to build while attention is fresh.

```
models ──► ASR worker ──► mic capture ──► recording controller ──► UI
   1            2               3                  4                6
```

---

## Phase 1 — Model download manager ✅

**Nothing works until a model is on disk.** Empty directory today.

*Ends in:* pick a model in a dev harness, watch it download, verify it.

- [x] `src/main/models/ModelManager.ts` — resolve dir, check presence, report state
- [x] Download with progress → `MODEL_PROGRESS` events (throttled to 10/s; see UI.md §0 on message rate)
- [x] **Resumable** via HTTP `Range`; a 635 MB download WILL be interrupted
- [x] **Verify checksum before extract.** Corrupt weights fail deep inside sherpa with an unreadable error
- [x] **Check free disk space before starting.** Ollama-style silent failure is the pattern to avoid
- [x] Extract `.tar.bz2` → `userData/models/<id>/`, atomically (temp dir + rename)
- [x] Handlers: `MODEL_DOWNLOAD`, `MODEL_CANCEL`, `MODEL_DELETE`, plus `MODEL_STATES`
- [x] Delete partial files on cancel or failure — never leave a half-model that reads as present
- [x] Real error states surfaced, never a hang

> **Why first:** ARCHITECTURE §4.4 — across Vibe and Meetily, "failed to load
> model" outnumbers accuracy complaints. It is the top user-visible defect
> class in this category, and it is the first thing a new user touches.

### What the build actually found

All four models were downloaded and hashed on 8 Aug 2026, which changed three
things the plan had assumed:

1. **Extracted size is not download size.** The Whisper tarballs ship fp32
   weights next to the int8 ones we load. whisper-small.en advertises 636 MB
   and unpacks to **1.3 GB**, of which 924 MB is dead weight. Pruning is now
   part of install, and the disk check budgets *peak* usage (tarball +
   unpacked), not the download.

2. **Every family lays its files out differently** — Whisper is
   encoder/decoder/tokens, Moonshine is a four-stage
   preprocess/encode/uncached_decode/cached_decode, Parakeet is a transducer
   with a joiner. So presence is checked against a declared manifest. This is
   what makes "half-extracted directory" report `not-downloaded` instead of
   `ready`.

3. **Checksums are pinned, not fetched.** Upstream publishes `checksum.txt` at
   the same release tag, but a digest served by the host that served the file
   proves only transfer integrity. Pinning proves the file is the expected one
   and costs nothing, since release assets are immutable.

Two facts worth keeping for phase 2: GitHub redirects to a **signed asset URL
that expires in about an hour**, so resume must re-request the original URL;
and every tarball ships `test_wavs/0.wav`, which is a ready-made fixture for
testing ASR before recording exists.

*Verified end to end against the real network:* clean install, resume from a
100 MB partial (started at 43%, checksum still passed), cancel (settles in
~11 ms, nothing left behind), corrupt-archive rejection, retry after
corruption, idempotent re-download, and pruning. A bug was found and fixed in
the process: `statfs` throws `ENOENT` on a directory that does not exist, so
the disk check silently passed on first run — the one moment it matters.

---

## Phase 2 — ASR worker ✅

*Ends in:* a WAV on disk becomes `transcript.json`. First real transcript.

- [x] `src/main/transcription/worker/` — `utilityProcess` entry point
- [x] **One sherpa wrapper module.** Nothing else may `require('sherpa-onnx-node')` (ARCHITECTURE §4.2)
- [x] **`SHERPA_EXTERNAL_BUFFER` at every call site.** Already exported; the default `true` throws under the V8 cage on *every* recording (ARCHITECTURE §1.1)
- [x] Request/response protocol: `load` / `transcribe` / `release`
- [x] **Attach `message` handler before the child can exit**; drive the first send from `spawn` — otherwise `exit` beats `message` and the reply is lost
- [x] **`env` must be `string → string`** — `delete` the key, never assign `undefined`
- [x] `serviceName: 'oratio-asr'`, `stdio: 'pipe'`
- [x] VAD before ASR, always (existing `vad.ts`)
- [x] Run `isLikelyHallucination()` on output
- [x] One worker per job, `kill()` on completion (ARCHITECTURE §1.3 — process exit is the only reliable deallocator)
- [x] Replace the `throw` at `src/main/index.ts:83`
- [x] Both tracks transcribed, merged on the shared clock using `TrackMeta.startOffsetMs`

**Test with a fixed WAV before any recording exists.** Decouples ASR bugs from
capture bugs.

### What the build actually found

**`__dirname` cannot locate the worker.** It is the obvious way to resolve
`asr.cjs` and it is wrong: rollup hoists code shared between entry points into
`out/main/chunks/`, so the moment a second entry imports `WorkerEngine`,
`__dirname` silently becomes `.../chunks` and the fork dies with
`ERR_MODULE_NOT_FOUND`. Worse, it works whenever chunking happens not to kick
in — so it fails on a build change rather than on a code change. Resolved from
`app.getAppPath()` instead, which is stable in dev and inside the asar.

**`"type": "module"` breaks `utilityProcess.fork`.** Electron loads the main
entry through CommonJS, so `index.cjs` is unaffected by the root
`package.json` — but `fork()` goes through Node's ESM-aware resolver, which
reads that field and rejects the worker. The build now emits
`out/main/package.json` containing `{"type":"commonjs"}`; the nearest
package.json wins, so this scopes the output directory back to CJS.

**A failed model load poisoned the queue.** `TranscriptionQueue` assigned
`this.#engine` before `prepare()` resolved, so one failed load left a dead
engine cached and every subsequent job in the queue failed against a worker
that had never started — recoverable only by restarting the app. The engine is
now assigned only after loading succeeds.

**Silero VAD had no way onto disk.** It was declared in `models.ts` and
required by the pipeline, but nothing downloaded it — so ASR would have failed
on first run for every model. `ModelManager.ensureVad()` now fetches it
(digest pinned, verified 8 Aug 2026) as a prerequisite of every job.

*Verified inside real Electron* — not node, since the V8 memory cage and
`utilityProcess` only exist there. 23 checks against the real models: 0.0% WER
on all three config families (Whisper, Moonshine, Parakeet) against shipped
ground truth; VAD splitting a constructed 37 s file into exactly its two
utterances at 3.37 s and 13.96 s with the silent gap discarded; 8 s of digital
silence producing zero segments; a missing WAV rejected without killing the
worker; and the worker pid confirmed gone after `release()`, which is the whole
memory argument for `utilityProcess`. End to end, two WAVs plus `meta.json`
become a `transcript.json` with both speakers, the 2 000 ms track offset
applied, and segments sorted onto one clock.

Moonshine transcribed the same audio roughly **4× faster than Whisper base**
(0.1 s vs 0.4 s), which supports keeping it as the default.

---

## Phase 3 — Mic capture

**Currently absent.** Until this exists the two-track invariant — the whole
product — is half-built.

*Ends in:* two WAVs, correctly aligned.

- [ ] `getUserMedia` in the renderer; **AudioWorklet**, not `ScriptProcessorNode`
- [ ] Downsample to 16 kHz **with an anti-alias filter** — naive decimation folds HF noise into the speech band and measurably degrades VAD and ASR (ARCHITECTURE §3)
- [ ] Batch to 20–100 ms before crossing IPC. Never post per 128-frame quantum (~375 msg/s)
- [ ] `postMessage` with transferable `ArrayBuffer` — `send`/`invoke` cannot transfer, and 1 MB over IPC costs ~70 ms (UI.md §0)
- [ ] Record `startOffsetMs` per track — the two recorders never start on the same instant
- [ ] **Liveness check** using `LIVENESS_CHECK_MS`: if peak is exactly zero for the first seconds, tear down and restart raw
- [ ] Handle mid-stream sample-rate change as a real event, not an impossibility (ARCHITECTURE §3)

---

## Phase 4 — Recording controller

*Ends in:* press record, speak, stop, get a transcript. **The app works.**

- [ ] `RECORDING_START` / `RECORDING_STOP` / `RECORDING_STATE` handlers
- [ ] Streaming WAV writer, both tracks, **respecting backpressure** — never hold a meeting in memory (ARCHITECTURE §3)
- [ ] **Patch the WAV header every ~30 s**, not only on stop, so a crash leaves a playable file rather than a corrupt one
- [ ] Write `meta.json` on clean stop — its presence is what marks the session complete and enqueues it
- [ ] `powerSaveBlocker('prevent-app-suspension')` — *not* `prevent-display-sleep`
- [ ] **Duration from sample count, never timer ticks.** OS suspend freezes the event loop and drops ticks
- [ ] `powerMonitor` suspend/resume → mark discontinuities
- [ ] Push `micLevel` / `systemLevel` at ~30 Hz as two floats (never buffers)
- [ ] Wire the tray `toggle()` stub to this controller
- [ ] Verify `resumePending()` actually drains on next launch

---

## Phase 5 — Index worker

*Ends in:* search works and never blocks the tray.

- [ ] Move `SearchIndex` out of main into a long-lived `utilityProcess` (ARCHITECTURE §5 — better-sqlite3 is synchronous; a heavy query in main freezes the tray)
- [ ] Index on transcript write
- [ ] `SESSION_SEARCH` returns **IDs and snippets only** — never whole transcripts (UI.md §0 payload rule)
- [ ] Rebuild-by-rescan path, and a way to trigger it
- [ ] Prove it: delete the DB, confirm full recovery from files alone

---

## Phase 6 — The UI: layout J

*Ends in:* the app looks like the decision in UI.md §3a.

**Fix first (both are live bugs):**
- [ ] `RecordButton.tsx:12-16` accumulates `setElapsed(e => e + 1)` — a tick counter in a **background-throttled** renderer. It will drift. Read elapsed from `RecordingState` instead
- [ ] `tray.ts:73` — re-render on `powerMonitor` resume so the counter doesn't freeze on screen after sleep

**Then build J:**
- [ ] Notes take full width; drawer at the bottom
- [ ] **Three drawer states** — closed / half / full. Drag to resize, double-click to cycle, `⌘T` toggles
- [ ] Handle always visible; shows turn count closed, active timestamp while playing
- [ ] Persist drawer state per session
- [ ] Opening must not steal focus from the notes editor
- [ ] **Targeted reveal:** opening scrolls to the relevant turn (from search, from click-to-play)
- [ ] **Merge segments into speaker turns**, one timestamp per turn (W3C guidance, UI.md §4) — not one row per ASR segment
- [ ] Paragraphs with hanging indents, not chat bubbles
- [ ] Date grouping in the sidebar (Today / Yesterday / This week)
- [ ] Session status visible per row — `pending` / `transcribing` already exist in `SessionStatus`
- [ ] Dark mode designed, not inverted (three duplicate Meetily issues; Granola's "Windows 95" palette)

**Performance, in this order:**
- [ ] Try `content-visibility: auto` + `contain-intrinsic-size` **first** — it preserves ⌘F, selection, and scroll anchoring, which are our advantages over Granola
- [ ] Only if that fails: TanStack Virtual with dynamic measurement
- [ ] Active-line highlight mutates `className` on a ref — **never inserts or removes nodes** (Vibe shipped four `removeChild` crashes from exactly this; `timeupdate` fires up to 66×/s)
- [ ] Binary search for the active turn, not a linear scan
- [ ] Act on `mousedown` where uncancellable (~50 ms, measured by VS Code)

---

## Phase 7 — Tray, properly

*Ends in:* the app is usable without ever opening the window.

- [ ] Native `Menu` — **not** a popover window (UI.md §2)
- [ ] Three states: idle / recording / transcribing. The third is easy to forget and it is the one that says "still working"
- [ ] Recent sessions in the menu → open the window at that session
- [ ] **Settings item** — currently missing entirely
- [ ] Template icon; opacity for state (35% idle, per Apple's disabled convention)
- [ ] `setIgnoreDoubleClickEvents(true)`
- [ ] Global shortcut for start/stop, since macOS hides menu-bar extras when the bar is crowded

---

## Phase 8 — Summarisation

Prompt and parser are already written and typechecked. This is wiring.

- [ ] `AI_SUMMARIZE` handler; stream `AI_TOKEN`
- [ ] Route tokens through `createSectionParser()` into the five sections
- [ ] Render in J: grey AI text under each black user note (UI.md §6a)
- [ ] "Reset to my notes" — non-destructive, always
- [ ] Write summary into `notes.md`; it is a plain file like everything else
- [ ] Ollama auto-detect; **verify `num_ctx: 32768` is actually applied** — the 2048 default silently truncates from the front
- [ ] Keys via `safeStorage` → Keychain; `hasApiKey` sends presence, not the key
- [ ] Say plainly in the UI when text leaves the machine
- [ ] Cancel mid-stream

---

## Phase 9 — Settings & first run

*Ends in:* a new user gets to a first transcript without help.

- [ ] Settings window: Vault / Model / Recording / AI / Permissions
- [ ] **"Reveal in Finder" must actually open Finder** — the anarlog complaint
- [ ] Permissions worded honestly. `systemAudio` is *inferred*, not queried — no false green tick (ARCHITECTURE §6)
- [ ] First run does one thing: pick a vault → download default model with real progress → record button
- [ ] Model picker shows real sizes from `models.ts`

---

## Phase 10 — Hardening

- [ ] **2-hour soak.** Watch `external` and `arrayBuffers` in `process.memoryUsage()`, not `heapUsed` — buffer memory is invisible to `heapUsed`, which is exactly our risk profile
- [ ] Kill the app mid-recording; confirm a playable WAV and correct queue recovery
- [ ] Sleep the Mac mid-recording; confirm duration is still right
- [ ] Fill the disk mid-recording; confirm the failure is *reported*
- [ ] Measure first window open; pre-warm **only if** above 1 s (~50 MB permanent cost)
- [ ] Verify `enableExternalBuffer` and the `@rpath` finding still hold after any sherpa upgrade
- [ ] LICENSE file — `package.json` and README both claim MIT and there is no LICENSE

---

## Open questions that block phases

| # | Question | Blocks | Resolve by |
|---|---|---|---|
| 1 | Real inference throughput vs realtime on M-series | Whether streaming partials are viable at all | Measure in phase 2 |
| 2 | Moonshine's behaviour on silence | Hallucination filter is tuned for Whisper | Measure in phase 2 |
| 3 | Does sherpa expose `condition_on_previous_text`? | Repeat-loops in long meetings | Check in phase 2 |
| 4 | Is `content-visibility` enough for a 2-hour transcript? | Whether ⌘F and select-all survive | Test in phase 6 |
| 5 | Does AudioTee report mid-stream sample-rate changes? | Silent pitch-shifted garbage | Test in phase 3 |
| 6 | At what duration does single-pass summarisation degrade? | When chunking becomes necessary | Test in phase 8 |

---

## Deferred, deliberately

Not in v1, and each has a reason:

- **Streaming partials during recording** — only Moonshine supports it, and open question #1 decides whether it is fast enough. The UI must not look broken on non-streaming models.
- **Citations / turn IDs** — J does not need them. Add to the drawer later.
- **Folders** (Meetily #424) — date grouping plus search covers most of it; folders imply move/rename/drag and an "unfiled" concept.
- **Merging sessions** (Meetily #393) — real annoyance, not a v1 blocker.
- **Editable transcripts** (Meetily #377) — conflicts with "transcript.json is machine output"; needs a provenance design.
- **Templates** (Grain/Granola-style, section = a prompt) — our five sections are fixed for now.
- **Diarization within the `them` track** — the two-track split already solves the common case.
- **Windows** — everything platform-specific is behind `AudioCapture`. WASAPI process loopback is *better* than macOS (single-process capture), and sherpa ships Windows binaries. Remember the AVX2 pre-flight check (ARCHITECTURE §4.6).

---

## The order, in one line

**Model → ASR → mic → recording → index → UI(J) → tray → AI → settings → hardening.**

Phases 1–4 are the critical path and strictly sequential; each is unusable
without its predecessor. Phase 5 can slip. Phases 6–9 are parallelisable once
4 lands. Phase 10 gates any release.
