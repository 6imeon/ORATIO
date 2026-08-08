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

2,654 lines. More is scaffolded than built, and the gaps are not where the
`TODO` comments are.

| Area | State |
|---|---|
| Build config, `utilityProcess`, sherpa load path | **Verified working** (ARCHITECTURE §1) |
| Vault, `meta.json`/`transcript.json`, atomic writes | Built |
| `TranscriptionQueue`, filesystem-as-queue, `resumePending()` | Built, never exercised |
| VAD wrapper + hallucination filter | Built, never run |
| System audio (AudioTee) | Built |
| SQLite FTS5 index | Built, runs in main (wrong process) |
| AI providers + prompt + section parser | Built and typechecked; never called |
| Tray | Renders; `toggle()` is a stub, no Settings item |
| Renderer (5 components) | Renders; wrong layout, drifting timer |
| **Mic capture** | **Does not exist** — only comments referring to it |
| **Model download manager** | **Does not exist** — `src/main/models/` is empty |
| **ASR engine** | **Does not exist** — `index.ts:83` throws |
| **Recording controller** | **Does not exist** — 3 IPC channels declared, unhandled |

**14 of 29 declared IPC channels have no handler**, including
`RECORDING_START`, `RECORDING_STOP`, `MODEL_DOWNLOAD`, and `AI_SUMMARIZE`. The
preload exposes `recording.start()`; calling it resolves to nothing.

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

## Phase 1 — Model download manager

**Nothing works until a model is on disk.** Empty directory today.

*Ends in:* pick a model in a dev harness, watch it download, verify it.

- [ ] `src/main/models/ModelManager.ts` — resolve dir, check presence, report state
- [ ] Download with progress → `MODEL_PROGRESS` events (throttle to ~10/s; see UI.md §0 on message rate)
- [ ] **Resumable** via HTTP `Range`; a 635 MB download WILL be interrupted
- [ ] **Verify checksum before extract.** Corrupt weights fail deep inside sherpa with an unreadable error
- [ ] **Check free disk space before starting.** Ollama-style silent failure is the pattern to avoid; this is also the exact bug the summary prompt's own test data describes
- [ ] Extract `.tar.bz2` → `userData/models/<id>/`, atomically (temp dir + rename)
- [ ] Handlers: `MODEL_DOWNLOAD`, `MODEL_CANCEL`, `MODEL_DELETE`
- [ ] Delete partial files on cancel or failure — never leave a half-model that reads as present
- [ ] Real error states surfaced, never a hang

> **Why first:** ARCHITECTURE §4.4 — across Vibe and Meetily, "failed to load
> model" outnumbers accuracy complaints. It is the top user-visible defect
> class in this category, and it is the first thing a new user touches.

---

## Phase 2 — ASR worker

*Ends in:* a WAV on disk becomes `transcript.json`. First real transcript.

- [ ] `src/main/transcription/worker/` — `utilityProcess` entry point
- [ ] **One sherpa wrapper module.** Nothing else may `require('sherpa-onnx-node')` (ARCHITECTURE §4.2)
- [ ] **`SHERPA_EXTERNAL_BUFFER` at every call site.** Already exported; the default `true` throws under the V8 cage on *every* recording (ARCHITECTURE §1.1)
- [ ] Request/response protocol: `load` / `transcribe` / `release`
- [ ] **Attach `message` handler before the child can exit**; drive the first send from `spawn` — otherwise `exit` beats `message` and the reply is lost
- [ ] **`env` must be `string → string`** — `delete` the key, never assign `undefined`
- [ ] `serviceName: 'oratio-asr'`, `stdio: 'pipe'`
- [ ] VAD before ASR, always (existing `vad.ts`)
- [ ] Run `isLikelyHallucination()` on output
- [ ] One worker per job, `kill()` on completion (ARCHITECTURE §1.3 — process exit is the only reliable deallocator)
- [ ] Replace the `throw` at `src/main/index.ts:83`
- [ ] Both tracks transcribed, merged on the shared clock using `TrackMeta.startOffsetMs`

**Test with a fixed WAV before any recording exists.** Decouples ASR bugs from
capture bugs.

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
