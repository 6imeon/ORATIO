# Oratio — Architecture

**Status:** design of record, v1
**Date:** 8 August 2026
**Scope:** macOS 14.2+, English-only, Electron 43 + TypeScript

Companion to [RESEARCH.md](RESEARCH.md), which covers *why Electron* and the
competitive landscape. This document covers *how the thing is built*.

Everything marked **[verified]** was tested on this machine against the
installed dependency versions. Everything marked **[reported]** comes from
other projects' issue trackers and is credible but untested here. The
distinction matters: three of the decisions below reverse what the public
advice recommends, on the strength of local measurement.

---

## 0. Language: TypeScript. The question is closed.

There is no Rust in this project. Reopening it would mean rewriting the 2,400
lines that already exist and losing both native dependencies.

- `audiotee` and `sherpa-onnx-node` are npm packages with working Node
  bindings. In Rust they become hand-written FFI or `cidre`/`cpal` glue.
- Every heavy computation already happens in native code. ONNX inference,
  Core Audio capture, and SQLite are C++/Swift/C. TypeScript orchestrates;
  it never touches a sample in a hot loop. **The language of the orchestration
  layer is not the performance variable** — process topology is, and that is
  what the rest of this document is about.
- One developer, one platform, no second implementation to maintain.

Rust would win on binary size and on memory safety in the audio path. Neither
outweighs having working bindings today. Revisit only if a profiler shows JS
in a hot path, which the design below is specifically shaped to prevent.

---

## 1. The three findings that shaped this design

These were unknown at the start of the day and each one invalidates an
obvious approach.

### 1.1 The V8 memory cage breaks sherpa's default API **[verified]**

Electron 21+ enables V8's memory cage: an `ArrayBuffer` may not point at
externally-allocated memory. sherpa-onnx exposes an `enableExternalBuffer`
flag across its API **that defaults to `true`**.

Measured on Electron 43.2.0 / sherpa-onnx-node 1.13.4:

```js
sherpa.readWave(path, true)   // ✗ Error: External buffers are not allowed
sherpa.readWave(path, false)  // ✓ 32000 samples
```

This is not a corner case. `vad.js` defaults it to `true` in **both**
`get()` and `front()` — and VAD is mandatory in our pipeline, so the naive
implementation crashes on **every single recording**.

> **Rule: pass `enableExternalBuffer: false` at every sherpa call site.**
> No exceptions. This is enforced by routing all sherpa access through one
> wrapper module (§4.2) rather than trusting call-site discipline.

The cost is one buffer copy per call. At 16 kHz mono that is a rounding error
against inference time.

### 1.2 The documented macOS dylib problem does not apply to us **[verified]**

sherpa-onnx issues [#2622](https://github.com/k2-fsa/sherpa-onnx/issues/2622)
and [#1945](https://github.com/k2-fsa/sherpa-onnx/issues/1945) report the
addon failing to load in Electron on macOS, and sherpa's own README tells you
to `export DYLD_LIBRARY_PATH=...` — which cannot work in a signed .app,
because macOS SIP strips `DYLD_*` from protected processes. The standard
advice is to relink the dylibs with `install_name_tool`.

**We do not need any of that.** Inspecting the shipped binary:

```
$ otool -L sherpa-onnx.node
    @rpath/libsherpa-onnx-c-api.dylib
    @rpath/libonnxruntime.1.27.0.dylib
$ otool -l sherpa-onnx.node | grep -A2 LC_RPATH
    path @loader_path
```

`@rpath` + `LC_RPATH @loader_path` means the dylibs already resolve relative
to the `.node` file. As of 1.13.4 this is fixed upstream. Confirmed by
loading it successfully in both the main process and a `utilityProcess` with
no environment variables set at all.

> Still required: `asarUnpack` for `sherpa-onnx*` (a `.node` cannot be loaded
> from inside an asar), and `disable-library-validation` in the entitlements.
> Both are already in `electron-builder.yml`.
>
> **Re-verify after every sherpa upgrade** — this is an upstream property we
> depend on, not a guarantee we control.

### 1.3 Everyone converges on out-of-process inference — for memory, not speed **[reported]**

The reason is not UI responsiveness, which is the usual justification. It is
that **process exit is the only reliable deallocator**:

- whisper.cpp [#1202](https://github.com/ggml-org/whisper.cpp/issues/1202):
  CoreML leaks ~5.88 MB per `whisper_full` call. Open, unfixed.
- whisper.cpp [#2310](https://github.com/ggml-org/whisper.cpp/issues/2310):
  a 10-hour file exhausts 16 GB even on the *tiny* model.
- Vibe's maintainers proposed splitting inference into a runner process
  "similar to what Ollama did" ([#469](https://github.com/thewh1teagle/vibe/issues/469)).
- Buzz uses `multiprocessing`; Hyprnote uses supervised actors and sidecars.

A leak you cannot find is fixed by `kill()`. That is the whole argument.

---

## 2. Process topology

Four processes. The split is driven by §1.3 (memory reclamation) and by the
fact that a blocked main process means a **dead menu-bar icon** — for an app
whose entire UI is that icon, this is a correctness requirement, not an
optimisation.

```
┌────────────────────────────────────────────────────────────────────┐
│ MAIN — orchestration only, must never block                        │
│                                                                     │
│  tray · lifecycle · powerSaveBlocker · IPC router                  │
│  AudioTee child spawn · WAV write streams (async I/O)              │
│                                                                     │
│   ├─ child_process ─────► audiotee (Swift)  system audio, pre-mixer│
│   │                                                                 │
│   ├─ utilityProcess ────► ASR WORKER    sherpa-onnx: VAD + ASR     │
│   │                       spawned per job, killed on completion     │
│   │                                                                 │
│   ├─ utilityProcess ────► INDEX WORKER  better-sqlite3 (sync API)  │
│   │                       long-lived; index is derived, so a crash  │
│   │                       costs nothing but a rescan                │
│   │                                                                 │
│   └─ ipc ───────────────► RENDERER      React. View only.          │
│                           Hidden ~always → background-throttled.    │
│                           Never trust it for timing or state.       │
└────────────────────────────────────────────────────────────────────┘
```

### Why `utilityProcess` and not `worker_threads` **[verified + reported]**

Electron's own docs: *"An Electron app can always prefer the UtilityProcess
API over Node.js `child_process.fork`."* More pointedly, on native modules in
threads: *"Most existing native modules have been written assuming
single-threaded environment, using them in Web Workers will lead to crashes
and memory corruptions"*, and *"`process.dlopen` is not thread safe."*

Corroborating: onnxruntime
[#20084](https://github.com/microsoft/onnxruntime/issues/20084) — crashes in
Electron with worker_threads, *"the more Workers created, the more frequently
the crash occurs"*; and electron
[#43513](https://github.com/electron/electron/issues/43513) — better-sqlite3
in a worker thread fails **in production but not dev**.

`utilityProcess` sidesteps all of it: a real OS process, one Node instance,
separate crash domain, and `kill()` reclaims everything.

**Verified working locally**, which matters because I could find no public
report of anyone running sherpa-onnx-node in a `utilityProcess`:

```json
{ "result": "message-received",
  "child": { "loaded": true, "exports": 23,
             "externalBufferAllowed": false,
             "copiedBufferWorks": true, "samples": 32000 } }
```

Two gotchas found while proving it, both of which cost real time:

- **`env` must be `string → string`.** Setting a key to `undefined` throws
  `TypeError: Invalid value for env`. To strip `ELECTRON_RUN_AS_NODE` you
  must `delete` the key from a copied object, not assign `undefined`.
- **Attach `message` handlers before the child can exit**, and drive the
  first send from the `spawn` event. A child that posts and exits
  immediately will fire `exit` before `message` and the reply is lost.

Fork options we use: `serviceName: 'oratio-asr'` (so `app.getAppMetrics()`
and Activity Monitor attribute memory to a named process — this makes "Oratio
is using 3 GB" reports diagnosable), and `stdio: 'pipe'` (sherpa's native
layer is chatty; piping keeps it out of the app log).

---

## 3. Audio pipeline

```
 mic ─── getUserMedia (renderer) ──┐
                                   ├─► main ─► resample 16k ─► WAV stream ─► mic.wav
 system ─ AudioTee (Swift child) ──┘                                       system.wav
```

Two tracks, written separately, **never mixed**. This is the product
invariant — it is what makes speaker attribution free and error-free.
Meetily mixes at 600 ms windows with the system track pre-scaled to 70%, and
in doing so destroys attribution before ASR ever runs. Hyprnote keeps
`RealtimeMic` and `RealtimeSpeaker` separate, same as us.

### Sample rate is not a constant **[reported]**

Hyprnote re-probes the Core Audio tap's `ASBD` every 128 empty polls because
**the tap's rate can change mid-stream**. A device switch or route change
mid-meeting silently changes the resample ratio and every sample after it is
pitch-shifted garbage — with no error anywhere.

AudioTee accepts `sampleRate: 16000` and resamples internally, which covers
the common case. But `AudioCapture` must treat an incoming rate change as a
real event, not an impossibility. When we downsample ourselves,
**anti-alias**: naive decimation folds HF noise into the speech band and
measurably degrades both VAD and ASR.

### Never hold a meeting in memory **[reported]**

The Electron-specific trap (whisper.cpp
[#1311](https://github.com/ggml-org/whisper.cpp/issues/1311)):
`MediaRecorder` accumulates the whole recording in RAM, and Node `fs` then
chokes writing one giant buffer. A 2-hour meeting dies before ASR is even
reached.

We stream to disk continuously and respect backpressure. Node's docs are
explicit that `highWaterMark` is a threshold, not a limit, and that ignoring
it causes *"high RSS (which is not typically released back to the system,
even after the memory is no longer required)"*.

**WAV header handling.** RIFF sizes live at the front of the file and are
unknown until stop. We write a placeholder header, stream PCM, then patch the
two size fields on finalize. Patch the header **periodically** (~every 30 s),
not only at the end: a crashed recording then leaves a *playable* truncated
file instead of a corrupt one. This dovetails with filesystem-as-queue —
crash recovery costs nothing.

Store 16-bit PCM, not Float32. Half the bytes, no meaningful loss at 16 kHz,
and it is what every downstream tool expects.

### IPC bandwidth is a non-issue; message *rate* is

16 kHz mono Float32 = 64 KB/s per track. Trivial. The cost is per-message
overhead, not throughput. At `chunkDurationMs: 20` that is 50 msg/s/track —
fine. The failure mode is posting every AudioWorklet quantum (128 frames =
8 ms, ~375 msg/s) through `ipcRenderer.invoke`. Batch to 20–100 ms, and use
`postMessage` with a transferable `ArrayBuffer` rather than `send`/`invoke`,
which cannot transfer.

### Power and clock

- `powerSaveBlocker.start('prevent-app-suspension')` while recording — keeps
  the system awake but **lets the screen sleep**. `'prevent-display-sleep'`
  would pin the display on for a 2-hour meeting; user-hostile, wrong type.
- **Never derive duration from timer ticks.** On OS suspend the event loop
  freezes and `setInterval` does not retroactively fire missed ticks. Derive
  elapsed time from **bytes written / sample count**, which is ground truth.
  Listen to `powerMonitor` `suspend`/`resume` to mark discontinuities.

---

## 4. Transcription

### 4.1 The queue is the filesystem

Unchanged and load-bearing: `meta.json` present + `transcript.json` absent =
pending. No queue database, nothing to corrupt, crash recovery for free.
`TranscriptionQueue.resumePending()` rescans on launch.

### 4.2 One wrapper around sherpa

All sherpa access goes through a single module inside the ASR worker. Nothing
else in the codebase may `require('sherpa-onnx-node')`. That module:

1. Passes `enableExternalBuffer: false` everywhere (§1.1). This is the
   enforcement mechanism — a rule that must be remembered at 20 call sites is
   a rule that will be broken at one of them.
2. Owns model load/release.
3. Translates sherpa's shapes into `RawSegment[]`.

`TranscriptionEngine` (the existing interface) stays exactly as it is; the
worker implements it. The queue never learns that sherpa exists.

### 4.3 Job lifecycle

```
enqueue ─► spawn ASR worker ─► load model ─► VAD ─► ASR per region
                                                  │
                            transcript.json ◄─────┤ (atomic: tmp + rename)
                                                  │
                                    kill worker ◄─┘   all memory reclaimed
```

One worker per job, killed on completion. This is the §1.3 conclusion applied:
resident within a job (model loads once, amortised across both tracks),
fully reclaimed at exit (no leak can accumulate across meetings).

If job latency from repeated model loads becomes a problem, keep the worker
alive with an **idle timeout** — but start with kill-per-job, because it is
the configuration that cannot leak.

### 4.4 Model loading is the most likely thing to fail **[reported]**

Across Vibe and Meetily, `failed to allocate memory for the model` /
`failed to load model` / crash-at-"Loading transcription engine" **outnumber
accuracy complaints**. It is the top user-visible defect class in this
ecosystem. So:

- Verify checksum and free RAM **before** loading.
- Surface a real error; never hang.
- Treat first-run download + first load as the most-tested path in the app.

### 4.5 Hallucination: VAD is necessary, not sufficient **[reported]**

VAD-before-ASR stays mandatory. But Whisper's own confidence filters are
known to be insufficient — hallucinations are frequently emitted with **high
confidence and low `no_speech_prob`**
([arXiv 2505.12969](https://arxiv.org/pdf/2505.12969)). Hence the existing
`isLikelyHallucination()` pattern filter as a final defence.

Two open items:
- `condition_on_previous_text = false` is the single highest-value mitigation
  in the literature — it stops one hallucination from seeding the next, which
  is the main cause of repeat-loops in long meetings. **Verify whether
  sherpa-onnx exposes it**; several such knobs are OpenAI-Whisper decoder
  parameters with no sherpa equivalent.
- Our default is Moonshine, not Whisper. **Moonshine's silence behaviour is
  unverified** and may differ substantially. Measure before assuming the
  Whisper mitigations transfer.

### 4.6 CPU baseline — a Windows problem, pre-solved **[reported]**

Meetily [#465](https://github.com/Zackriya-Solutions/meetily/issues/465): ORT
is built with **AVX2 as the CPU baseline** and executes it during *thread pool
init*, before any inference. Pre-Haswell machines die with
`STATUS_ILLEGAL_INSTRUCTION`. Because their VAD is itself an ONNX session,
it crashed at recording start **regardless of which ASR model was chosen** —
exactly our topology.

Near-moot on macOS (all supported Intel Macs are Haswell+; Apple Silicon is
ARM). **Mandatory for the Windows port:** pre-flight CPU feature detection
with an energy-based VAD fallback. Noted here so it is not rediscovered.

---

## 5. Storage

Unchanged from the existing design, and deliberately the outlier.

```
<vault>/2026.08.08-1430-standup/
  mic.wav  system.wav  meta.json  transcript.json  notes.md  transcribe.log
```

Meetily is SQLite-canonical. Buzz is SQLite-canonical. Granola is
encrypted-DB-canonical and got punished for it: when v6 encrypted the local
cache and v7.427+ moved the key into an app-scoped Keychain item, it broke
published third-party integrations — `granola-claude-plugin` is now
deprecated with the note *"Granola encrypted local cache."*

The lesson is sharper than "don't encrypt": what users lost was
**third-party readability**. Granola offered an MCP server as a replacement
and users judged a mediated API an insufficient substitute for files. Plain
files are the structurally correct answer because they survive us shipping an
MCP server *too*.

SQLite is a **derived index**. Delete it, the app rebuilds by rescanning. It
lives in its own `utilityProcess` because better-sqlite3 is synchronous by
design and a heavy query in main freezes the tray. Being derived is what makes
that process cheap to isolate — if it dies, we rescan and lose nothing.

---

## 6. Threat model for the local-only guarantee

"Transcription is local" is the product. It needs an enforcement story, not
just an intention:

- The ASR worker has no network client. Audio buffers exist only in main and
  the ASR worker; neither ever holds an HTTP client for a cloud ASR endpoint.
- AI providers receive **text only, and only on explicit user action**.
  Summarisation is opt-in per session.
- API keys live in the macOS Keychain via `safeStorage`, never in the vault
  and never in the renderer. `ProviderConfig.hasApiKey` sends presence, not
  the key.
- Keep AI HTTP calls out of the ASR worker — separately motivated by electron
  [#43186](https://github.com/electron/electron/issues/43186), where blocking
  a utility process's event loop breaks its subsequent network requests with
  `ECONNRESET`.

---

## 7. Build order

Each step ends in something runnable.

1. **ASR worker skeleton** — `utilityProcess`, request/response protocol,
   sherpa wrapper with `enableExternalBuffer: false`. *Verified feasible
   today; this is now transcription of a fixed WAV end to end.*
2. **Replace the `throw`** in `src/main/index.ts:83` with the worker-backed
   engine. First real transcript.
3. **Recording controller** — `RECORDING_START` / `RECORDING_STOP`, streaming
   WAV writer with periodic header patching, `powerSaveBlocker`.
4. **Model download manager** — `MODEL_DOWNLOAD` / `CANCEL` / `DELETE`,
   checksum verification, resumable, hardened error states (§4.4).
5. **Index worker** — move better-sqlite3 out of main.
6. **AI summarisation** — `AI_SUMMARIZE`, streaming tokens.
7. **Long-run soak** — a 2-hour recording, watching `external` and
   `arrayBuffers` in `process.memoryUsage()`, not just `heapUsed`. Buffer
   memory is invisible to `heapUsed`, which is exactly our risk profile.

---

## 8. Open questions

Tracked honestly rather than guessed at.

| # | Question | Risk if wrong |
|---|---|---|
| 1 | Does sherpa expose `condition_on_previous_text`? | Repeat-loops in long meetings |
| 2 | Moonshine's behaviour on silence — same as Whisper? | Hallucination filter mistuned |
| 3 | Does AudioTee report mid-stream sample-rate changes? | Silent pitch-shifted garbage |
| 4 | ~~Renderer ↔ utilityProcess `MessagePort` wiring~~ | **Settled (phase 5): search transits main.** Not attempted direct — hits are ~200 bytes, so the copy is free, and main must broker anyway to keep one connection per database. Revisit only if a payload ever gets large |
| 5 | Real inference throughput vs. realtime on M-series | Determines whether streaming partials are viable |
| 6 | Does `disclaim` affect mic TCC inheritance? | Leave at default `false`; do not experiment blind |

---

## 9. Decisions, in one page

| Decision | Why |
|---|---|
| TypeScript, not Rust | Working bindings for both native deps; heavy work is already native |
| ASR in `utilityProcess`, per job | `kill()` is the only reliable deallocator; crash isolation |
| Never `worker_threads` for natives | Electron's explicit warning; onnxruntime #20084; electron #43513 |
| `enableExternalBuffer: false`, always | **Verified**: default `true` throws under Electron's memory cage |
| No `install_name_tool` relinking | **Verified**: 1.13.4 ships `@rpath` + `@loader_path` |
| better-sqlite3 in its own process | Synchronous API would freeze the tray; index is derived, so isolation is free |
| Two tracks, never mixed | Free, error-free speaker attribution — the core differentiator |
| Stream to disk, patch header periodically | 2-hour meetings OOM otherwise; crash leaves a playable file |
| Duration from sample count, not timers | OS suspend freezes the event loop and drops ticks |
| Plain files canonical, SQLite derived | Granola's encrypted DB broke real integrations and cost them users |
| Renderer is view-only | Hidden ~always → background-throttled → unreliable for timing |
