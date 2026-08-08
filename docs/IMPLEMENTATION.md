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
| AI providers + prompt + section parser | Built and typechecked; never called |
| Tray | Wired to the controller; no Settings item yet |
| Renderer (5 components) | Renders; wrong layout (timer drift fixed in phase 4) |
| Mic capture | **Built and verified** — worklet → port → WAV, lossless (phase 3) |
| Model download manager | **Built and verified against the network** (phase 1) |
| ASR engine | **Built and verified** — 3 config families (phase 2) |
| **Recording controller** | **Built and verified end to end** (phase 4) |
| **Index worker** | **Built and verified** — tray-freeze measured, DB deleted and recovered (phase 5) |

**1 of the request/response IPC channels has no handler** — `AI_SUMMARIZE`,
which phase 8 wires. `RECORDING_START`, `RECORDING_STOP`, `RECORDING_STATE`
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

## Phase 6 — The UI: layout J

*Ends in:* the app looks like the decision in UI.md §3a.

**Fix first (both were live bugs — done in phase 4, since both were one-line
consequences of wiring the controller):**
- [x] `RecordButton.tsx:12-16` accumulates `setElapsed(e => e + 1)` — a tick counter in a **background-throttled** renderer. It will drift. Read elapsed from `RecordingState` instead
- [x] `tray.ts:73` — re-render on `powerMonitor` resume so the counter doesn't freeze on screen after sleep

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
- [x] `setIgnoreDoubleClickEvents(true)` — done in phase 4: without it a double-click fires the menu item twice, and the second fire *stops* the recording the first just started
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
without its predecessor. Phase 5 is done. Phases 6–9 are parallelisable now
that 4 has landed. Phase 10 gates any release.
