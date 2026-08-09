<div align="center">

# Oratio

**Local-first meeting recorder for macOS.**

Records your microphone and your Mac's system audio as two separate tracks,
transcribes both on-device, and writes plain Markdown and JSON into a folder you
choose. No cloud transcription, no account, no screen-recording permission.

![Electron](https://img.shields.io/badge/Electron-43.2.0-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Node](https://img.shields.io/badge/Node-22%2B-5FA04E?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11.5-F69220?logo=pnpm&logoColor=white)
![sherpa-onnx](https://img.shields.io/badge/sherpa--onnx-1.13.4-005CED)
![SQLite](https://img.shields.io/badge/SQLite-FTS5-003B57?logo=sqlite&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-14.2%2B-000000?logo=apple&logoColor=white)
![Licence](https://img.shields.io/badge/licence-MIT-blue)

</div>

Oratio is a meeting recorder that keeps **everything on your machine**. It
captures you and the people you're talking to as two separate tracks, transcribes
them with a local speech model, and stores the result as files you own. It never
sends audio to a third-party service, and it never asks to see your screen.

---

## Contents

- [Highlights](#highlights)
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

## Highlights

- **Two tracks, never mixed.** Your mic is you, system audio is everyone else —
  speaker attribution with no speaker-identification model and no error rate.
- **Transcription is local, always.** There is no cloud ASR path and no fallback
  that uploads audio. This is the product, not a setting.
- **Plain files are the source of truth.** Markdown and JSON in your folder. The
  SQLite index is derived — delete it and it rebuilds.
- **No screen-recording permission.** System audio comes from a Core Audio tap,
  so macOS never lights the purple screen-recording indicator.
- **Knows when a meeting starts.** Offers to record when a call opens the
  microphone — and only ever offers.
- **Survives a crash.** The filesystem *is* the queue, so an interrupted session
  is picked up on the next launch.

## Status

**v0.1.0** — the first release. Recording, local transcription, search,
summarisation, the menu-bar app, per-app audio exclusion and meeting detection
all work. It has been through a two-hour soak, a kill mid-recording, a real
system sleep and a full disk.

Builds are **not signed or notarized**, so macOS calls the app "damaged" on
first launch. It isn't — right-click → **Open** once, and it opens normally
from then on.

Known gaps are listed in [CHANGELOG.md](CHANGELOG.md); the process topology and
the verified platform findings behind it are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

[**Download the latest release →**](https://github.com/6imeon/ORATIO/releases/latest)

## Requirements

| | |
|---|---|
| **macOS** | 14.2 or later — required for the Core Audio process-tap API used to capture system audio without a virtual device or kernel extension |
| **Mac** | Apple Silicon (M1 or later). There is no Intel or Universal build |

Building from source additionally needs **Node 22+** and **pnpm 11+**.

## Getting started

Download the DMG from the [latest
release](https://github.com/6imeon/ORATIO/releases/latest), drag Oratio to
Applications, then **right-click → Open** the first time (see
[Status](#status)).

Or build it yourself:

```sh
pnpm install
pnpm dev
```

Oratio lives in the **menu bar** — there is no Dock icon, and no window opens
on launch. Click the menu-bar icon to start.

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

- **Ollama** — auto-detected on `127.0.0.1:11434` and preferred when present, so
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
