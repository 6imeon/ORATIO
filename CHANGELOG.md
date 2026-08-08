# Changelog

All notable changes to Oratio are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been released yet. Everything below is under `Unreleased` until
the first build ships — see [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)
for what has to land first.

## [Unreleased]

### Added

- **Recording controller** (`src/main/recording/RecordingController.ts`) — the
  piece that makes the app an app. Capture, storage and transcription all
  existed; nothing joined them. Press record, speak, stop, and a transcript
  appears.
  - **Main owns recording and drives the renderer**, not the reverse.
    `getUserMedia` lives only in the renderer, so the obvious design gives it
    the recording — but the window is optional here. The tray has to be able
    to start a meeting with nothing open, and closing the window mid-meeting
    must not end it. Main sends `MIC_START`/`MIC_STOP`; the renderer is a
    driver for the one API main cannot reach.
  - **Exactly one window may hold the microphone.** A window opened
    mid-meeting asks main whether it may take it rather than deciding for
    itself — two windows both calling `getUserMedia` would interleave two
    streams into one WAV, which is silently wrong rather than loudly broken.
  - **`meta.json` is written last, and only on a clean stop.** Its presence is
    what marks a session complete and enqueues it, so a crash before that
    point leaves a directory the next launch simply ignores. There is no
    half-enqueued state to repair, because the filesystem is the queue.
  - **Duration comes from the sample count**, never the wall clock. A meeting
    that lost ninety seconds to sleep is ninety seconds shorter than the clock
    says, and every transcript timestamp is derived from sample positions.
  - **`startOffsetMs` is measured, not assumed.** The mic and the system tap
    start 85 ms apart in practice — two subsystems with different startup
    costs — and treating that as zero puts every "me" line out against every
    "them" line.
  - `powerSaveBlocker('prevent-app-suspension')` while recording, explicitly
    not `prevent-display-sleep`: there is no reason to keep someone's screen
    awake through a meeting. Suspends are marked as discontinuities at the
    instant they happen, because the event loop is about to freeze and no
    later sample count can reveal where the hole was.
  - Quitting mid-meeting finalizes the recording instead of orphaning it.
  - The tray toggle is wired to the controller and reflects state rather than
    owning it, so the menu reads the same whether recording was started from
    the tray, the window, or the shortcut.
- **Two live level meters, one per track** — never a combined one, which would
  hide exactly the failure they exist to catch: one source dead while the
  other is fine. Pushed as two floats at ~30 Hz; audio never crosses that
  channel.
- **The pre-record "delete audio after transcribing" toggle**, completing the
  per-session discard feature below. Offered only before recording starts,
  because that is the only point at which it can be honoured — the choice is
  written into `meta.json` and read when the transcript lands, possibly on a
  later launch.
- **Per-session audio discard.** Recordings keep their audio by default —
  that is what makes click-a-line-to-hear-it possible, and what lets a name
  the transcript garbled be recovered from the source. But a meeting can now
  be recorded with `discardAudio`, and both WAVs are deleted the moment the
  transcript exists.
  - **The choice lives in `meta.json`, not in Settings**, so it travels with
    the session. The filesystem is the queue: a recording transcribed only
    after a crash and relaunch has to carry its own instruction, because that
    is the only thing the queue reads.
  - **Deletion is ordered strictly after the transcript is on disk.** Until
    then the audio is the only copy of the meeting, so a failed transcription
    keeps it rather than destroying both.
  - **An interrupted deletion is finished on the next launch.** A crash
    between writing `transcript.json` and unlinking the WAVs would otherwise
    leave the audio forever — the session has a transcript, so nothing would
    ever look at it again.
  - Honest about what it is not: the audio is written to disk and then
    removed, so there is a window where it exists, and an ordinary unlink
    cannot promise the bytes are unrecoverable on an SSD. Both are stated
    where the feature is described rather than glossed.
  - Sessions whose audio is gone say so, and their transcript lines stop
    pretending to be playable.
- **Microphone capture** (`src/renderer/src/audio/`, `src/main/audio/micPort.ts`)
  — the second half of the two-track invariant. The mic is captured in the
  renderer, the system tap in main, and the two are written to separate files
  that are never mixed.
  - An **AudioWorklet**, not a `ScriptProcessorNode`, so capture runs on the
    audio thread rather than competing with React renders and garbage
    collection. Dropped input frames cannot be retried — there is no rewind on
    a microphone.
  - **Resampling is a windowed-sinc pass with the anti-alias filter built in**,
    at whatever rate the device runs. It has to be arbitrary-ratio: 44.1 kHz
    devices exist and 44100/16000 is not an integer, so "take every Nth sample"
    cannot be made to work even in principle. Measured: a 13 kHz tone rejected
    at −95 dB, where naive decimation folds it into the speech band at 3 kHz at
    full amplitude.
  - Audio is **batched to 40 ms before crossing IPC** — 25 messages/s instead
    of the ~375/s that posting every 128-frame quantum would cost. Bandwidth
    was never the constraint; per-message overhead is.
  - **Duration comes from the sample count**, and suspends and device rate
    changes are recorded as discontinuities at the millisecond they occur. An
    OS suspend freezes the event loop, so a wall clock silently overstates a
    track that lost ninety seconds to sleep.
  - The **WAV header is patched every 30 seconds** rather than only at stop, so
    a crash leaves a playable truncated file instead of one every tool reports
    as empty. Backpressure is respected rather than buffered past.
  - A **liveness check** reports a track that is digitally silent after three
    seconds. Every macOS audio failure mode — a missing entitlement on a helper
    binary, a tap-only aggregate device, an unsupported voice-processing route
    — returns success and then delivers zeroes, and a real microphone always
    has a noise floor.
- **ASR worker** (`src/main/transcription/worker/`, `WorkerEngine.ts`) — audio
  becomes text, entirely on the machine. A WAV plus `meta.json` now produces a
  real `transcript.json`.
  - Inference runs in a **`utilityProcess`, one per job, killed on
    completion**. Electron warns that native modules in worker threads cause
    crashes and memory corruption, and process exit is the only reliable
    deallocator for this stack — so a model that fails to load takes down
    nothing else, and no leak can accumulate across meetings.
  - **A single module may require sherpa-onnx**, which is what makes
    `enableExternalBuffer: false` structural rather than a rule to remember at
    every call site. sherpa defaults it to `true`, and Electron's V8 memory
    cage rejects external buffers outright.
  - **VAD runs before ASR**, always. Verified on real audio: 8 seconds of
    digital silence produce zero segments, and a 37-second file with two
    utterances is split into exactly those two, with the silence discarded
    rather than transcribed.
  - All four models work through **one code path**, covering three different
    config layouts — Whisper's encoder/decoder, Moonshine's four stages, and
    Parakeet's transducer with a joiner.
  - Both tracks are merged onto a shared clock via `TrackMeta.startOffsetMs`,
    so speaker attribution comes from which file the audio was in rather than
    from guessing.
- **`ModelManager.ensureVad()`** — fetches and verifies the Silero VAD weights,
  which the pipeline required but nothing had ever downloaded.
- **Model download manager** (`src/main/models/ModelManager.ts`) — the first
  phase of the build, and the first thing a new user touches. Downloads are
  resumable via HTTP `Range`, verified against a pinned SHA-256 before
  extraction, and installed by atomic rename, so an interrupted install is
  indistinguishable from one that never started.
  - **A model counts as present only when every file it needs is present and
    non-empty**, never when its directory exists. A half-extracted directory
    exists too, and treating that as ready is how "failed to load model"
    became the top defect class in this category.
  - Free disk space is checked against the **peak install size** — tarball
    plus everything it unpacks to — rather than the download size.
  - Redundant weights are pruned after extraction (see below).
  - Progress events are throttled to ~10/s; cancelling settles in ~10 ms and
    leaves nothing behind.
- **`LICENSE`** — MIT, which `package.json` and the README already claimed.
- **Verified model metadata** in `src/shared/models.ts`: pinned SHA-256
  digests, a per-family file manifest, and real install sizes. Every field was
  measured by downloading all four models on 8 August 2026, not estimated.
- **`MODEL_STATES`** IPC channel, separating what is on disk from the static
  catalogue — `MODEL_LIST` describes the four models, `MODEL_STATES` says
  which are actually installed.

- **Design docs**, now under [docs/](docs/):
  - `ARCHITECTURE.md` — process topology, audio pipeline, ASR, storage, and
    the threat model for the local-only guarantee.
  - `UI.md` — the interface design, its performance budget, and the
    summarisation contract.
  - `IMPLEMENTATION.md` — the phased build order, with the real state of the
    codebase rather than the aspirational one.
- **Layout J ("the drawer") chosen** for v1 after exploring eight directions:
  notes take the full window width, and the transcript lives in a drawer that
  pulls up from the bottom. Picked because it is a superset of a plain
  notebook and depends on no unproven model behaviour.
- **A structured summarisation prompt** producing five sections — Summary,
  Decisions, Action items, Discussion, Open questions — matching what Google
  Meet, Grain, and Granola converged on. Written against the measured error
  distribution for meeting summaries, where missing information (97%) is far
  more common than hallucination (14%).
- **`createSectionParser()`** — demultiplexes a single token stream into
  sections as it arrives, so one model call can feed a sectioned UI. Line
  buffered, because a section marker can be split across tokens; verified
  against a stream chopped into 4-character chunks.
- **`SHERPA_EXTERNAL_BUFFER`** in `TranscriptionEngine.ts`, so the
  memory-cage rule is enforced in one place rather than at every call site.

### Fixed

- **The ASR worker path was still wrong outside `pnpm dev`.** Phase 2 replaced
  `__dirname` with `app.getAppPath()`, which fixed the rollup-chunking trap —
  but `getAppPath()` is the project root under `electron-vite dev` and
  `out/main` when the built output is launched directly, so the join produced
  `out/main/out/main/asr.cjs` and transcription failed with a missing binary.
  It worked in the dev server and nowhere else. Both layouts are now tried,
  and the error names every path it looked in.
- **The recording timer drifted.** `RecordButton` accumulated
  `setElapsed(e => e + 1)` on an interval, and a backgrounded renderer is
  throttled to roughly one tick a minute — which, for a menu-bar app during a
  meeting, is most of the time. Elapsed time is now read from the pushed
  `RecordingState`. It remains wall-clock on purpose, unlike the duration in
  `meta.json`: someone watching a timer expects to see the time that passed,
  including a suspend, while the file has to match the audio.
- **The tray counter froze after sleep** and stayed frozen until the next
  tick, because the interval driving it does not run while the machine is
  asleep. It now redraws on `powerMonitor` resume.
- **A double-click on the tray item toggled recording twice** — the second
  fire stopping the recording the first had just started.
  `setIgnoreDoubleClickEvents(true)`.
- **`TranscriptionQueue` acted on a stale `meta.json` when discarding audio.**
  The comment claimed the file was re-read after transcription and it was not,
  so a job that took minutes decided using a copy read before it started —
  and `discardSessionAudio` writes to that same file.
- **The system-audio track was never valid audio.** AudioTee switches its
  encoding to 16-bit signed integers whenever a sample rate is requested — and
  we always request 16 kHz — but the decoder read the bytes as 32-bit floats.
  Sample values came back around `1e38` and the entire track was noise, while
  still producing a WAV of exactly the right length, which is how it survived
  unnoticed. The first buffer of every recording is now range-checked, so a
  format mismatch raises an error instead of silently ruining a meeting.
- **PCM sent through the context bridge arrived empty.** An `ArrayBuffer`
  passed into a `contextBridge`-exposed function never reaches the main
  process, and `postMessage` accepts the detached result without raising —
  producing a full-length recording of pure silence with a completely clean
  log in all three processes. The renderer now passes a `Float32Array` and the
  transfer happens preload-side, past the bridge, where it is meaningful.
- **A failed model load poisoned the entire queue.** `TranscriptionQueue`
  cached the engine before `prepare()` had resolved, so one failed load left a
  dead engine in the field and every subsequent session failed against a
  worker that had never started — recoverable only by restarting the app. The
  engine is now assigned only once loading succeeds.
- **Silero VAD had no way onto disk.** It was declared in `models.ts` and
  mandatory in the pipeline, but nothing ever downloaded it, so ASR would have
  failed on first run for every model. Now fetched and checksum-verified as a
  prerequisite of every job.
- **The ASR worker could not be located by `__dirname`.** Rollup hoists code
  shared between entry points into `out/main/chunks/`, so as soon as a second
  entry imported `WorkerEngine`, `__dirname` silently became `.../chunks` and
  the fork failed with `ERR_MODULE_NOT_FOUND` — a path that breaks on a build
  change rather than a code change. Resolved from `app.getAppPath()` instead.
- **`"type": "module"` broke `utilityProcess.fork`.** Electron loads the main
  entry through CommonJS, so `index.cjs` was unaffected, but `fork()` uses
  Node's ESM-aware resolver and rejected the worker outright. The build now
  emits `out/main/package.json` with `{"type":"commonjs"}` to scope the output
  directory back to CJS.
- **Whisper models cost far more disk than the picker implied.** The tarballs
  ship full-precision weights alongside the int8 ones we actually load, so
  whisper-small.en advertised 636 MB and consumed **1.3 GB** — 924 MB of it
  never read. The fp32 copies are now pruned after extraction, taking
  whisper-base.en from 447 MB to 161 MB and whisper-small.en to 358 MB.
- **The disk-space check silently passed on first run.** `statfs` throws
  `ENOENT` for a directory that does not exist yet, which is exactly the state
  of the models directory before the first download — so the check failed,
  was swallowed as "could not determine free space", and the download started
  regardless. It now measures the nearest existing ancestor, since free space
  is a property of the filesystem rather than of one directory. Caught by
  testing the guard rather than trusting it.

- **Ollama silently truncated long transcripts.** Ollama defaults `num_ctx`
  to 2048 tokens and discards anything longer *from the front*, with no error
  raised anywhere in the stack. A 25-minute meeting already exceeds that, so
  summaries described only the tail of a conversation while reporting
  success. Now set to 32 768 — roughly two hours of speech.

### Changed

- **Summarisation now optimises for completeness.** The previous prompt asked
  for short sections and bullets, which pushed toward the single most common
  defect in machine-written meeting notes. Speaker labels are now declared
  authoritative — our two audio tracks make attribution ground truth, which
  structurally removes the misattribution class that mixed-audio tools suffer
  — and an unowned commitment stays `Unassigned` rather than being given a
  guessed owner.
- **Inference parameters set explicitly** across all three providers:
  `temperature: 0.2` (summarisation is extraction, not composition) and an
  8192-token output ceiling so a thorough Discussion section is not truncated.
  OpenAI previously had no output limit at all.
- The transcript is now placed **last** in the prompt, after the
  instructions and the user's notes, so nothing load-bearing sits in the
  middle of a long input where model attention measurably degrades.

### Known gaps

Not defects so much as work not yet done — the honest state of the build:

- `AI_SUMMARIZE` is declared but unhandled — summarisation is written and
  typechecked but not yet wired to anything.
- Recording is verified against short sessions. **Multi-hour meetings are
  untested**, as is the memory behaviour across a long queue. The
  device-rate-change rebuild path has been exercised only through its watcher,
  never by physically switching audio devices mid-recording.
- Starting a recording with no window open records **system audio only**. That
  is deliberate — opening a window unbidden to capture a microphone is exactly
  what a meeting recorder should not do — but it means a tray-started meeting
  captures one side until the window is opened.
- The mic path is proven with Chromium's fake device rather than a physical
  microphone, so real-device permission behaviour is inferred from the
  liveness check rather than observed.
- The ASR worker is verified against three model families but only ever on
  short clips. Multi-hour audio, and the memory behaviour across a long
  queue, are untested.
- No UI for the model picker — downloading currently works only through IPC.
- The summarisation path is written and typechecked but has never been run
  against a real transcript.

[Unreleased]: https://github.com/6imeon/ORATIO/commits/main
