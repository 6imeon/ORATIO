# Oratio

Local-first meeting recorder and transcriber for macOS.

Records your microphone and your Mac's system audio as **two separate tracks**,
transcribes both **entirely on your machine**, and writes the result as plain
Markdown and JSON in a folder you choose.

Your audio never leaves your computer. There is no account, no server, and no
cloud transcription.

---

## Status

Early development. The architecture and interfaces are in place; capture,
transcription, and UI are being wired up. See [docs/RESEARCH.md](docs/RESEARCH.md) for
the design rationale and competitive analysis behind these choices.

## Requirements

- **macOS 14.2+** — required for the Core Audio process-tap API used to
  capture system audio without a virtual device or kernel extension
- Node 22+
- [pnpm](https://pnpm.io) 11+

## Getting started

```sh
pnpm install
pnpm dev
```

On first launch macOS will ask for two separate permissions:

- **Microphone** — your side of the conversation
- **System Audio Recording** — everyone else's

Both prompts are one-time. Oratio never asks for screen recording access.

## How it works

```
Meeting
  ├─ microphone  ──►  mic.wav      ──┐
  └─ system audio ─►  system.wav   ──┤
                                     ├─►  VAD  ─►  local ASR  ─►  transcript.json
                                     │                                 │
                                     └─────────────────────────────────┴─►  notes.md
```

**Two tracks, never mixed.** Your mic is you; system audio is everyone else.
That split gives perfect speaker attribution with no speaker-identification
model and no error — and it means each track reaches the transcription model
as clean, single-source audio.

**Voice activity detection runs first.** Speech models hallucinate confidently
on silence, and a system-audio tap records plenty of it. Non-speech is dropped
before it ever reaches the model.

**The filesystem is the queue.** A session folder with `meta.json` but no
`transcript.json` is pending, by definition. Quit or crash mid-transcription
and the next launch simply picks up where it left off.

## Your data

Everything lives in a folder you pick:

```
<vault>/
  2026.08.08-1430/
    mic.wav          your side
    system.wav       everyone else
    meta.json        timings and per-track offsets
    transcript.json  canonical transcript
    notes.md         your notes + AI summary, with YAML frontmatter
```

Plain files, greppable and diffable, readable by anything. The SQLite search
index is **derived** — delete it and it rebuilds from the files. Point the
vault at iCloud Drive or a git repo if you want sync; that's your call, not
ours.

## Transcription models

All local, all English, chosen in Settings and downloaded on first use.
Nothing is bundled, so the app download stays small.

| Model | Download | Notes |
|---|---|---|
| Whisper base.en | 209 MB | Fastest and smallest |
| **Moonshine base** | **251 MB** | **Default** — large-v3-level English accuracy, streaming-capable |
| Parakeet TDT v2 | 482 MB | Best accuracy |
| Whisper small.en | 636 MB | Largest |

## AI features (optional)

Transcription is always local. **Summaries** are the only feature that can use
an AI provider, and it is entirely opt-in:

- **Ollama** — auto-detected on `localhost:11434` and preferred when present,
  so the whole pipeline stays on your machine
- **Anthropic** / **OpenAI** — bring your own API key, stored in the macOS
  Keychain

With no provider configured, Oratio records, transcribes, and searches exactly
as well — you just don't get generated summaries.

## Recording responsibly

Oratio records both sides of a conversation. Recording laws vary by
jurisdiction and several places require every participant's consent. Tell
people you're recording.

## Development

```sh
pnpm dev          # run with hot reload
pnpm typecheck    # tsc across main, preload, and renderer
pnpm build:mac    # produce a DMG in dist/
```

Builds are unsigned. macOS will require right-click → Open on first launch.

### Layout

```
src/
  main/           Electron main process
    audio/        capture (platform-specific behind AudioCapture)
    transcription/  ASR engine, VAD, and the job queue
    storage/      vault, settings, search index
    ai/           summary providers
    ipc/          channel handlers
  preload/        the single renderer↔main bridge
  renderer/       React UI
  shared/         types and IPC contracts used by both sides
```

### Dependencies

This project uses **pnpm only** and enforces a **7-day minimum release age**
on every package (`pnpm-workspace.yaml`). Compromised npm releases are usually
detected and pulled within days, so the delay means a malicious version is
rarely installable here. Use `pnpm add`, never `npm install`.

## Licence

MIT
