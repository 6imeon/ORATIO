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
| System audio (AudioTee) | Built; **byte format corrected to Int16** (phase 3) |
| SQLite FTS5 index | **Moved to its own `utilityProcess`; rebuild-by-rescan verified** (phase 5) |
| AI providers + prompt + section parser | **Wired and verified** — streaming, cancel, `num_ctx` against a fake Ollama (phase 8) |
| `notes.md` document model | **Built and verified** — the user's notes and the AI summary are separate fields, so neither can overwrite the other (phase 8) |
| Tray | **Built and verified** — three states, Recent, Settings, global shortcut; the icon asset was missing entirely (phase 7) |
| Renderer | **Layout J built and verified** (phase 6); **Settings editable and first-run flow built** (phase 9) |
| Permissions | **`systemAudio` genuinely inferred** — observed at stop, persisted to `capture-health.json`, read back and worded as evidence rather than status (phase 9) |
| Mic capture | **Built and verified** — worklet → port → WAV, lossless (phase 3) |
| Model download manager | **Built and verified against the network** (phase 1) |
| ASR engine | **Built and verified** — 3 config families (phase 2) |
| **Recording controller** | **Built and verified end to end** (phase 4) |
| **Index worker** | **Built and verified** — tray-freeze measured, DB deleted and recovered (phase 5) |

**Every request/response IPC channel now has a handler.** `AI_SUMMARIZE` was
the last gap and phase 8 wired it, alongside three new channels it needed:
`AI_CANCEL`, `AI_SUMMARY_GET` and `AI_SUMMARY_CLEAR`. Phase 9 added two more —
`SETTINGS_REVEAL_VAULT` (distinct from `SESSION_REVEAL`, which reveals one
meeting's `notes.md` and cannot answer for a vault that does not exist yet) and
`SETTINGS_OPEN_EXTERNAL`, allow-listed by scheme. `NAV_PENDING` was added
in phase 7 and is handled in
`index.ts` rather than `registerIpc`, because it reads window state. `RECORDING_START`, `RECORDING_STOP`, `RECORDING_STATE`
and `SESSION_GET` were the phase 4 gap and are now handled. (The `EVENTS`
channels are main→renderer pushes and have no handler by design.)

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

## Phase 3 — Mic capture ✅

*Ends in:* two WAVs, correctly aligned.

- [x] `getUserMedia` in the renderer; **AudioWorklet**, not `ScriptProcessorNode`
- [x] Downsample to 16 kHz **with an anti-alias filter** — naive decimation folds HF noise into the speech band and measurably degrades VAD and ASR (ARCHITECTURE §3)
- [x] Batch to 20–100 ms before crossing IPC. Never post per 128-frame quantum (~375 msg/s)
- [x] `postMessage` with transferable `ArrayBuffer` — `send`/`invoke` cannot transfer, and 1 MB over IPC costs ~70 ms (UI.md §0)
- [x] Record `startOffsetMs` per track — the two recorders never start on the same instant
- [x] **Liveness check** using `LIVENESS_CHECK_MS`: if peak is exactly zero for the first seconds, tear down and restart raw
- [x] Handle mid-stream sample-rate change as a real event, not an impossibility (ARCHITECTURE §3)

### What the build actually found

**A bare `ArrayBuffer` cannot cross contextBridge — and fails silently.**
The checklist says to `postMessage` a transferable `ArrayBuffer`, and that is
what the transport does — but the transfer has to happen **preload-side**, past
the bridge. Passing a buffer *into* a contextBridge-exposed function delivers
nothing to main, and `postMessage` accepts it without raising: every chunk
arrives detached at zero bytes, producing a full-length recording of silence
with a completely clean log. The renderer now hands over a `Float32Array`,
which survives, and the preload rebuilds and transfers the buffer in its own
realm. Cost is one 2.5 KB copy per 40 ms chunk.

**AudioTee emits Int16, not Float32 — the system track was never valid.**
Pre-existing, and not part of this phase's scope. Its README states that
specifying *any* sample rate switches the encoding to 16-bit signed integers,
and we always request 16 kHz. Decoded as Float32, the peak amplitude came back
as `3.4e38` and the whole system track was noise — while still producing a
plausible WAV of the right length, which is why it survived phase 2. A range
check on the first buffer of every recording now turns this class of bug into
an error instead of a silently ruined track.

**Duration and discontinuities are tracked per track.** `TrackResult` carries
`samples` and `discontinuities`, so duration comes from the sample count rather
than wall clock, and suspends and device-rate changes are marked at the
millisecond offset where they happened. `startOffsetMs` itself is computed by
the recording controller in phase 4, from the `firstBufferAt` this phase
records.

**The WAV header is patched every 30 s**, not only at stop, so a crash leaves a
playable truncated file. Backpressure is respected: past the stream's
high-water mark buffers are dropped and marked rather than accumulated, because
Node's docs are explicit that ignoring it produces RSS that is never returned.

### Verification

Two harnesses, both against the real code:

*Resampler (Node, headless):* the shipped worklet loaded with stubbed
`AudioWorkletGlobalScope` globals. 48 kHz, 44.1 kHz, 32 kHz and 16 kHz inputs;
unity passband at 1 kHz, ≤1 ms drift over 2 s, no block-boundary
discontinuity, and — the point of the exercise — **a 13 kHz tone rejected at
−95 dB**. The control case matters: naive decimation folds that same tone into
the speech band at 3 kHz at **0 dB**, full amplitude. Batching measured at 24–25
messages/s against 375 `process()` calls, and `stop` verified to flush a
partial chunk rather than drop the end of the meeting.

*Capture path (real Electron, 21 checks):* `getUserMedia` → worklet → port →
main → WAV, with `--use-fake-device-for-media-capture`. PCM reaches main
(126 KB / 4 s), `firstBufferAt` agrees across processes to within 1 ms, level
events at ~25/s, duration from sample count within 40 ms, header sizes correct,
a second recording on the same objects clean, and the suspend marker landing at
exactly 500 ms. Chromium's fake device turned out to emit low-level noise
rather than a documented tone, so sample *fidelity* is proven separately by
pushing a known 440 Hz tone through the same port: **all 32 000 samples
arrived, amplitude 0.8000 as sent, 128 dB above the 1 kHz noise floor.** The
system track now decodes to a peak of 0.088 rather than 3.4e38.

Not yet covered: multi-hour recordings, a real device rate change (the rebuild
path is exercised only by its watcher), and mic audio has not yet been run
through ASR end to end — that arrives with the phase 4 controller.

---

## Phase 4 — Recording controller ✅

*Ends in:* press record, speak, stop, get a transcript. **The app works.**

- [x] `RECORDING_START` / `RECORDING_STOP` / `RECORDING_STATE` handlers
- [x] Streaming WAV writer, both tracks, **respecting backpressure** — never hold a meeting in memory (ARCHITECTURE §3)
- [x] **Patch the WAV header every ~30 s**, not only on stop, so a crash leaves a playable file rather than a corrupt one
- [x] Write `meta.json` on clean stop — its presence is what marks the session complete and enqueues it
- [x] Carry `discardAudio` from `RECORDING_START` into `meta.json`, defaulting from `Settings.discardAudioByDefault`, with the pre-record toggle in the UI
- [x] `powerSaveBlocker('prevent-app-suspension')` — *not* `prevent-display-sleep`
- [x] **Duration from sample count, never timer ticks.** OS suspend freezes the event loop and drops ticks
- [x] `powerMonitor` suspend/resume → mark discontinuities
- [x] Push `micLevel` / `systemLevel` at ~30 Hz as two floats (never buffers)
- [x] Wire the tray `toggle()` stub to this controller
- [x] Verify `resumePending()` actually drains on next launch

### What the build actually found

**The controller had to live in main and *drive* the renderer, not the other
way round.** `getUserMedia` exists only in the renderer, so the obvious design
is a renderer that owns recording and pushes audio down. That design cannot
express this app: Oratio is a menu-bar app, the tray must be able to start a
meeting with no window open, and closing the window mid-meeting must not end
it. So main owns the recording and sends `MIC_START`/`MIC_STOP` to the
renderer, which is reduced to a device driver for the one API main cannot
reach. A window opened mid-meeting asks main whether it may take the mic
(`RECORDING_CLAIM_MIC`) rather than deciding for itself — two windows both
running `getUserMedia` would interleave two streams into one WAV, which is
silently wrong rather than loudly broken.

**The ASR worker path was still wrong, in a second way.** Phase 2 replaced
`__dirname` with `app.getAppPath()` and that fixed the chunking trap — but
`getAppPath()` is the project root under `electron-vite dev` and `out/main`
when the built output is launched directly, so the join produced
`out/main/out/main/asr.cjs`. It worked in `pnpm dev` and nowhere else, which is
why phase 2 could not have caught it: phase 4 is the first thing to run the
worker outside the dev server. Both layouts are now tried, and the error names
every path it looked in rather than reporting one.

**`startOffsetMs` is not a formality.** Measured across a real recording, the
mic and the system tap started **85 ms apart** — two independent subsystems
with different startup costs, exactly as ARCHITECTURE §3 predicted. Assuming
zero would put every "me" line 85 ms out against every "them" line.

**Elapsed time is pushed, not counted.** `RecordButton` previously accumulated
`setElapsed(e => e + 1)` on an interval, which a backgrounded renderer throttles
to once a minute — and a menu-bar app during a meeting is backgrounded almost
by definition. The counter now reads `elapsedSeconds` from the pushed
`RecordingState`. That is deliberately wall-clock, unlike the duration in
`meta.json`: a person watching a timer expects to see time that passed,
including a suspend, while the file must match the audio.

### Verification

*Real Electron, 59 checks, all passing.* Headless for the controller and the
system tap; with a window and `--use-fake-device-for-media-capture` for the mic.

`buildMeta` is pure, so it is checked exhaustively: duration taken from sample
count where the wall clock says 60 s and the audio says 10 s; the earlier track
anchoring at 0 whichever track it is; a track that captured nothing omitted
rather than handed to VAD as an empty WAV; `discardAudio: false` written as
*absent* so pre-existing sessions still mean keep; and no NaN when both tracks
are empty.

Live: `meta.json` provably absent while recording and present after, a second
`start()` refused, `stop()` while idle returning null rather than throwing, RIFF
and data sizes matching the bytes on disk, and the declared duration agreeing
with the sample count within half a second.

**The exit criterion, met end to end:** speech played through the system output,
captured by the tap, transcribed locally by Moonshine, and written to
`transcript.json` as *"Quarterly report is due on friday"* — attributed to
`them` structurally, from which file it was in. With a window attached, both
tracks record into one session and `startOffsetMs` comes out as a real measured
85 ms.

Also proven here rather than assumed: a session recorded with `discardAudio`
loses both WAVs and keeps a non-empty transcript with `audioDiscardedAt`
stamped; and a mid-recording WAV already carries a valid RIFF/WAVE header, so a
force-quit leaves a playable file rather than one every tool reports as empty.

Not yet covered: multi-hour recordings and a real device rate change (still
only exercised through its watcher). Both belong to phase 10.

---

## Phase 5 — Index worker ✅

*Ends in:* search works and never blocks the tray.

- [x] Move `SearchIndex` out of main into a long-lived `utilityProcess` (ARCHITECTURE §5 — better-sqlite3 is synchronous; a heavy query in main freezes the tray)
- [x] Index on transcript write
- [x] `SESSION_SEARCH` returns **IDs and snippets only** — never whole transcripts (UI.md §0 payload rule)
- [x] Rebuild-by-rescan path, and a way to trigger it
- [x] Prove it: delete the DB, confirm full recovery from files alone

### What the build actually found

**The tray-freeze argument is real, and now measured rather than asserted.**
ARCHITECTURE §5 claims a synchronous query in main freezes the menu bar. The
harness runs both: indexing 20 000 segments through the worker let main's event
loop tick **9 times in 46 ms**, while the identical work done in-process
delivered **0 ticks in 36 ms** — the loop was unavailable for its entire
duration. That is the freeze, reproduced on demand, and it is what the extra
process buys.

**This worker is long-lived, unlike the ASR worker — deliberately.** The
one-process-per-job discipline in phase 2 exists because inference leaks and
`kill()` is the only reliable deallocator. SQLite has no equivalent problem: its
footprint is bounded by the page cache, not by job size. Respawning per query
would mean opening the database on every keystroke of an as-you-type search, so
it is spawned once at startup and killed on `before-quit`. That shutdown is not
optional — nothing else ever kills it, and an orphan would outlive the app
holding a WAL lock.

**The rollup entry key had to be `index-worker`, not `index`.** The obvious name
collides with the main entry and silently overwrites `out/main/index.cjs` with
the worker — an app that boots straight into a SQLite process and never shows a
window. Caught at build time by watching the emitted file list rather than at
runtime.

**A crash is not repaired automatically, on purpose.** The index is derived, so
the honest failure mode is that search stops working until the next launch
rebuilds it. Silently respawning would hide a crash loop behind a search box
that appears to work every other query. `SESSION_SEARCH` returns no results
rather than rejecting, so a dead worker makes the search box go quiet instead of
throwing a dialog on every keystroke, and the reason is in the log.

**Startup reconcile is bidirectional.** Sessions on disk the index has never
seen get added, *and* sessions the index still holds that are gone from disk get
dropped. The second half is not hypothetical: these are the user's files in a
folder they chose, so deleting a session in Finder is a supported action, and a
stale hit that opens nothing is worse than no hit at all.

**`SearchHit` moved to `shared/types.ts`.** It crosses to the renderer, which
cannot import from `main/`. The preload binding for `search` was also untyped —
it returned `any` — so the payload rule was unenforced at the one boundary where
it matters.

### Verification

*Real Electron, 39 checks, all passing* — the only place `utilityProcess` exists
and the only place better-sqlite3 is built against the right ABI.

The payload rule is checked structurally, not by eye: a hit's keys are asserted
to contain no `segments` or `transcript` field, and a real result measures
**193 bytes**. Query handling covers prefix matching (`quart` → hit), Porter
stemming (`reports` matches "report"), and six malformed FTS5 inputs — `"`, `*`,
`a AND`, `NEAR(`, `)(`, `""` — none of which throw.

**Rebuild by rescan, proven the hard way:** a vault of three transcribed
sessions plus one recorded-but-not-yet-transcribed, then `index.sqlite` and its
`-wal`/`-shm` deleted outright and the worker restarted. It reopens an empty
database, returns nothing, and rebuilds to all three from the files alone — with
the untranscribed session correctly skipped rather than indexed empty.

Crash handling is exercised by `SIGKILL`ing the worker mid-life: the outstanding
query rejects with *"Index worker exited unexpectedly (code 9)"* rather than
hanging forever, main survives, and a fresh client recovers the index intact.
`close()` is confirmed to actually reap the process (checked with `kill -0`) and
to be safe to call twice.

---

## Phase 6 — The UI: layout J ✅

*Ends in:* the app looks like the decision in UI.md §3a.

**Fix first (both were live bugs — done in phase 4, since both were one-line
consequences of wiring the controller):**
- [x] `RecordButton.tsx:12-16` accumulates `setElapsed(e => e + 1)` — a tick counter in a **background-throttled** renderer. It will drift. Read elapsed from `RecordingState` instead
- [x] `tray.ts:73` — re-render on `powerMonitor` resume so the counter doesn't freeze on screen after sleep

**Then build J:**
- [x] Notes take full width; drawer at the bottom
- [x] **Three drawer states** — closed / half / full. Drag to resize, double-click to cycle, `⌘T` toggles
- [x] Handle always visible; shows turn count closed, active timestamp while playing
- [x] Persist drawer state per session
- [x] Opening must not steal focus from the notes editor
- [x] **Targeted reveal:** opening scrolls to the relevant turn (from search, from click-to-play)
- [x] **Merge segments into speaker turns**, one timestamp per turn (W3C guidance, UI.md §4) — not one row per ASR segment
- [x] Paragraphs with hanging indents, not chat bubbles
- [x] Date grouping in the sidebar (Today / Yesterday / This week)
- [x] Session status visible per row — `pending` / `transcribing` already exist in `SessionStatus`
- [x] Dark mode designed, not inverted (three duplicate Meetily issues; Granola's "Windows 95" palette)

**Performance, in this order:**
- [x] Try `content-visibility: auto` + `contain-intrinsic-size` **first** — it preserves ⌘F, selection, and scroll anchoring, which are our advantages over Granola
- [x] Only if that fails: TanStack Virtual with dynamic measurement — **not needed, see below**
- [x] Active-line highlight mutates `className` on a ref — **never inserts or removes nodes** (Vibe shipped four `removeChild` crashes from exactly this; `timeupdate` fires up to 66×/s)
- [x] Binary search for the active turn, not a linear scan
- [x] Act on `mousedown` where uncancellable (~50 ms, measured by VS Code)

### What the build actually found

**Open question #1 is answered: `content-visibility` is enough, and TanStack
Virtual is not needed.** A 4 000-segment transcript merges to 1 334 turns, all
of them in the DOM, and 40 forced scroll-and-layout passes over the full list
complete in **1 ms**. That keeps ⌘F, select-all across the whole transcript, and
scroll anchoring — three of the four things we do that Granola doesn't — which
every JS windowing library would have cost us. The second bullet above is ticked
as *deliberately not done*.

**Turn merging is the bigger win, and it comes first.** 4 000 ASR segments
become 1 334 turns before any rendering strategy is chosen — a 3× cut in row
count from following the W3C paragraph guidance, not from optimisation. The
merge is memoised once per transcript in `MeetingView` and passed down, because
the reveal path and the render path both need turns and merging twice per
transcript is exactly the avoidable work UI.md §4 warns about.

**A same-speaker gap has to split a turn.** Merging purely on speaker identity
turns ten minutes of one person talking into a single unscrollable paragraph
with one timestamp at the top, which destroys the seek granularity
click-to-play depends on. `TURN_GAP_MS = 6 s` splits on a real pause — longer
than the breath pauses inside a sentence, shorter than a genuine stop.

**Two real bugs, both found by the harness rather than by eye:**

1. **Every click on the drawer handle was a zero-distance drag.** `pointerdown`
   started a resize unconditionally, so the `pointerup` that ended it snapped
   and *persisted* a state — which then raced the double-click's cycle and
   silently overwrote it. The handle is both a button and a drag surface, so
   the two gestures now have to be told apart by movement: no drag begins until
   the pointer has moved `DRAG_THRESHOLD_PX`.
2. **Double-click did nothing across most of the handle.** The inner label
   button called `stopPropagation()`, so the cycle gesture only worked on the
   few pixels of bare handle either side of it — while the label is the obvious
   thing to aim at. The button no longer stops propagation, and ignores
   `detail > 1` so the second click of a double-click doesn't also toggle.

**Focus preservation is one line, and it is load-bearing.** `preventDefault()`
on the handle's `mousedown` is what leaves the caret mid-sentence in the notes
editor while the drawer opens underneath. Without it, opening the drawer to
check a name costs you your place in the note you were writing — verified by
asserting `document.activeElement` and the exact `selectionStart` across the
open.

**Drawer state lives in `localStorage`, not in the vault.** `meta.json` is the
recording's own record and is read by the transcription queue on a later launch,
so putting view state there means the queue's input changes when someone drags a
divider; `Settings` is global and this is per session. "Plain files are the
source of truth" governs content, and a drawer height is not content.

**The palette is tokens, not `dark:` variants.** A theme spread across fifty
utility classes cannot be reviewed as a theme, which is how the "gray on gray…
Windows 95" outcome happens. Both themes are declared as one set of custom
properties over three states — bare `:root`, `prefers-color-scheme` guarded
against an explicit light choice, and `[data-theme="dark"]` — so the manual
override wins in either direction.

### Verification

*43 pure-logic checks and 47 checks in real Electron, all passing.* The DOM half
runs the actual built renderer in a real `BrowserWindow`, because
`content-visibility`, the class-mutation highlight path, the theme cascade and
`localStorage` do not exist anywhere else.

**The Vibe crash class is tested directly.** A `MutationObserver` watches the
drawer subtree while the highlight is moved 300 times the way `timeupdate`
would: **zero `childList` mutations**, and the row count is unchanged. The
highlight only ever adds and removes a class on an already-rendered node.

**The binary search is checked against a linear scan** at ~20 000 probe points
over 2 000 turns — zero disagreements, including before the first turn, exactly
on a boundary, in the gaps between turns, and past the end. It averages
**0.00003 ms** per lookup, against a budget set by `timeupdate` firing 66×/s.

The drawer state machine is exercised as a sequence rather than per-state:
closed by default → open at half → double-click to full → double-click to closed
→ `⌘T` reopens **at full, not half** (the last open size is remembered) →
persisted to `localStorage` → a different session opens closed → returning
restores it. Date bucketing is checked at the boundaries that actually break:
00:05 today lands in Today, and on a Monday last Friday is still "This week",
because a calendar week would be one day long and put it under a month heading.

---

## Phase 7 — Tray, properly ✅

*Ends in:* the app is usable without ever opening the window.

- [x] Native `Menu` — **not** a popover window (UI.md §2)
- [x] Three states: idle / recording / transcribing. The third is easy to forget and it is the one that says "still working"
- [x] Recent sessions in the menu → open the window at that session
- [x] **Settings item** — currently missing entirely
- [x] Template icon; opacity for state (35% idle, per Apple's disabled convention)
- [x] `setIgnoreDoubleClickEvents(true)` — done in phase 4: without it a double-click fires the menu item twice, and the second fire *stops* the recording the first just started
- [x] Global shortcut for start/stop, since macOS hides menu-bar extras when the bar is crowded

### What the build actually found

**The tray icon did not exist.** `resources/` was an empty directory and
`tray.ts` pointed at `resources/trayTemplate.png`. `nativeImage.createFromPath`
does not throw on a missing file — it returns an *empty image*, and an empty
tray image on macOS is an invisible menu-bar item. With `LSUIElement: true` and
no Dock icon, that means the app had **no visible surface at all** once the
window was closed. It fails exactly the way §"macOS gotchas" warns: a success
return code and nothing on screen. The asset is now generated as a pure-alpha
16 pt circle in an 18 pt box at 1× and 2×, and `createTray` logs an explicit
error when the image comes back empty rather than leaving it silent.

**That error check immediately caught a second bug — and it is the same bug
phase 2 hit.** The icon path was resolved from `__dirname`, but rollup decides
which chunk a module lands in: `tray.ts` is currently emitted into
`out/main/chunks/`, one level deeper than `out/main/`, exactly as
`WorkerEngine` was when it could not find `asr.cjs`. The relative walk silently
changes meaning whenever the bundler regroups the code, so it breaks on a
*build* change rather than a code change. It now resolves from
`app.getAppPath()`, the same fix phase 2 landed on.

> **This is now a repeat offender, so treat it as a rule: never resolve a
> bundled asset or worker path from `__dirname` in main.** Rollup owns that
> directory and will move it. Use `app.getAppPath()`. Phase 2 lost time to it
> pointing at a worker; phase 7 lost time to it pointing at an icon, where the
> failure mode was an *invisible menu-bar item* rather than an exception.

**Electron's `Tray` is write-only.** It has `setImage`, `setContextMenu` and
`setToolTip` with no getters for any of them, so what the menu bar is actually
showing cannot be read back from the object — the menu is the entire
deliverable of this phase and would only ever have been inspectable by eye.
The menu is therefore built by a pure exported `menuTemplate()` that the tray
applies and the verification asserts against, and `currentMenu()` returns it
already bound to the live deps, so clicking a row in a test runs the very
`openSession` closure `index.ts` was wired with.

**The deep link needed a handshake, not a push.** A Recent click with no window
open creates the window *and* has to land on that session — but the renderer is
not subscribed to `EVENTS.NAVIGATE` yet at the moment main fires it, so the
push lands nowhere. Main parks the target and the renderer collects it on mount
via `NAV_PENDING`, clearing it on collection so a reload does not jump back.
Both orderings are verified against the real UI.

**The tray's third state comes from the queue, not the controller.**
`RecordingController` knows nothing about transcription, so `index.ts` drives
`setTranscribing()` from `queue.on('progress')` using `queued` plus the job in
flight. Recording outranks transcribing when both are true.

### Verification

*59 checks against the tray in a real Electron main process, and 16 against the
real renderer, all passing.* The tray half stubs only `RecordingController`;
the renderer half boots the **actual `index.ts`** — real `registerIpc`, real
vault, real tray — and drives navigation by clicking rows of the real menu.

The icon assertions are quantitative rather than "an image exists": idle mean
alpha 26.2 against recording 75.2, a ratio of **0.348**, which is Apple's 35%
disabled convention. Both images are checked to still be template images after
the fade, since losing that flag would break light/dark menu bars silently.

The cold deep-link path is the one that matters and is tested as a sequence: no
window at rest → click a Recent row → a window is created → it opens **at that
session** rather than the empty state → a reload does **not** re-navigate.
Degradation is tested too: an unreadable vault drops the Recent section but
leaves start/stop working, and a first run with no sessions shows no empty
"Recent" heading.

---

## Phase 8 — Summarisation ✅

*Ends in:* a meeting's notes can be expanded into a record, locally, and undone.

Prompt and parser were already written and typechecked. This was billed as
wiring; it was not — see below.

- [x] `AI_SUMMARIZE` handler; stream `AI_TOKEN`
- [x] Route tokens through `createSectionParser()` into the five sections
- [x] Render in J: grey AI text under each black user note (UI.md §6a)
- [x] "Reset to my notes" — non-destructive, always
- [x] Write summary into `notes.md`; it is a plain file like everything else
- [x] Ollama auto-detect; **verify `num_ctx: 32768` is actually applied** — the 2048 default silently truncates from the front
- [x] Keys via `safeStorage` → Keychain; `hasApiKey` sends presence, not the key — already true from phase 0, reused unchanged
- [x] Say plainly in the UI when text leaves the machine
- [x] Cancel mid-stream

### What the build actually found

**The autosave would have eaten every summary.** The checklist asks for the
summary in `notes.md` and for a non-destructive reset, and those two are in
direct conflict as long as `notes.md` is an opaque blob: `SESSION_NOTES_GET`
returned the whole file into the textarea and `SESSION_NOTES_SET` wrote the
textarea back over the whole file. Generate a summary, type one character, and
600 ms later the autosave writes the file without it. The write succeeds, so
nothing anywhere reports a problem.

The fix is `notesDoc.ts`: `notes.md` is parsed into `{ userNotes, summary }`
and re-rendered from those two fields, so the textarea can only ever write its
own half. That also makes "Reset to my notes" non-destructive *by
construction* rather than by care — clearing one field cannot reach the other
even if the calling code is wrong. The boundary is an explicit HTML-comment
marker rather than a heuristic, because a parser that guesses wrong here
destroys the user's writing.

**`renderNotes` had never been called.** It was written in an early phase and
had zero callers, so `notes.md` had no frontmatter at all in practice. Phase 8
is where the file format actually got settled; `renderNotesDoc` replaces it.

**The concurrency guard did not guard anything.** `if (running.has(id)) throw`
followed by an awaited setup excludes nothing: `async` yields at its first
await, so two calls a millisecond apart — a double-click, or the window and the
tray both asking — both passed the check before either registered, then
streamed into the same file and raced on the write. Verified by the harness,
which caught two `summary complete` lines for one session. The slot is now
claimed synchronously, in the same turn as the test.

**Cancel discarded exactly the work the user was watching.** Aborting a `fetch`
rejects the in-flight read, so `runSummarize` *throws* rather than returning —
its return value is unreachable on the one path where a partial summary
exists. The accumulator moved into the caller, outside the `try`, so what
streamed before the cancel survives.

**Ollama is not installed on this machine**, so `num_ctx` could not be checked
against the real server. It is verified against a fake Ollama that records the
request body — which proves *we send* 32 768 rather than the 2 048 default, but
not that the server honours it. Re-check against a real Ollama when one is
available; the failure mode is a summary that silently describes only the tail
of a long meeting.

### Verification

150 checks, all passing, in three harnesses:

- **63 pure-module checks** — the `notes.md` round trip, the autosave-clobber
  scenario, reset, damaged and hand-edited files, frontmatter that must not
  accumulate across saves, and the section parser against streams chopped into
  1-, 3-, 4-, 7- and 500-character tokens (a `§§` marker splits across deltas).
- **49 checks in a real Electron main process**, driving the actual registered
  IPC handlers: streaming, persistence, the autosave interaction, reset,
  cancel-and-keep, and degradation — no provider, an unreachable Ollama, an
  untranscribed session, and the double-start above.
- **38 checks against the real renderer**, driving the real React UI: sections
  appearing *while* the stream runs rather than in one lump at the end, the
  `§§` marker never reaching the screen, "Reset to my notes" being reachable
  and leaving the notes intact both on screen and on disk, and the disabled
  states explaining themselves.

The grey-vs-black provenance diff is asserted quantitatively — AI text at
oklch lightness 0.70 against the user's 0.93 on a 0.19 ground, checked as
"closer to the background than the user's own words" so it holds in both
themes. A silently identical pair would look exactly like a working one.

One harness bug worth recording: the first version wrote its fake Ollama URL
into the *real* `settings.json`, because `app.setPath('userData', …)` had not
been called. It corrupted the user profile and poisoned the harness's own next
run. Harnesses that boot the real `index.ts` must redirect `userData` before
anything reads it.

---

## Phase 9 — Settings & first run ✅

*Ends in:* a new user gets to a first transcript without help.

- [x] Settings window: Vault / Model / Recording / AI / Permissions
- [x] **"Reveal in Finder" must actually open Finder** — the anarlog complaint
- [x] Permissions worded honestly. `systemAudio` is *inferred*, not queried — no false green tick (ARCHITECTURE §6)
- [x] First run does one thing: pick a vault → download default model with real progress → record button
- [x] Model picker shows real sizes from `models.ts`

### What the build actually found

**Three of the five items were blocked on main-process gaps, not UI.** The
checklist reads like a settings screen; most of it could not be built until
main could answer questions it previously could not.

**`systemAudio` was not inferred — it was hardcoded.** `PERMISSION_CHECK`
returned the literal string `'unknown'` unconditionally, so "word it honestly"
was not achievable by wording. The evidence existed but was thrown away:
`MacAudioCapture` fires `dead` after `LIVENESS_CHECK_MS` and
`RecordingController` tracked peaks per track, then cleared them in `#reset()`.
That evidence exists only at the instant a recording stops, and the settings
panel runs on a later launch — so it is now written to
`userData/capture-health.json` at stop and read back by the handler.

Kept out of `settings.json` on purpose. Settings are the user's choices and are
theirs to copy between machines; this is an observation about *one Mac's* TCC
state, and a stale value copied elsewhere would be worse than none. The
inference rule is that **exactly** zero means denied, not a small epsilon — a
permitted tap on a quiet machine still carries a dither floor, and treating a
tiny value as denial would send a working install to go fix its permissions. A
corrupt or truncated file degrades to `unknown`, never to a false denial.

**"Reveal in Finder" pointed at a folder that does not exist yet.** The vault
is created lazily by the first recording, so on a fresh install the path shown
in Settings is not on disk — and `showItemInFolder` on a missing path does
nothing at all, silently. That is the anarlog complaint verbatim, reproduced by
the button meant to answer it. The handler now creates the directory first and
surfaces a Finder refusal as a real error rather than a no-op.

**`launchAtLogin` was a boolean that did nothing.** It was stored and read back
faithfully and never reached `app.setLoginItemSettings`. It is now applied on
every write rather than only on change, because macOS owns the real
registration and the two can drift — a user who removes Oratio from Login Items
in System Settings leaves our JSON saying `true`, and a change-comparison would
skip the correction forever. Guarded by `app.isPackaged`: in dev this would
register the Electron binary itself as a login item.

**Nothing stopped a new user recording with no model installed.** The recording
path never checked. A first-run user could record a full meeting successfully
and be told only afterwards that nothing could transcribe it — the audio is not
lost, but the failure arrives an hour late, at the one moment it cannot be
acted on, and looks like the product is broken. This is the Granola first-run
complaint the phase is meant to answer. The check is now a precondition of
`RecordingController.start()`, before a session directory exists, so a refusal
leaves nothing behind. It lives in main rather than the renderer because the
tray can start a meeting with no window open.

**The progress label lied for the last ten percent.** `ModelManager` reserves
0.9–1.0 for checksum verification and bzip2 extraction, which report no byte
progress and take several seconds. The bar said "downloading" throughout —
describing the wrong activity at exactly the point it stops moving, which is
when a user starts wondering whether it has hung. Caught by watching a real
download rather than by reading the code.

There is deliberately **no "have we onboarded" flag**. Readiness is derived
from the filesystem on every check, because a flag lies in the cases that
matter: someone who deletes their only model has completed onboarding and still
cannot record. Deriving it means setup reappears exactly when it is needed.

### Verification

126 checks, all passing, in four harnesses:

- **20 pure-module checks** — the capture-health round trip, the inference rule
  at its boundary (exactly zero vs `1e-7`), truncated and wrong-typed JSON
  degrading to `unknown` rather than to a false denial, and a write to an
  impossible path *not throwing* — a diagnostic file must never be able to fail
  the recording that just succeeded.
- **44 checks in a real Electron main process**, driving the actual registered
  IPC handlers: the permission inference end to end across all four states,
  reveal creating a missing vault and rejecting a Finder failure, the
  `openExternal` allow-list refusing `file:`, `javascript:`, bare paths and the
  empty string, settings merge semantics, and the key path — `hasApiKey` true
  while the key itself appears in neither the response, `settings.json`, nor
  `secrets.bin` in plaintext.
- **50 checks against the real renderer**, driving the real React UI: setup
  replacing the app rather than sitting over a usable one, the record button
  refusing with a readable message and creating no session directory, toggles
  persisting through IPC to disk rather than only into React state, and the
  permissions wording asserted *negatively* — it must never render
  `System audio — allowed` in any of the three states.
- **12 checks against a real download** — the actual 251 MB moonshine tarball
  served from localhost through the real `fetch`, so extraction, the pinned
  SHA-256 and pruning all ran for real. This is what caught the progress label,
  and it proves the two halves that a stub cannot: that the bar advances, and
  that the app leaves setup by itself when the model lands.

The download harness redirects only the release-asset host, and does it in the
harness rather than in the product — `ModelManager` keeps its real URL and real
pinned digest, and only the bytes come from elsewhere. A test-only branch in
the download path would have verified something subtly different from what
ships.

Two harness bugs, both mine, both worth recording. A click at a checkbox's
coordinates does nothing when the element is scrolled out of the viewport —
`scrollIntoView` first, then assert the rect is actually on screen, or the
click silently lands on whatever is there instead. And `ORATIO_VAULT` is
applied *after* the settings merge in `loadSettings`, so a harness that patches
`vaultPath` through `SETTINGS_SET` is silently overridden and every assertion
after it describes the wrong directory.

---

## Phase 10 — Hardening ✅

- [x] **2-hour soak.** Watch `external` and `arrayBuffers` in `process.memoryUsage()`, not `heapUsed` — buffer memory is invisible to `heapUsed`, which is exactly our risk profile
- [x] Kill the app mid-recording; confirm a playable WAV and correct queue recovery
- [x] Sleep the Mac mid-recording; confirm duration is still right
- [x] Fill the disk mid-recording; confirm the failure is *reported*
- [x] Measure first window open; pre-warm **only if** above 1 s (~50 MB permanent cost)
- [x] Verify `enableExternalBuffer` and the `@rpath` finding still hold after any sherpa upgrade
- [x] LICENSE file — `package.json` and README both claim MIT and there is no LICENSE *(added in `6778be2`)*
- [x] Re-check the first-run download on a **real, slow connection** — phase 9 verified it against localhost, where the transfer finishes before the bar can show the 0–90% span that dominates a real one

### What the build actually found

This phase is written as a list of measurements, and measurements can pass. Three
did not, and each was a case where the recording survived but the app did not
tell anyone — the failure mode this product can least afford, because the user
finds out an hour later when the meeting is over.

**A full disk crashed the app.** `TrackWriter` attached a `drain` handler to its
WAV stream and no `error` handler. Node throws on an unhandled stream `'error'`,
and main had no `uncaughtException` net either — the ASR and index workers had
both had one since they were written; the one process holding a live recording
did not. So a disk filling up mid-meeting took down the app and the meeting with
it. It now records the first failure, reports it once through the capture
`error` event the controller already listens to, stops writing, and still
finalizes the session. The audio captured before the disk filled is kept, which
is the whole point: 4 minutes 15 seconds of a meeting is worth more than a
crash report.

Only the *first* error is kept and reported. A full disk produces one ENOSPC per
buffer, thirty a second, and the hundredth is no more informative than the
first — but it would bury it.

**A crash mid-recording orphaned the meeting permanently.** This is the sharp
edge of "the filesystem is the queue". A session is complete when `meta.json`
exists, which makes crash recovery free for every *transcription* failure — and
means a crash during *recording* leaves a directory that `listSessions` skips
and `resumePending` skips, because `readMeta` returns null. The WAVs sat on disk
and nothing ever looked at them again. `repairWavHeader` had been written for
exactly this and was never called from anywhere: dead code guarding the case it
was written for.

The fix is not a queue or a state file — either would break the invariant. It is
to finish the job the crashed process did not: patch the headers from the byte
counts on disk, write the `meta.json` that was never written, and let the
ordinary pending path take it from there. It runs strictly *before*
`resumePending`, so a recovered session is transcribed in the same pass as
everything else that was waiting.

What recovery cannot reconstruct is stated rather than guessed. `startOffsetMs`
is 0 for both tracks, because the real value came from comparing two
first-buffer timestamps held in memory and that measurement died with the
process — zero is what "we do not know" looks like in this schema, and it is
correct whenever both tracks started together, which is the normal case.
`startedAt` comes from the directory name, which is generated from the clock at
`start()`; mtime would be the crash time. The session is flagged `recovered`
and titled as such, because it may be missing its last seconds and the user
should know which meeting that applies to.

Recovery also refuses any directory that already has a `transcript.json`. The
queue writes `meta.json` long before a transcript exists, so that combination
cannot arise on its own — but the vault is the user's folder and they may
delete files in it, and inventing a `meta.json` there would make a finished
session look pending, hand it back to the queue, and overwrite a transcript
that might have been corrected by hand. A recovery pass that destroys the work
it exists to rescue is worse than no recovery pass, so the guard is
unconditional rather than conditional on how the state arose.

**A WAV could claim more audio than it held.** Found by the disk-full harness,
not by reading the code. `#bytes` counts what was handed to the stream, and on a
failed write that runs ahead of what reached the disk — the header claimed
8 256 000 bytes in an 8 171 520-byte file. 84 KB of samples that do not exist,
positioned exactly at the end of the recording, which is the part someone
recovering a crashed meeting most wants. `finalizeWavHeader` now clamps to the
real file size.

**The two measurements that passed, passed clearly.** First window open is
**152 ms cold** against the production bundle, so the pre-warm is not worth
~50 MB resident on a menu-bar app that may sit idle all day — the checklist's
own threshold was 1 s. And both sherpa invariants still hold on 1.13.4 under
Electron 43.2.0: it loads with no `DYLD_LIBRARY_PATH`, and
`enableExternalBuffer: true` still throws *"External buffers are not allowed"*,
so passing `false` remains load-bearing rather than merely defensive.

### Verification

The two-hour soak ran a real capture pipeline through 120 minutes of audio
(180,000 buffer pushes, 219.7 MB of WAV on disk, 124.1 min wall clock) with
**zero capture errors**. What it was actually watching is `external` and
`arrayBuffers`, not `heapUsed`: the audio never enters the JS heap, so a leak
of the thing this app moves most of would be invisible in the number people
usually quote.

| | early | late | drift |
|---|---|---|---|
| `external` | 2.5 MB | 2.5 MB | −0.9% |
| `arrayBuffers` | 0.8 MB | 0.8 MB | −2.6% |
| `heapUsed` | 5.1 MB | 5.1 MB | +1.8% |
| `rss` | 42.6 MB | 31.6 MB | −26.0% |

Peaks were 3.2 MB `external` and 1.6 MB `arrayBuffers` — bounded, not growing.
RSS *falling* over two hours is the OS reclaiming pages from an idle process,
which is the expected shape and not a measurement of ours.

Two results are worth separating from the pass counts, because they are
evidence rather than assertions.

**macOS's own decoder judged the crash recovery.** `afinfo` on an unrecovered
file returns `AudioFileOpenURL failed` — a header claiming zero length is not a
file anything will open. After recovery the same bytes read as a clean
`5.8 sec` WAVE. That is the difference between the audio being on disk and the
audio being *recoverable*, and it is not something the header arithmetic in the
harness could have established about itself.

**The real suspend corrected a wrong assumption.** `pmset sleepnow` mid-recording:
the OS delivered `suspend` and `resume` to a live recording, the discontinuity
landed at 4.9 s where the suspend hit, and the duration reported audio rather
than wall clock. But the assertion that the audio loss would roughly equal the
16-second gap **failed** — only 2.1 s was lost. `pmset -g log` explains it: the
machine entered true `Sleep` for about 4 seconds and then `DarkWake`, a
low-power state where the CPU keeps running. The event-loop freeze is a fraction
of the span between the two events. The assertion now checks what is actually
true — that time was lost, and that the loss is bounded by the gap — because the
original encoded a belief about macOS rather than a property of the recording.

Two harness bugs, both mine. Pushing PCM in a tight synchronous loop overruns
the write stream's high-water mark and trips the *backpressure* path, which
drops buffers and marks its own discontinuity — a different mechanism than the
one under test, and one that quietly moved the suspend mark from 3.0 s to 2.2 s
and shortened the file. Real-rate pacing fixed it. And destroying the last
window in a bare Electron harness quits the app before the next iteration:
`window-all-closed` defaults to exit, which the real app overrides for a better
reason — it is a menu-bar app and closing the window must not end a meeting.

---

## Phase 11 — Exclude apps from the system track

The system tap is all-or-nothing today, so a meeting recorded while music is
playing has the music in the "them" track — and therefore in the transcript,
via whatever ASR makes of song lyrics. AudioTee already solves this and we have
never used it: `--exclude-processes` and `--include-processes` are both in the
shipped 0.0.7 binary's own `--help`.

**Exclusion, not inclusion**, and the reason is the failure mode rather than
taste. A PID must be *currently producing audio* to translate to an audio object
ID, and AudioTee **exits** when translation fails — its README says so and
`Utils.swift` throws. An include-list therefore breaks in exactly the moment
that matters: you hit record in a Zoom waiting room before anyone has spoken,
translation fails, and the recording dies at the start of the meeting. With an
exclusion list, an app that is silent or absent contributes no PID to exclude,
and a meeting app nobody anticipated is still captured. Exclusion fails toward
recording too much; inclusion fails toward recording nothing.

**Corrected while building this.** The plan above assumed a bad PID in an
exclusion list is harmless. It is not: AudioTee translates every PID given to
`--exclude-processes` and **exits if any one fails**, on the exclusion path just
as on the inclusion path. Two measurements decided the implementation:

- An app is a process *tree*, and only some of it is tappable. Spotify runs 7
  processes of which **1** is a Core Audio object; Chrome runs 38 of which **3**
  are. Excluding the whole tree kills the recording; excluding only the PID you
  would name misses two thirds of Chrome's audio.
- An app that has never played a sound has **no audio object at all** (verified
  with Preview and TextEdit), so it cannot be excluded pre-emptively.

Hence a small bundled C binary, `native/audio-processes.c`, which prints the
PIDs Core Audio actually knows about; the exclusion list is the intersection of
that with the app's process tree. `lsof` was tried as a shell-only substitute
and rejected — measured against the real list it both invented PIDs and missed
two of Chrome's three.

- [x] `excludedBundleIds: string[]` in `Settings`, defaulting to Spotify and Music
- [x] Resolve bundle IDs → PIDs **at spawn time**, immediately before `MacAudioCapture.start()`
- [x] Drop any PID that does not translate; **never fail the recording over an exclusion**
- [x] Pass `--exclude-processes` only when the resolved list is non-empty — an empty flag is not the same as an absent one
- [x] Settings UI: list of apps to ignore, added from the apps currently playing audio
- [x] Keep the flag out of `AudioCapture` — it is a `MacAudioCapture` detail, and Windows WASAPI expresses this differently
- [x] Filter to PIDs Core Audio can name, via `resources/audio-processes`
- [x] Retry once without exclusions if the tap dies anyway — closes the race where a PID stops being an audio object between resolving and spawning

### Verification

- [x] Record with Spotify playing and Spotify excluded → system track contains the meeting only *(peak 0.0000 excluded vs 0.4632 control, same byte count)*
- [x] Record with Spotify excluded but **not running** → recording starts normally, no error
- [x] Record with an excluded app that is running but silent → starts normally (the translation-failure path)
- [x] Confirm the spawned argv by logging it, not by inferring it from the audio
- [x] Forced-failure cases (untranslatable tree, dead PID) recover via the retry rather than recording nothing
- [x] Probe is unpacked, executable and correct from inside a packaged `.app`

**Timing note for anyone touching the retry.** `AudioTee.start()` resolves ~2 ms
after spawn, but a translation failure only surfaces at 52–79 ms, and it arrives
as an `error` *event* — `start()` still resolves. Checking for failure
synchronously (or after a `setImmediate`) therefore always reads "fine" and the
retry never fires. It races the first audio buffer against the error instead, so
a healthy tap costs no added latency. A permanent `error` listener is attached
at construction: a failing tap emits twice, and an unhandled `error` event on an
EventEmitter takes down the main process — which it did, before that listener.

---

## Phase 12 — Notice that a meeting started

Enumerating audio processes needs **no TCC permission at all** — verified on
this machine with a Core Audio probe: 24 process objects, each with bundle ID,
PID and live `IsRunningInput`/`IsRunningOutput`, and **no prompt appeared**.
Only creating a *tap* needs the grant. `IsRunningInput` keyed by bundle ID
answers "is an app using the microphone right now", which distinguishes "Zoom is
open" from "you are in a call", and covers Meet and Slack huddles too because it
does not care what the app is.

**Suggest, never auto-start.** A local-first recorder that begins capturing on
its own is the behaviour that makes this category of app untrustworthy, and the
asymmetry is stark: a missed prompt costs one click, an unwanted auto-record
puts a private conversation on disk. No detection is reliable enough to be
trusted unsupervised — which is why the commercial tools pay the Screen
Recording tax and still get it wrong.

**Polling was the right call, for the wrong reason.** The plan cited Apple
Forums 770348 — "change listeners do not fire" — and that is not what happens on
macOS 15. Measured directly:

- A listener on `kAudioHardwarePropertyProcessObjectList` **does** fire, several
  times per audio event.
- A listener on `kAudioProcessPropertyIsRunningInput` on a specific object never
  fired at all, across a full QuickTime record/stop cycle.
- The two **combined still miss the event that matters**. Registering listeners
  over every object at startup and re-scanning on each list change caught
  CoreSpeech but missed QuickTime entirely: an app that starts using the
  microphone appears as a *new* object, so no listener was on it yet, and the
  wake that would have found it never arrived.

A 1 s poll over the same window tracked QuickTime exactly — appearing at 4 s,
clearing at 11 s, matching the recording. Polling is therefore not a fallback
here; it is the only approach measured to be correct. One scan is ~2 ms (0.2% of
a core), so the probe is one long-lived process polling internally rather than
re-spawned each second — fork+exec costs ~50 ms against the scan's 2 ms.

- [x] Poll `kAudioHardwarePropertyProcessObjectList` ~1 s — **and the stated reason was wrong**; see above for what actually fails
- [x] Read `BundleID`, `PID`, `IsRunningInput`, `IsRunningOutput` per object
- [x] Fall back to a process name when `BundleID` is empty — plain executables have none (confirmed: `afplay` reports an empty bundle ID while audible)
- [x] Match known meeting apps: Zoom, **both** Teams bundle IDs (`com.microsoft.teams` and `com.microsoft.teams2`), Slack, browsers
- [x] `CptHost` as the high-confidence Zoom in-call signal
- [x] Tray suggestion when a match starts using the mic and we are not recording; dismissible, and silent for the rest of that call once dismissed
- [x] Setting to turn the suggestion off entirely — and it stops the probe process, not just the notification
- [x] Debounce over two consecutive scans, so a momentary microphone grab is not a meeting
- [x] Key detection on the matched app prefix, not the raw bundle ID *(see below)*

**A Chrome call is three bundle IDs, not one.** Phase 11 established that Chrome
is three audio objects; what this phase added is that they carry *different*
bundle IDs — `com.google.Chrome` plus two `com.google.Chrome.helper`. Deduping
by bundle ID therefore leaves three distinct strings for one meeting, and it
fired two suggestions for a single call before this was caught. Detection keys
on the matched prefix instead, which collapses them to one.

**Do not** read window titles or request Accessibility. `kCGWindowName` has been
gated behind Screen Recording since 10.15 — not 15 — Sequoia re-prompts for that
grant periodically, and it is the reason MacWhisper's meeting detection is
absent from its App Store build. It would re-introduce precisely the permission
we avoided by choosing AudioTee over `desktopCapturer`.

### Verification

- [x] Probe reports the correct bundle ID while a call is live, and stops when it ends *(QuickTime: appears at 4 s, clears at 11 s, matching the recording exactly)*
- [x] Confirm **no permission prompt** is triggered by enumeration alone *(re-verified after adding the flags, and again in the packaged app after 20 s of polling)*
- [x] Chrome resolves sensibly despite appearing as multiple audio objects (main + helpers — observed as three) *(one suggestion, not three — this is what the prefix key fixes)*
- [x] Suggestion does not fire while Oratio is already recording *(and the suppressed call is still tracked, so no late banner when the recording stops mid-call)*
- [x] End-to-end in the running app: fires once for a sustained call, twice for two calls (proving the call-end reset), zero times for a non-meeting app holding the mic
- [x] Setting off ⇒ no probe process at all, and no detection
- [x] Probe dies with its parent — no orphan polling the microphone after quit
- [x] Packaged: universal binary, unpacked, watch mode runs from inside the `.app`, and the app resolves it out of `app.asar.unpacked`
- [x] Scan framing survives split reads, including byte-at-a-time delivery

---

## Phase 13 — Per-app picker *(only if 11 and 12 leave a gap)*

Deliberately conditional. Once music is excluded and the tray offers to record
when a call starts, a picker is a list of choices in front of a decision that
has already been made correctly. Build it only if real use shows otherwise.

If it is built, scope it honestly: macOS taps audio **processes, not windows**.
Two Chrome tabs are one audio object, and a Meet call in one of nine tabs cannot
be isolated. A "choose a window" UI would promise a granularity the API does not
have.

- [ ] Decide from real use whether this is still wanted
- [ ] If built: picker lists *processes currently producing audio*, never windows
- [ ] Inherits the include-list translation-failure risk — needs a retry loop or a fallback to exclusion

---

## Open questions that block phases

| # | Question | Blocks | Resolve by |
|---|---|---|---|
| 1 | Real inference throughput vs realtime on M-series | Whether streaming partials are viable at all | Measure in phase 2 |
| 2 | Moonshine's behaviour on silence | Hallucination filter is tuned for Whisper | Measure in phase 2 |
| 3 | Does sherpa expose `condition_on_previous_text`? | Repeat-loops in long meetings | Check in phase 2 |
| 4 | ~~Is `content-visibility` enough for a 2-hour transcript?~~ | Whether ⌘F and select-all survive | **Settled in phase 6: yes.** 1 334 turns all in the DOM, 40 scroll+layout passes in 1 ms. No JS virtualization, so ⌘F and select-all survive |
| 5 | Does AudioTee report mid-stream sample-rate changes? | Silent pitch-shifted garbage | Test in phase 3 |
| 6 | At what duration does single-pass summarisation degrade? | When chunking becomes necessary | **Still open after phase 8** — no Ollama on the dev machine, so this needs a real model and real meetings. `num_ctx: 32768` (~2 h of speech) is verified as *sent*; whether quality holds at that length is unmeasured |
| 7 | Does a real Ollama honour `num_ctx: 32768`? | Silent front-truncation of long meetings | Re-check when Ollama is installed; the fake server proves only what we send |

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
- **Per-app capture as a fix for speaker bleed** — it is not one, and the two problems look similar enough to be worth writing down. A tap runs inside the HAL, upstream of the DAC, so it has no influence on what physically reaches the microphone. Per-app capture fixes *digital* bleed (Spotify landing in the "them" track), which is a routing problem; *acoustic* bleed — their voice out of your speakers and back into your mic — is unaffected no matter how few processes are tapped. That is what `bleed.ts` is for.
- **Speaker attribution across the two tracks** — `bleed.ts` compares raw dB between a pre-mixer digital tap and an acoustic mic, so its fixed −20 dB threshold measures channel gain as much as bleed and deletes genuine near-end speech. Researched and phased in [ATTRIBUTION.md](ATTRIBUTION.md), which also corrects the claim in `bleed.ts`'s header that correlation should replace the level test — Pfau's numbers put energy normalization ahead of correlation, and the missing piece is per-channel noise-floor subtraction rather than a different feature.
- **Windows** — everything platform-specific is behind `AudioCapture`. WASAPI process loopback is *better* than macOS (single-process capture), and sherpa ships Windows binaries. Remember the AVX2 pre-flight check (ARCHITECTURE §4.6). Researched and phased in [WINDOWS.md](WINDOWS.md) — note that process loopback needs build 20348 (not the widely-cited 2004), and that Chromium's default AEC will silently wreck the two-track split unless disabled explicitly.

---

## The order, in one line

**Model → ASR → mic → recording → index → UI(J) → tray → AI → settings → hardening.**

Phases 1–4 are the critical path and strictly sequential; each is unusable
without its predecessor. **Phases 1–10 are done** — that is the whole of the
original build order, and what remains before a release is packaging and
signing, plus the two open questions below that need a real Ollama and real
long meetings to settle.

Phases 11–13 came out of using the thing. They are **not** on the release path:
11 and 12 are independent of each other and of everything above, and 13 exists
mainly to be cancelled once 11 and 12 have shipped. Both rest on capability that
is already in the tree — AudioTee 0.0.7 ships the process-filter flags, and
audio-process enumeration needs no permission — so neither adds a dependency or
a prompt.
