# Oratio — Local-First Meeting Recorder

**Research findings & build plan**
Date: 8 August 2026

**Constraints (fixed):**
- **Electron** — Tauri's webview inconsistencies aren't worth the risk
- **macOS first** — only testable platform right now; Windows later, don't paint into a corner
- **English only** — no multilingual requirement
- **Transcription is local-only**, always. Summarization and "fancier" features use AI providers
- **Multi-provider AI**: OpenAI, Anthropic, and Ollama (local)
- **All storage local**, user picks the folder. No cloud, no account
- **Open source** — no signing/legal analysis needed
- **Target: app under 100 MB**

---

## 1. The size constraint — read this first

**The app can ship under 100 MB. The app *plus model* cannot.** Here are measured numbers, not estimates:

| Component | Size | Notes |
|---|---|---|
| Electron v34 macOS arm64 | **~100 MB** compressed / ~220 MB installed | The floor. Non-negotiable with Electron. |
| `sherpa-onnx-darwin-arm64` | **61.7 MB** | ONNX Runtime + sherpa native libs (npm, measured) |
| `sherpa-onnx-node` | 0.1 MB | Thin JS binding |
| `audiotee` | 0.6 MB | Swift binary for system audio |
| Your JS/UI | ~5-15 MB | React + app code |
| **Subtotal, no model** | **~170 MB compressed** | Already over budget |

Electron alone consumes the entire 100 MB budget. That's the cost of choosing it, and it's a legitimate trade — you get a far easier build and a huge ecosystem.

### The resolution: don't bundle the model

**Ship the app; download the model on first run.** This is exactly what Quill does (its binary is 22 KB; the model is ~600 MB fetched on first transcription), and what Meetily does. Users accept it — it's the norm for local-AI apps.

That gives two honest numbers:
- **Download size: ~170-180 MB** (DMG, compressed)
- **First-run model fetch: 160-660 MB** depending on which model the user picks

**Revised target: under 200 MB download, no bundled model.**

### Decision: Electron over Tauri, with eyes open

Tauri was evaluated and rejected. The size difference is real and it favours Tauri:

| | Electron | Tauri v2 |
|---|---|---|
| Framework baseline | ~100 MB compressed | **~5–10 MB** DMG |
| Total, no model | ~170–180 MB | **~50–75 MB** |
| **Total + Moonshine (288 MB)** | ~460 MB | ~340 MB |

Tauri is the only way under 100 MB. We're choosing Electron anyway, for reasons that outweigh it here:

1. **Once the model is included, the gap is ~35%, not the 25× headline.** The framework stops being the dominant term as soon as a 288 MB model lands next to it.
2. **Ecosystem fit.** Both native dependencies — `audiotee` and `sherpa-onnx-node` — are npm packages with working Node examples. In Tauri, both need hand-written Rust glue.
3. **Solo development on one platform.** Electron's debugging story, documentation, and community depth matter more than binary size when there's one developer and no second platform to test against.

The usual argument against Electron — inconsistent rendering across OS webviews — is inverted here: Electron ships its own Chromium, so rendering is *identical everywhere*. Tauri's WKWebView-on-macOS/WebView2-on-Windows split is the thing that burned other projects (Figma rejected Tauri over exactly this).

**Revisit if** under-100 MB becomes a hard product requirement worth advertising. Meetily and Hyprnote both build this same app in Tauri, so the path exists.

### English-only model options — pick one

All int8-quantized, all via sherpa-onnx, all measured from HuggingFace:

| Model | Size | Speed (CPU) | Accuracy | Verdict |
|---|---|---|---|---|
| **Whisper `base.en`** | **160 MB** | fast | decent | Good default for a "small" build |
| **Moonshine `base-en`** | **288 MB** | very fast, streaming-native | ≈ Whisper large-v3 on English | **Best size/quality ratio** |
| Whisper `small.en` | 375 MB | moderate | good | Middle ground |
| **Parakeet TDT 0.6B v2 (en)** | **661 MB** | ~30× realtime | best (6.05% WER) | What Quill uses. Best accuracy. |
| Parakeet TDT 0.6B v3 | 640 MB | ~30× realtime | 6.32% WER | Multilingual — **skip, you don't need it** |

**Decided: ship a model picker, default to Moonshine base-en.**

Moonshine is the sweet spot — 288 MB, English-only by design, matches Whisper large-v3 quality on English, built for streaming (so live transcription is natural), and MIT-licensed. Users can upgrade to Parakeet v2 (661 MB) for maximum accuracy, or drop to Whisper base.en (160 MB) if disk-constrained.

The picker costs very little: sherpa-onnx loads all four through the same API, so it's a settings dropdown plus a download manager — not four code paths. **Show the download size next to each option** so the choice is informed.

| Picker label | Model | Size |
|---|---|---|
| Fastest, smallest | Whisper `base.en` | 160 MB |
| **Recommended** | **Moonshine `base-en`** | **288 MB** |
| Balanced | Whisper `small.en` | 375 MB |
| Most accurate | Parakeet TDT v2 | 661 MB |

**Note:** since you're English-only, use **Parakeet v2**, not v3. v2 is the English model and slightly more accurate on English; v3 trades a little English accuracy for 25 languages you don't need.

---

## 2. What to take from Quill

Quill is macOS-only Swift, so no code ports. The architecture does.

**Keep:**

| Idea | Why |
|---|---|
| **Two tracks, never mixed** | mic = "me", system = "them". Perfect speaker separation, zero compute, zero error. This is the single most important design decision. |
| **CAF container** | Needs no finalization pass. Crash mid-meeting and everything already written is still readable. An `.m4a` would lose the entire file. |
| **Filesystem as the queue** | A session folder with `meta.json` but no `transcript.json` is pending. Rescan at launch. No queue state to corrupt. |
| **Per-track start offsets** | Record wall-clock time of each recorder's *first actual buffer*; the two tracks don't start on the same instant. Store the delta so timestamps share one clock. |
| **Release the model when idle** | Free the ~300-660 MB of weights when the queue drains. |
| **Empty-file probe before transcribing** | An empty track can throw an uncatchable exception inside the ASR library and kill the process. |

**Note on Meetily:** it applies "intelligent ducking," which mixes the tracks down and destroys the free speaker split. Don't copy that.

**Quill's mic voice-processing RCA is worth reading** (`.issues/rca-001` in the repo). Enabling Apple's echo cancellation while inheriting a multichannel route format, with no output render path connected, produces **digital silence at -91 dB** — success return codes, empty audio. They fixed it by connecting a dead-end mixer purely to give the duplex unit an output path, then *still* shipped a runtime liveness check that detects a silent first second and restarts in raw mode. Copy that defensive pattern.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Renderer — React + TS                                   │
│  notepad · live transcript · search · settings           │
├──────────────────────────────────────────────────────────┤
│  Main process — Node                                     │
│  session mgr · queue · SQLite index · provider router    │
├────────────────────────┬─────────────────────────────────┤
│  Capture               │  Inference                      │
│  audiotee (system)     │  sherpa-onnx-node               │
│  + mic via native/     │  VAD → ASR (local, always)      │
│    getUserMedia        │                                 │
└────────────────────────┴─────────────────────────────────┘
              ↓                          ↓
   user-chosen folder            AI providers (opt-in)
   <vault>/<session>/            OpenAI · Anthropic · Ollama
     mic.caf, system.caf
     transcript.json, notes.md
```

### 3.1 Audio capture (macOS)

**Use [`audiotee`](https://github.com/makeusabrew/audioteejs) (npm, 0.6 MB).** It's a small Swift binary wrapping Core Audio taps (macOS 14.2+), streaming raw PCM over stdout, with a Node wrapper. Runs in the main process, so no renderer overhead.

**Why not Electron's built-in `desktopCapturer`:**

| | `audiotee` (Core Audio taps) | `desktopCapturer` |
|---|---|---|
| Permission | **"System Audio Recording"** only | **"Screen & System Audio Recording"** — misleading and scary for an app that never sees your screen |
| Screen indicator | None | **Purple recording indicator** in Control Centre |
| Capture point | **Pre-mixer** — volume-independent | Post-mixer — turn volume down, lose audio |
| Output | Raw PCM with sample-rate conversion built in | Renderer-side MediaStream plumbing |
| Support matrix | Simple: macOS 14.2+ | Messy, unreliable before macOS 13.2 |

Pre-mixer capture matters more than it sounds: with `desktopCapturer`, a user who turns their speakers down records quiet audio. With taps, volume is irrelevant.

**One thing to watch:** as of Electron v39, Chromium made Core Audio taps the default backend for `desktopCapturer`, and it requires `NSAudioCaptureUsageDescription` in Info.plist. That narrows the gap, but the permission string and screen indicator remain worse. Stick with `audiotee`.

**Mic** can come from `getUserMedia` in the renderer (simple, well-trodden) or a native module. Start with `getUserMedia`; if echo bleed becomes a problem, that's when you deal with voice processing — and Quill's RCA tells you what to expect.

**Keep the two streams in separate files. Never mix them.**

### 3.2 Windows later — don't paint into a corner

You can't test Windows now, so don't build it — but do keep the capture layer behind one interface:

```ts
interface AudioCapture {
  start(opts: { micPath: string; systemPath: string }): Promise<void>
  stop(): Promise<CaptureResult>   // includes per-track firstBufferAt
}
```

`MacCapture` implements it with `audiotee`. Later, `WinCapture` implements it with WASAPI process loopback — which is actually *better* than macOS, since it can capture a single process (only Zoom, skipping Spotify and notification dings). Everything above this interface stays unchanged.

Sherpa-onnx already ships Windows binaries, so the inference layer is portable for free.

### 3.3 Transcription — local, always

**`sherpa-onnx-node`** is the right pick: one npm dependency, ONNX Runtime bundled, and the *same API* for whichever model the user picked. Handles ASR, VAD, and diarization.

**Gate ASR behind VAD — this is mandatory, not polish.** Whisper hallucinates confidently on silence (the classic "Thank you for watching!"), and a system tap produces long silent stretches when nobody is talking. Run Silero VAD (bundled in sherpa-onnx) and skip non-speech regions. Without it the product looks broken.

**Live transcription:** Moonshine is streaming-native, so you can show text as people speak rather than only after Stop. That's a real UX win over Quill (post-hoc only) and worth designing for early.

### 3.4 Storage — the user's machine, their folder

**The user picks a vault directory. Plain files inside it.**

```
<vault>/
  2026.08.08-1430-standup/
    mic.caf
    system.caf
    meta.json          # timestamps, per-track offsets, model used
    transcript.json    # canonical: segments w/ speaker, start_ms, end_ms
    notes.md           # user's notes + AI summary, YAML frontmatter
  index.sqlite         # search index — derived, rebuildable
```

Two rules that make this a genuine differentiator:

1. **Plain files are the source of truth.** Markdown and JSON, greppable, git-friendly, readable in thirty years. Granola encrypted its local database and broke every user workflow built on it — people moved to plain markdown in git and said so loudly. Be the opposite.
2. **SQLite is only an index.** If it's deleted or corrupted, rebuild it by rescanning the vault. Never store anything there that isn't recoverable from the files.

Use **SQLite + FTS5** for search (BM25 ranking, built into SQLite, no extra dependency). Skip vector search at first — for meeting notes, keyword search plus date and participant filters covers most needs. Add `sqlite-vec` later if semantic search proves necessary.

Because the vault is a plain folder, iCloud Drive/Dropbox sync works for free if the user wants it — their choice, not yours.

### 3.5 AI providers — opt-in, never required

Transcription never calls out. Summaries and "fancier" features do, and only with explicit opt-in.

```ts
interface AIProvider {
  id: 'openai' | 'anthropic' | 'ollama'
  summarize(transcript: Transcript, userNotes: string): AsyncIterable<string>
  chat(messages: Message[], context: Transcript): AsyncIterable<string>
}
```

| Provider | Setup | Notes |
|---|---|---|
| **Ollama** | Auto-detect `localhost:11434` | **Default when present.** Fully local, keeps the privacy promise intact. Qwen3 4B or Gemma 3 4B are fine for summaries. |
| **Anthropic** | User's own API key | Claude Haiku 4.5 ≈ $0.02/meeting; Sonnet 5 ≈ $0.06 |
| **OpenAI** | User's own API key | Same shape |

**Design notes:**
- **Bring-your-own-key.** No proxy server, no accounts, nothing for you to operate — right for an open-source project.
- Store keys in the **macOS Keychain** via `safeStorage`, never in plain config.
- **Auto-detect Ollama and prefer it.** If it's running, the whole app is local by default and the privacy claim is unqualified.
- Show a clear indicator when a cloud provider is about to be used, per meeting.
- Everything must degrade gracefully: no provider configured means you still get recording, transcription, and search. Only summaries disappear.

**Copy Granola's core mechanic:** the user's sparse notes *steer* the summary rather than the AI generating from scratch. That's genuinely why people like Granola, and there's nothing proprietary about it.

---

## 4. Competitive context (brief)

Full market analysis is less relevant now that this is open source and English-only, but three facts should shape the product:

1. **Granola raised $125M at a $1.5B valuation** (March 2026) — the category is real and funded. It's cloud-transcribed and requires a Google/Microsoft account.
2. **Users' top complaints are addressable and none require cloud:**
   - **No audio playback tied to the transcript.** Granola deletes the audio. You're keeping it, so click-a-line-to-hear-it is nearly free for you and impossible for them. This is the #1 structural complaint in the category.
   - **Diarization fails on 3+ speakers.** Your dual-track split solves the "me vs them" half perfectly.
   - **Weak export / lock-in.** Your plain-files vault is the direct answer.
3. **The open-source field is thin.** Meetily (28.5k stars) has beta diarization and mixes its tracks. Hyprnote renamed to `anarlog` while its team moved to a cloud product. There's room.

**Highest-value differentiators, in order:** transcript-anchored audio playback → plain-file vault with no lock-in → Ollama-by-default local summaries → live transcription.

---

## 5. Build order

**Phase 1 — the spine.** Electron shell + tray; `audiotee` system capture + mic; two CAF files per session; `meta.json` with per-track offsets; user-picked vault folder. *Success: press record, get two clean audio files where you chose.*

**Phase 2 — transcription.** `sherpa-onnx-node`; first-run model download with progress and SHA-256 check; VAD gating; merge tracks by timestamp into `transcript.json` + `notes.md`; filesystem-as-queue with resume on launch.

**Phase 3 — the product.** Notepad UI with live transcript; **click-a-line-to-hear-it playback**; SQLite FTS5 search across meetings; model picker in settings.

**Phase 4 — AI layer.** Provider abstraction; Ollama auto-detect; OpenAI/Anthropic BYO-key in Keychain; notes-steer-the-summary; per-meeting cloud indicator.

**Later.** Windows via the `AudioCapture` interface; diarization within the system track; persistent speaker identity; action-item export.

---

## 6. Risks and gotchas

| Risk | Mitigation |
|---|---|
| **Silent audio failures** — the expensive class of bug here | Every macOS audio failure mode returns *success* and yields silence. Implement Quill's liveness check: measure peak amplitude over the first second; if exactly zero, tear down and restart raw. |
| **Whisper hallucinating on silence** | VAD gating is mandatory. Also set `suppressBlank`, lower `noSpeechThreshold` to ~0.4. |
| **Model download fails or is interrupted** | Resumable download, SHA-256 verify, clear progress. Add a `doctor` check (Quill's idea) so nobody discovers a missing model right before a meeting. |
| **First-run size shock** | Be upfront in the UI: show model sizes in the picker and let users start with Whisper base.en (160 MB). |
| **Electron memory with a model resident** | Run inference in the main process or a utility process, not the renderer. Release the model when the queue drains. |
| **Windows assumptions leaking in early** | Keep everything behind `AudioCapture`. Don't let CAF or Core Audio specifics escape into shared code. |
| **`audiotee` is a young dependency** | v0.0.7, single maintainer. It's small and MIT — vendor it if it stalls. The underlying Core Audio taps API is stable and well-documented. |

---

## Sources

**Reference implementations:** [digimata/quill](https://github.com/digimata/quill) · [Meetily](https://github.com/Zackriya-Solutions/meetily) · [anarlog (ex-Hyprnote)](https://github.com/fastrepl/anarlog)

**Audio:** [audioteejs](https://github.com/makeusabrew/audioteejs) · [AudioTee (Swift)](https://github.com/makeusabrew/audiotee) · [Recording system audio in Electron on macOS](https://stronglytyped.uk/articles/recording-system-audio-electron-macos-approaches) · [Core Audio taps (Apple)](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps) · [AudioCap sample](https://github.com/insidegui/AudioCap) · [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)

**Inference:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) · [Node addon docs](https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html) · [Moonshine base-en int8](https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8) · [Parakeet v2 int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8) · [Whisper base.en](https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base.en) · [Whisper small.en](https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small.en) · [sherpa-onnx diarization](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html)

**Storage:** [SQLite FTS5](https://www.sqlite.org/fts5.html) · [sqlite-vec](https://github.com/asg017/sqlite-vec)
