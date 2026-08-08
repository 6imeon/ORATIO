# Changelog

All notable changes to Oratio are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been released yet. Everything below is under `Unreleased` until
the first build ships — see [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)
for what has to land first.

## [Unreleased]

### Added

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

- Microphone capture does not exist, so the two-track split is half-built.
- Nothing consumes a downloaded model yet: the ASR worker is unbuilt and
  `src/main/index.ts` still throws where the engine should be constructed.
- No recording controller: `RECORDING_START` and `AI_SUMMARIZE` are declared
  but unhandled, along with 10 other channels.
- No UI for the model picker — downloading currently works only through IPC.
- The summarisation path is written and typechecked but has never been run
  against a real transcript.

[Unreleased]: https://github.com/6imeon/ORATIO/commits/main
