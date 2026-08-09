# Changelog

All notable changes to Oratio are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been released yet. Everything below is under `Unreleased` until
the first build ships — see [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)
for what has to land first.

## [Unreleased]

### Added

- **Transcription explains itself on very old or virtualised computers instead
  of failing.** The speech-recognition engine requires an AVX2-capable
  processor. On machines without one — pre-2013 CPUs, and more commonly virtual
  machines where AVX2 is switched off by the host — it did not report an error;
  the transcription process died outright, leaving a recording stuck with no
  explanation.

  Oratio now checks before starting and says plainly that this computer cannot
  transcribe locally. **Recording still works and your audio is still saved**,
  so those files transcribe normally when opened on another computer. Since
  transcription is always local, there is no cloud fallback to offer, and
  claiming otherwise would be worse than saying so.

  Speech detection, which also used the affected engine, falls back to a simpler
  loudness-based method rather than being skipped. Skipping it would let the
  transcript fill with text invented during silence.

- **Oratio notices when a meeting starts.** When Zoom, Teams, Slack, FaceTime or
  a browser opens the microphone, the menu bar offers to record it — a
  notification and a "Record this meeting" item in the tray menu. "Not now"
  silences it for the rest of that call.

  It only ever offers. Nothing starts recording on its own, and that is a
  deliberate limit rather than a missing feature: a missed prompt costs one
  click, while an unwanted automatic recording puts a private conversation on
  disk. It also does not read your screen or your window titles — detection uses
  the same audio-process list the app already reads, which needs no permission
  and raises no prompt, so nothing new is being asked for.

  Turning it off in Settings → Recording stops the background check entirely
  rather than just hiding the notification.

- **Apps can be kept out of the recording.** The system-audio tap was
  all-or-nothing, so music playing during a meeting landed in the "them" track
  and came back in the transcript as whatever the model made of the lyrics.
  Settings → Recording now has an "Ignore these apps" list, picked from what is
  currently open, and Spotify and Music are ignored by default.

  It excludes rather than includes, because the two fail in opposite directions:
  an app that is closed or silent simply is not excluded, whereas an include-list
  would record nothing at all if you started before anyone spoke. Meeting apps
  are deliberately not on the default list for the same reason.

  Exclusion covers the whole app, not just its main process — Chrome plays audio
  from three separate processes and Spotify runs seven, so excluding only the
  obvious one would have looked like the setting doing nothing. If an excluded
  app stops making sound at the exact moment recording starts, the tap is
  restarted without exclusions rather than failing: a meeting with music in it
  is a poor recording, but no recording at all is a lost meeting.

- **Transcript audio has a real transport: play, pause, scrub, and speed.**
  Playback was previously click-a-line-to-hear-it with no way to stop it and no
  way to resume — clicking the line that was already playing restarted it. There
  is now a bar above the transcript with play/pause, a scrubber, ±10 s, previous
  and next turn, and speeds up to 2×. Space plays and pauses, ← and → skip, and
  clicking the line that is currently playing pauses it. Space is ignored while
  the cursor is in the notes, so it still types a space where you would expect.

  Playback also continues past the end of a turn now. The two tracks are
  separate files by design, so following a conversation across a handoff means
  moving the playhead between them; it used to simply stop at the first change
  of speaker.

- **Your microphone no longer puts the other person's words in your mouth.**
  Recording through speakers instead of headphones means the mic also hears the
  meeting audio from the room, so the transcript recorded you saying whatever
  they said — badly, since it is a second-hand copy. Oratio now compares the two
  tracks and drops those segments. It is a detection, not an echo canceller:
  the audio is never modified, so this cannot produce a silent recording. Off
  in Settings for anyone on headphones, who gains nothing from it.

- **Meetings can be exported.** Markdown, PDF, Word, plain text, and — for the
  transcript itself — SRT, WebVTT and JSON, with an option to append the full
  transcript to the document formats. The vault was always plain files, so this
  is not an escape hatch; it is for handing one meeting to someone who does not
  use Oratio.

- **Light and dark themes can be chosen**, not just inherited. Settings has
  System, Light and Dark; System follows macOS as before.

- **Summaries render as formatted text.** Bold, italics, code and bullet lists
  now display as themselves rather than as literal asterisks — the summary
  prompt asks the model for bullets in three of its five sections, so this had
  been visible in every summary with an action-item list.

- **OpenRouter is available as a summariser.** One key reaches most models —
  Claude, GPT, Gemini, Llama, DeepSeek — so using a model Oratio has never
  heard of does not require Oratio to ship an SDK for it. Models are named the
  way OpenRouter names them (`anthropic/claude-sonnet-5`), and the settings
  pane says so rather than leaving it to be discovered through a failed
  summary. Like every cloud provider it is opt-in, off by default, never
  auto-selected, and used only for summaries: **audio and transcription stay on
  your machine regardless of which provider is chosen.**

- **The app has an icon**, and the menu-bar item has its own: a speech bubble
  with two offset lines, one for each side of the conversation — the two tracks
  Oratio records separately and never mixes.

- **A recording interrupted by a crash is no longer lost.** If the app dies
  mid-meeting — a crash, a force quit, the battery going — the next launch
  finds the audio, repairs the WAV headers from what is on disk, writes the
  `meta.json` the crashed process never got to write, and hands the session to
  transcription like any other. The recovered meeting is labelled as such,
  because it may be missing its last few seconds. Previously the audio stayed
  on disk and nothing ever looked at it again.

- **Settings is real, and first run does one thing.** Five groups on one
  screen — Vault, Model, Recording, Summaries, Permissions — with no tabs, no
  sub-pages and no Save button: every control writes as you change it.
  - **A new Mac gets a setup screen, not an empty app.** It downloads the
    recommended model with a real percentage, a real error and a retry in
    place, then leaves by itself when the model lands. It is skippable, and it
    comes back if you later delete your only model — readiness is checked
    against the disk rather than remembered as a flag.
  - **Recording now refuses early when no model is installed**, instead of
    recording a whole meeting and failing to transcribe it afterwards. The
    refusal names the fix and says it only has to happen once.
  - **The model picker shows both numbers**: the download and what it actually
    occupies once installed. For Whisper small those differ by 278 MB, and
    showing one of them would mislead either way. The model in use cannot be
    deleted out from under the next recording.
  - **"Reveal in Finder" opens Finder**, including on a fresh install where
    the vault folder has not been created yet — which is exactly the case where
    the button used to do nothing at all, silently.
  - **Permissions are worded as evidence, not as status.** macOS cannot be
    asked whether system-audio capture is permitted, so Oratio says what it
    observed and when: "appears to be working, based on your last recording on
    …". Never a green tick it did not earn, and a blocked state links straight
    to the right System Settings pane.
  - **API keys are write-only.** They go to the macOS Keychain and are never
    read back into the window — the field shows "Saved in your Keychain"
    rather than a masked value, because there is nothing to show.

- **Meetings can be summarised, and the summary is yours to undo.** Press
  `⌘E` or the Summarise button and the model expands your notes into five
  sections — Summary, Decisions, Action items, Discussion, Open questions —
  streaming into the page as they are written rather than appearing all at once
  a minute later. Your notes are the outline: write "pricing concerns" and the
  summary pulls every pricing exchange out of the transcript.
  - **Black text is yours, grey text is the model's.** The provenance of every
    sentence is visible without a badge or a mode, and the AI half is not
    editable — which is what keeps the distinction meaning anything.
  - **"Reset to my notes" is non-destructive by construction.** `notes.md` now
    holds the two halves as separate fields, so removing the summary cannot
    reach your writing, and your writing cannot overwrite the summary.
  - **Cancel keeps what arrived.** Stopping a summary mid-stream keeps the
    sections already written rather than throwing away work you watched appear.
  - **Ollama is auto-detected and preferred**, so with it installed the whole
    app is local — audio, transcript *and* summary — and the privacy claim
    needs no asterisk. A cloud provider is never selected for you.
  - **The UI says where your text goes**, on the summary itself and in
    Settings: "stayed on this Mac" for a local run, and the provider's name
    when it did not.

- **The menu bar carries the whole app.** With no Dock icon, the tray is the
  only always-visible surface, so it now does real work: a native `Menu` (never
  a popover — AppKit draws it instantly, where a popover needs a live renderer
  and 350–450 MB), the five most recent meetings, a Settings item, and a global
  `⌃⇧R` for start/stop.
  - **Three states, not two.** Idle, recording and *transcribing* — the third
    is the one that says "still working" after a meeting ends, and without it a
    long ASR job looks like the app has gone idle and eaten the recording. It
    counts the backlog rather than showing a boolean, so a queue several deep
    after a crash says so.
  - **Clicking a recent meeting opens the window at that meeting**, including
    from a standing start with no window open.
  - **Every tray action has a second path.** macOS hides menu-bar extras when
    the bar is crowded, so on a notched MacBook the icon can simply not be
    there: start/stop has a global shortcut and Settings is reachable from the
    sidebar and `⌘,`.
- **Settings is reachable and tells the truth** (`SettingsView.tsx`) — vault
  path, active model, VAD, audio retention and summarisation provider, read
  from the real settings file. Editing arrives with the model picker in a later
  phase; a menu item that opened a panel of placeholder text would be worse
  than one that was absent.
- **The meeting view is layout J: full-width notes with a transcript drawer**
  (`TranscriptDrawer.tsx`, `useDrawerState.ts`). Closed, the window *is* the
  notebook — the widest writing column available — and the handle is always
  visible, so the transcript is never hidden the way Granola's is. Three
  states rather than two: closed, half and full, cycled by double-clicking the
  handle, dragged to any size in between, and toggled with `⌘T`.
  - **Opening it does not steal focus from the notes editor.** One
    `preventDefault()` on the handle's `mousedown` is what leaves the caret
    mid-sentence while the drawer opens underneath — otherwise checking a name
    in the transcript costs you your place in the sentence you were writing.
  - **It reopens where you left it, per session**, and reopening while audio
    is playing lands on the turn being played rather than at the top of a
    two-hour transcript. The drawer is a targeted reveal, not a toggle.
  - `⌘T` returns to the last *open* size, so toggling a full-height drawer
    twice doesn't silently demote it to half.
- **The transcript renders speaker turns, not ASR segments.** Consecutive
  segments from one speaker merge into a paragraph with a single timestamp at
  the handoff, following W3C's transcript guidance. On a real transcript this
  turned **4 000 segments into 1 334 turns** — a 3× cut in rows before any
  rendering strategy is involved, and it reads as prose instead of captions.
  Paragraphs with hanging indents, not chat bubbles: bubbles halve text
  density, and Granola's were described as "a one-sided WhatsApp".
  - A pause longer than six seconds splits a turn even without a speaker
    change, so ten minutes of one person talking doesn't collapse into one
    unscrollable block with a single seek point.
- **A designed dark theme, not an inverted one** — declared once as tokens in
  `styles.css` rather than scattered `dark:` variants, because a theme spread
  across fifty utility classes cannot be reviewed as a theme. Neutrals carry a
  slight blue bias in light and a warm bias in dark; the dark ground is a
  raised near-black so vibrancy has something to sit against, and both track
  accents are re-tuned per theme rather than reused. Follows the system by
  default and honours an explicit override in either direction.
- **Date grouping and per-row status in the sidebar** — Today / Yesterday /
  This week / This month, then month-and-year headings. "This week" is a
  rolling seven days, not the calendar week, or on a Monday last Friday's
  meeting files under a month heading. A session that is queued, transcribing
  or failed says so; a ready one stays quiet.

### Performance

- **A 1 334-turn transcript stays entirely in the DOM.** `content-visibility:
  auto` with `contain-intrinsic-size` was tried before any JS virtualization,
  and proved sufficient: 40 forced scroll-and-layout passes over the full list
  take **1 ms**. TanStack Virtual was therefore not needed, which is the point
  — every windowing library breaks ⌘F, select-all across the whole transcript,
  or scroll anchoring, and those are three of the four things we do that
  Granola doesn't.
- **The active-turn highlight only mutates a class on an existing node.** It
  never inserts or removes DOM nodes, because that is the bug Vibe shipped
  four separate `removeChild` crashes from, and `timeupdate` fires up to 66
  times a second. Verified with a `MutationObserver`: 300 highlight moves
  produce **zero** `childList` mutations.
- **The active turn is found by binary search**, not a linear scan — averaging
  0.00003 ms per lookup over 2 000 turns, and checked against a linear scan at
  ~20 000 probe points with no disagreements.
- **Session selection and transcript clicks act on `mousedown`**, not
  `mouseup`, which VS Code measured as ~50 ms of perceived latency on any
  control whose action isn't cancellable.

### Fixed

- **A relative `ORATIO_VAULT` scattered session folders through the working
  tree.** The test-only vault override was passed to `join()` unchecked, so a
  relative value resolved against the current directory — which in `pnpm dev` is
  the repo root. Four empty session folders had accumulated there, and because
  they carried real session names and real `.wav` files they were indistinguishable
  from genuine recordings on sight. The override now requires an absolute path
  and logs a warning otherwise, rather than resolving somewhere surprising.

- **Starting a recording from the menu bar captured only the other side.** The
  microphone lives in a window — `getUserMedia` is the only mic API Electron
  offers — so a meeting started from the tray with nothing open recorded system
  audio and a 44-byte mic track, saying so only in the log. For a menu-bar app
  that is the normal way to start a meeting, not an edge case. Main now creates
  an invisible window to hold the mic and closes it when the recording stops.
- **No recording could start in development.** The fix for the packaged-app
  `spawn ENOTDIR` introduced `const require = createRequire(...)`, which in a
  CommonJS bundle shadows the module's own `require` for the entire function —
  so the call hit the temporal dead zone and threw *"Cannot access 'require'
  before initialization"*. The packaged build takes the other branch and never
  reached it, which is exactly why it survived testing.
- **Summaries all rendered as one undifferentiated block.** The section parser
  required the two section signs the prompt asks for, and models emit one — a
  real run produced `§` on all five headers, so nothing was classified and every
  section fell through as body text. It now accepts one or more and anchors on
  the section name.
- **Choosing a summariser did not enable it.** Picking a provider set the active
  provider but left its `enabled` flag false, and nothing in the UI could set
  that flag — so Summarise stayed permanently greyed out with the provider
  visibly selected and no explanation. Choosing a provider now enables it, and
  the reason a summariser is unavailable is written to the log.
- **The "this leaves your Mac" warning could have gone missing on a new
  provider.** The check listed the cloud providers by name, so anything added
  later was treated as local until someone remembered to update that line — a
  privacy disclosure that fails open. It now lists the providers that stay
  local instead, so the default for anything new is to warn.
- **The packaged app carried files it should not have.** The build's file list
  was a set of exclusions, which ships anything new by default; a build was
  found containing the test harness and local working notes. It is now an
  allow-list naming only what the app needs.
- **A full disk crashed the app instead of telling you.** The WAV writer had no
  error handler, so a disk filling up mid-meeting raised an unhandled stream
  error and took the whole process down — losing the recording it was in the
  middle of. It now stops writing, reports which file failed and why, keeps
  every second captured before the failure, and still saves the meeting.
- **A WAV could claim more audio than it contained.** The header was written
  from the byte count handed to the stream, which runs ahead of what reached
  the disk when a write fails part-way. Players would read past the end of the
  file — right at the end of the recording, which is the part someone
  recovering a crashed meeting most wants back. The size is now taken from the
  file itself.
- **System-audio status was hardcoded, not detected.** The permissions check
  returned "unknown" unconditionally, so it could never have told you your
  system audio was blocked. It now reports what the last completed recording
  actually captured, persisted across launches — which is the only way to know,
  since macOS offers no way to query it without starting a capture.
- **"Open at login" did nothing.** The preference was saved and read back
  faithfully and never registered with macOS. It is now applied on every write,
  so removing Oratio from Login Items in System Settings is corrected rather
  than silently disagreed with.
- **A missing model failed after the meeting instead of before it.** Nothing
  checked for an installed model before recording, so a new user could capture
  a full meeting and only then discover nothing could transcribe it. The audio
  survived, but the news arrived an hour too late to act on.
- **The download progress bar said "downloading" while it was unpacking.** The
  last tenth of the bar is checksum verification and extraction, which report
  no byte progress — so the label described the wrong activity at exactly the
  point the bar stops moving and you start wondering whether it has hung.
- **Typing after generating a summary would have destroyed it.** `notes.md`
  was read and written as one opaque blob, so the notes editor's autosave —
  which fires 600 ms after every keystroke — wrote the file back without the
  summary. The write succeeded, so nothing reported a problem. The file is now
  parsed into the user's half and the model's half, and each can only write its
  own.
- **Two summaries of the same meeting could run at once and race on the
  file.** The guard checked a map before its first `await` but populated it
  several awaits later, so two calls a millisecond apart — a double-click, or
  the window and the tray both asking — both got through. The slot is now
  claimed synchronously.
- **Cancelling a summary threw away everything that had streamed.** Aborting
  the request rejects the in-flight read, so the function throws instead of
  returning, and the partial text went with it — on precisely the path where
  the user had been watching it arrive.
- **The menu-bar icon did not exist, so the tray was invisible.**
  `resources/` was empty and `nativeImage.createFromPath` returns an *empty
  image* rather than throwing on a missing file. With no Dock icon and the
  window closed, the app had no visible surface at all. The asset now ships at
  1× and 2×, and an empty image is reported as an error instead of silently
  producing nothing.
- **The icon path broke whenever the bundler regrouped the code.** It was
  resolved from `__dirname`, but rollup decides which chunk a module lands in —
  `tray.ts` is emitted into `out/main/chunks/`, a level deeper than expected —
  so the walk pointed somewhere else entirely. Same bug the ASR worker hit;
  both now resolve from `app.getAppPath()`.
- **Every click on the drawer handle was a zero-distance drag.** `pointerdown`
  began a resize unconditionally, so the `pointerup` that ended it snapped and
  persisted a drawer state — silently overwriting the double-click that was
  meant to cycle it. A drag now only begins once the pointer has actually
  moved.
- **Double-click did nothing across most of the drawer handle.** The label
  button swallowed the event, so the cycle gesture only worked on the few
  pixels of bare handle either side of the most obvious thing to aim at.
- **Switching sessions could overwrite the next session's notes with an empty
  string**, when the debounced autosave fired against freshly-mounted empty
  state before the load resolved. Saves are now gated on the load completing,
  and an out-of-order load is discarded rather than shown under the wrong
  meeting's title.

- **Search index moved into its own process**
  (`src/main/storage/worker/`, fronted by `IndexClient`). better-sqlite3 is
  synchronous by design, so every query blocked the thread that also draws the
  tray and services the recording controller's 30 Hz state pushes. Measured on
  20 000 segments: through the worker, main's event loop ticked 9 times in
  46 ms; the same work in-process gave **0 ticks in 36 ms** — the menu bar
  frozen for the whole duration. Search now never touches the tray.
  - **Long-lived, unlike the ASR worker.** That one is killed per job because
    inference leaks and process exit is the only reliable deallocator. SQLite's
    footprint is bounded by its page cache instead, and respawning would mean
    opening the database on every keystroke of an as-you-type search. It is
    spawned once and reaped on quit, so it can never outlive the app holding a
    WAL lock.
  - **A dead worker makes search go quiet, not throw.** It is not respawned
    automatically: the index is derived, so the honest failure is that search
    stops until the next launch rebuilds it. Auto-restarting would hide a crash
    loop behind a search box that works every other query.
- **Rebuild the search index by rescanning the vault** (`session:reindex`).
  What makes "SQLite is only a derived index" a testable claim rather than an
  aspiration: delete `index.sqlite` and everything comes back from the plain
  files alone. Verified by deleting the database outright — including its
  `-wal` and `-shm` — and recovering a full vault.
- **Startup reconcile between vault and index, both directions.** Sessions on
  disk the index has not seen get added, and sessions the index still holds
  that are gone from disk get dropped. The second half matters because the
  vault is an ordinary folder the user chose: deleting a session in Finder is
  a supported action, and a search hit that opens nothing is worse than no hit.
  Runs in the background so it never delays the tray appearing.
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

- **The search payload rule was unenforced at the boundary that matters.** The
  preload binding for `session.search` was the one untyped call on the bridge,
  so it returned `any` and nothing stopped a whole transcript being handed to
  the renderer. `SearchHit` now lives in `shared/types.ts` — it crosses to the
  renderer, which cannot import from `main/` — and the binding is typed against
  it. A real hit measures 193 bytes.
- **Deleting a session could fail on a healthy delete.** `SESSION_DELETE`
  removed the files and then unindexed; with the index now in another process
  that second step can reject, which would surface as a failed deletion even
  though the files were already gone. It is best-effort and logged instead, and
  the next launch's reconcile clears the stale row.
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

- **Groundwork for a Windows build**, with no change to how the app behaves on
  macOS. The audio-capture interface now declares the four microphone methods
  that previously existed only on the macOS implementation, so nothing outside
  the audio layer depends on a specific platform any more, and sherpa-onnx's
  Windows binaries are installed alongside the macOS ones.

  The macOS installer is unchanged at 146 MB. Getting there needed a deliberate
  build filter: asking pnpm for the Windows binaries also pulls the Intel-macOS
  ones, which had quietly added 19 MB to an Apple-Silicon-only download.

  See [docs/WINDOWS.md](docs/WINDOWS.md) for the phased plan. Windows itself is
  not buildable yet — this is phase W1 of five.

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
