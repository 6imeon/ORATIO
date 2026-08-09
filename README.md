<div align="center">

# Oratio

**Local-first meeting recorder and transcriber for macOS.**

Records your microphone and your Mac's system audio as two separate tracks,
transcribes both entirely on your machine, and writes the result as plain
Markdown and JSON in a folder you choose.

[![Platform](https://img.shields.io/badge/platform-macOS%2014.2%2B-black)](#requirements)
[![Licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)
[![Transcription](https://img.shields.io/badge/transcription-100%25%20local-brightgreen)](#ai-features-optional)
[![Status](https://img.shields.io/badge/status-pre--release-orange)](#status)

</div>

> **Your audio never leaves your computer.** No account, no server, no cloud
> transcription — and no screen-recording permission.

---

## Contents

- [Why Oratio](#why-oratio)
- [Status](#status)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [How it works](#how-it-works)
- [Your data](#your-data)
- [Transcription models](#transcription-models)
- [AI features (optional)](#ai-features-optional)
- [Recording responsibly](#recording-responsibly)
- [Development](#development)
- [Licence](#licence)

---

## Why Oratio

|  | |
|---|---|
| **Two tracks, never mixed** | Your mic is you, system audio is everyone else. Perfect speaker attribution with no speaker-identification model and no error rate. |
| **Transcription is local, always** | There is no cloud ASR path and no fallback that uploads audio. This is the product, not a setting. |
| **Plain files are the truth** | Markdown and JSON in your folder. The search index is derived and rebuildable — delete it and it comes back. |
| **No screen recording** | System audio is captured through a Core Audio tap, so macOS never shows the purple screen-recording indicator. |
| **Knows when a meeting starts** | Offers to record when a call opens the microphone. It only ever offers. |

## Status

**Pre-release.** Twelve build phases are done — recording, local transcription,
search, the UI, the menu-bar app, summarisation, settings, first run, a
hardening pass, per-app audio exclusion and meeting detection. The hardening
pass has been through a two-hour soak, a kill mid-recording, a real system
sleep and a full disk.

What is left before a release is **packaging and code signing**. There is no
signed build yet, so running Oratio means building it yourself.

See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for what each phase
covered and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the process
topology and the verified platform findings behind it.

## Requirements

| | |
|---|---|
| **macOS** | 14.2 or later — required for the Core Audio process-tap API used to capture system audio without a virtual device or kernel extension |
| **Node** | 22 or later |
| **pnpm** | 11 or later |

## Getting started

```sh
pnpm install
pnpm dev
```

On first launch macOS asks for two separate permissions:

- **Microphone** — your side of the conversation
- **System Audio Recording** — everyone else's

Both prompts are one-time. Oratio never asks for screen recording access.

## How it works

```
Meeting
  ├─ microphone  ──►  mic.wav     ──┐
  └─ system audio ─►  system.wav  ──┤
                                    ├─►  VAD  ─►  local ASR  ─►  transcript.json
                                    │                                 │
                                    └─────────────────────────────────┴─►  notes.md
```

**Two tracks, never mixed.** Your mic is you; system audio is everyone else.
That split gives speaker attribution for free, with no speaker-identification
model and no error — and it means each track reaches the transcription model as
clean, single-source audio.

**Voice activity detection runs first.** Speech models hallucinate confidently
on silence, and a system-audio tap records plenty of it. Non-speech is dropped
before it ever reaches the model.

**The filesystem is the queue.** A session folder with `meta.json` but no
`transcript.json` is pending, by definition. Quit or crash mid-transcription and
the next launch picks up where it left off — there is no queue database to
corrupt.

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

Plain files — greppable, diffable, readable by anything. The SQLite search index
is **derived**: delete it and it rebuilds from the files. Point the vault at
iCloud Drive or a git repo if you want sync; that is your call, not ours.

## Transcription models

All local, all English, chosen in Settings and downloaded on first use. Nothing
is bundled, so the app download stays small.

| Model | Download | Notes |
|---|---|---|
| Whisper base.en | 209 MB | Fastest and smallest |
| **Moonshine base** | **251 MB** | **Default** — large-v3-level English accuracy, streaming-capable |
| Parakeet TDT v2 | 482 MB | Best accuracy |
| Whisper small.en | 636 MB | Largest |

## AI features (optional)

Transcription is **always** local. **Summaries** are the only feature that can
use an AI provider, and they are entirely opt-in:

- **Ollama** — auto-detected on `localhost:11434` and preferred when present, so
  the whole pipeline stays on your machine
- **Anthropic** / **OpenAI** / **OpenRouter** — bring your own API key, stored in
  the macOS Keychain

With no provider configured, Oratio records, transcribes and searches exactly as
well. You just don't get generated summaries.

## Recording responsibly

Oratio records both sides of a conversation. Recording laws vary by
jurisdiction, and several places require every participant's consent. **Tell
people you're recording.**

## Development

```sh
pnpm dev          # run with hot reload
pnpm typecheck    # tsc across main, preload and renderer
pnpm build:mac    # produce a DMG in release/
```

Builds are unsigned, so macOS requires right-click → Open on first launch.

### Layout

```
src/
  main/             Electron main process
    audio/          capture (platform-specific behind AudioCapture)
    transcription/  ASR engine, VAD and the job queue
    recording/      session lifecycle and crash recovery
    storage/        vault, settings, search index
    models/         model catalogue and downloads
    export/         Markdown and JSON output
    ai/             summary providers
    ipc/            channel handlers
  preload/          the single renderer↔main bridge
  renderer/         React UI
  shared/           types and IPC contracts used by both sides
native/             Core Audio process probe (C)
```

### Dependencies

This project uses **pnpm only** and enforces a **7-day minimum release age** on
every package, set via `minimumReleaseAge` in `pnpm-workspace.yaml`. Compromised
npm releases are usually detected and pulled within days, so the delay means a
malicious version is rarely installable here.

Use `pnpm add` — never `npm install`.

## Licence

[MIT](LICENSE)
