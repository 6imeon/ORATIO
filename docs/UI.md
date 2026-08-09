# Oratio — UI design

**Status:** design of record, v1
**Date:** 8 August 2026
**Scope:** macOS 14.2+, menu-bar app (`LSUIElement: true`), English-only

Companion to [ARCHITECTURE.md](ARCHITECTURE.md), which covers process topology
and the audio/ASR pipeline. This document covers everything the user sees, and
the performance work that makes it feel instant.

Claims are marked **[verified]** (read the primary source or measured it here),
**[reported]** (credible secondary source), or **[inferred]** (my reasoning,
not a citation). The distinction matters because several popular UI ideas in
this space are things users actively complained about.

---

## 0. The performance thesis

> **A UI is fast when the user never waits for it to decide what to show.**

Not "renders quickly". The lag people feel in Electron apps is almost never
paint time — it is work scheduled *between* the input and the paint. So the
design rules below are mostly about **removing decisions from the critical
path**, not about micro-optimising React.

Three numbers set the budget:

| Threshold | Source | What it governs |
|---|---|---|
| **~8.3 ms** | 120 Hz ProMotion frame | Scroll and meter animation. Every Mac we target is 120 Hz or 60 Hz; miss the frame and it is visible. |
| **100 ms** | Card et al. 1991 / Nielsen 1993 **[reported]** | "Feels instantaneous". Click → visible response. |
| **1 s** | same | "Flow of thought uninterrupted". Anything slower needs progress feedback. |

The classic 100 ms figure is a *ceiling*, not a target. Modern HCI work
(Ng et al., UIST 2012 **[reported]**) found users perceive touch latency far
below 100 ms — single-digit milliseconds for dragging. **Dragging and
scrolling are far more latency-sensitive than clicking.** For us that means
the transcript scroll and the level meter get the strict budget; opening a
settings pane does not.

### The one Electron number that matters most

**[verified, from Electron's own PR #20214]** IPC serialisation cost is
dominated by *payload size*, not call count:

- 512 KB payload: ~24 ms one way
- 1 MB payload: ~70 ms one way

Meanwhile all async IPC channels (`send`, `invoke`, `MessagePort`) cost roughly
**~1 ms per round trip** at small payloads — they are within noise of each
other **[verified, electron-bench, Electron 41]**.

> **Rule: never send a large object over IPC. Message *rate* and *size* are
> the enemy; the choice of channel barely matters.**

This single fact drives §3 (send levels, not buffers), §4 (send transcript
*slices*, not whole transcripts) and §6 (search in SQLite, return IDs).

---

## 1. What the competition got wrong

Researched from primary sources — issue trackers, official docs, and hands-on
reviews. These are not hypotheticals; each is a named, cited complaint, and
each one is cheap for us to avoid.

### Granola

The closest thing to a direct competitor, and the design we borrow the most
from. Its failures are unusually well documented.

| Complaint | Source | Our answer |
|---|---|---|
| **"There's no scroll bar for you to quickly jump to the beginning of the meeting"** | tldv review **[verified]** | §4: persistent scrollbar + timeline rail. |
| **No transcript search.** "There's no built-in way to search through a transcript directly… not as fast or precise as a true search feature" | Zapier **[verified]** | §6: ⌘F in-transcript, ⌘K across all. |
| **No audio, ever.** "Does not record or save audio or video at any point… there's no way to access audio from your meetings" | Granola docs **[verified]** | §4: click any line, hear it. We keep the WAVs. |
| **No export.** Copy-paste only; scored 66/100, "wants to keep that data locked into their ecosystem" | meetingnotes.com **[verified]** | Plain files *are* the storage. Nothing to export. |
| **Requires "Screen & System Audio Recording" permission** | Granola docs **[verified]** | AudioTee needs only System Audio Recording. No screen indicator. |
| Chat history lost on re-entering a meeting | tldv **[verified]** | Notes are files, written through. |
| **"The gray on gray makes me think I'm on Windows 95"** | tldv **[verified]** | §2: committed palette, real dark mode. |
| First-run confusion: "I had no idea where the live transcript was, why the notes were empty" | tldv **[verified]** | §7: first-run does one thing. |

The **"black text = yours, gray text = AI"** diff is the one interaction we
should copy outright **[verified]** — it is well-liked, and it makes the
provenance of every sentence visible. It is also non-destructive: Granola lets
you navigate back to your raw notes and regenerate.

### Hyprnote / anarlog (fastrepl)

Note the project was renamed; `fastrepl/hyprnote` now serves **anarlog**.
From its Launch HN thread **[verified]**:

- **"Inability to tell who said what is a show stopper."** A 20-participant
  test "put the entire conversation under a single speaker, in a single
  paragraph."
- Notes live in `~/Library/Application Support/com.hyprnote.stable`, "limiting
  integration with tools like iA Writer."
- A **"Finder" button that opens an in-app window instead of revealing files in
  Finder** — users expected the OS behaviour and were annoyed.
- No dark mode at launch.

It also **stores canonical data in SQLite** with Markdown as an export — the
exact inversion of our invariant.

### Meetily — the issue tracker reads like our feature spec **[verified]**

| Issue | Title | Lesson |
|---|---|---|
| [#424](https://github.com/Zackriya-Solutions/meetily/issues/424) | Folder structure for organising | "All recordings and notes are displayed in a **flat list, which becomes difficult to manage as the number of meetings grows**." |
| [#558](https://github.com/Zackriya-Solutions/meetily/issues/558) | Interactive meeting timeline | "For long meetings, finding a specific discussion requires manually scrolling through the transcript." |
| [#252](https://github.com/Zackriya-Solutions/meetily/issues/252) | Manual notes section | Wants Transcript / Notes / Summary switching. |
| [#389](https://github.com/Zackriya-Solutions/meetily/issues/389) | Notes during recording | Wants **per-line timestamps on Enter**, click a note → jump to that time. |
| [#377](https://github.com/Zackriya-Solutions/meetily/issues/377) | Inline transcript editing | Transcripts are read-only; users must copy to an external editor. |
| [#355](https://github.com/Zackriya-Solutions/meetily/issues/355), [#411](https://github.com/Zackriya-Solutions/meetily/issues/411), [#554](https://github.com/Zackriya-Solutions/meetily/issues/554) | Dark mode ×3 | **Three duplicate requests** — the loudest single UI signal in the tracker. |
| [#393](https://github.com/Zackriya-Solutions/meetily/issues/393) | Merge consecutive meetings | Interrupted-then-resumed meetings fragment into two rows. |

### Vibe — a bug class we will hit

**Four separate issues titled "UI crashes with a removeChild DOM error"**
(#1179, #1170, #889, #817) **[verified]**. **[inferred]** This is the classic
React-reconciliation-versus-direct-DOM-mutation bug, and it appears in exactly
the place we are about to write code: highlighting the active transcript line
from a `timeupdate` handler. `timeupdate` can fire up to **66 times per
second** **[reported]**, so the temptation to bypass React is strong.

> **Rule: the active-line highlight mutates a `ref`'d DOM node's `className`
> only. It never inserts or removes nodes.** Adding/removing is React's job
> exclusively.

### Otter, Superwhisper, Fireflies **[reported]**

- Otter: generic **"Speaker 1 / Speaker 2"** labels make it hard to tell who
  said what, and the error propagates into summaries and action items.
- Superwhisper: recording UI called **"intrusive"** with a "big overlay
  window"; settings described as "overwhelming".
- Fireflies: "does not possess an intuitive interface… can feel crowded".

**The through-line: speaker attribution is the #1 complaint across every
product in this category.** Our two-track split solves it by construction —
this is the strongest thing we have, and the UI should make it obvious.

---

## 2. The menu bar

`LSUIElement: true` means **no Dock icon**. When the main window is closed the
tray is the *only* evidence the app exists. It has to carry real weight.

### Icon **[verified — bjango, Marc Edwards]**

- **Working area max height 22 pt.** Circular items **16×16 pt** to match the
  visual weight of system icons.
- **Template image** — macOS ignores colour and uses only the alpha channel,
  so one asset covers light and dark menu bars. Already correct in
  [tray.ts](src/main/tray.ts).
- **Use opacity for state, not colour** — Apple typically uses **35% opacity**
  for disabled. Idle = template at reduced opacity; recording = full opacity
  plus the elapsed counter.
- Respect the **Reduce Transparency** accessibility setting.

**[verified — Apple HIG]** *"When necessary, the system hides menu bar extras
to make room for app menus."*

> **Rule: never make the tray icon the only path to anything.** On a notched
> MacBook with a few apps running it can simply not be there. Every tray action
> needs a global-shortcut or main-window equivalent.

### Click behaviour — a real disagreement, resolved

Apple does not recommend differing left/right behaviour **[reported]**, but the
popover-on-left / menu-on-right pattern is widespread. The deciding evidence is
about *feel* **[verified]**:

> NSPopover "has a slight delay, doesn't dismiss naturally, and looks like a
> **'floating app' rather than a system utility**." NSMenu gives "instant
> responsiveness and native macOS behavior… Users expect menu bar apps to
> behave like system menus — instant response, click-away dismissal."

And the canonical example of getting this wrong is Adobe Creative Cloud's menu
bar popup, which users call "awful" because **it doesn't dismiss on
click-away** **[reported]**.

**Decision: the tray uses a native `Menu`, not a `BrowserWindow` popover.**

This is the single highest-leverage performance decision in the whole UI. A
native menu is drawn by AppKit and appears in **~0 ms**. A popover window
requires a renderer to be alive, painted, and un-throttled — and Raycast, who
do this better than anyone, needed **WebKit private APIs and explicit
occlusion-detection defeat** to make it feel right **[verified]**, at a cost of
**350–450 MB resident** (an empty WebView alone is ~50 MB). For a background
audio recorder that competes with the ASR worker for memory, that is a bad
trade for a menu with five items.

```
┌────────────────────────────┐
│ ● Start recording    ⌃⇧R   │   ← toggles; shows "Stop recording ⏱ 12:04"
├────────────────────────────┤
│ Recent                     │
│   Standup          10:30 ▸ │   ← last 5. Click → open window at that session
│   1:1 with Sam      9:15 ▸ │
├────────────────────────────┤
│ Open Oratio          ⌘O    │
│ Settings…            ⌘,    │
├────────────────────────────┤
│ Quit Oratio          ⌘Q    │
└────────────────────────────┘
```

~~Two gaps in the current implementation this closes: [tray.ts](src/main/tray.ts)
has **no Settings item at all**, and `toggle()` at
[tray.ts:56-60](src/main/tray.ts#L56-L60) is a stub that only re-renders.~~

**[closed in phase 7]** Both are done: the menu now carries Settings (⌘,) and
`toggle()` drives the real controller. A third gap this section did not
anticipate turned out to be the serious one — **the icon asset did not exist
at all.** `resources/` was empty, and `nativeImage.createFromPath` returns an
empty image rather than throwing, so the menu-bar item was invisible. For an
`LSUIElement` app that is not a cosmetic bug: with no Dock icon and no window,
it left the app with no visible surface whatsoever.

**[reported]** Also call `tray.setIgnoreDoubleClickEvents(true)` — without it,
a fast double-click can swallow click events entirely.

### The recording indicator is not optional

While recording, the tray shows a live elapsed counter (already implemented).
**[inferred]** This is a trust feature, not a convenience one: a meeting
recorder that hides what it is doing is precisely the design that got other
products into trouble. It is also the only always-visible surface, since there
is no Dock icon.

**One correction needed.** [tray.ts:73](src/main/tray.ts#L73) drives the
counter from `setInterval` and derives elapsed from `Date.now()`. ARCHITECTURE.md
§3 forbids this: on OS suspend the event loop freezes and missed ticks never
fire. `Date.now()` deltas survive suspend, so the *display* is correct today —
but the interval stops firing while asleep, so the counter freezes on screen.
The tray should re-render on `powerMonitor` `resume`, and the authoritative
duration must come from sample count.

**[done — phase 4 for the redraw, phase 7 for the rest]** The tray re-renders
on `powerMonitor` `resume`, elapsed stays a `Date.now()` delta rather than an
accumulated tick count, and the interval is `unref`'d so it cannot hold the
process awake between ticks. The authoritative duration is still the sample
count in `meta.json`; the menu-bar counter is explicitly the approximate one.

The same bug exists more seriously in the renderer:
[RecordButton.tsx:12-16](src/renderer/src/components/RecordButton.tsx#L12-L16)
accumulates `setElapsed((e) => e + 1)` — a pure tick counter, which **loses
time on every dropped tick and every window throttle**. Since the renderer is
hidden most of the time, it is background-throttled and this will drift
noticeably. It must read elapsed time from `RecordingState` over IPC instead.

---

## 3. The recording surface

**[verified]** Superwhisper's "big overlay window" is called *intrusive*.
Granola shows a small draggable floating pill. **[inferred]** We do neither by
default: the tray counter is enough, and the main window shows full state when
open. An optional floating pill is a settings toggle, off by default.

### Level meters — the 60 fps path

Two meters (mic, system) update continuously while recording. This is the only
truly continuous animation in the app, so it gets the strict budget.

**Never send audio buffers to the renderer for metering.** At 16 kHz mono
Float32, that is 64 KB/s per track; per §0 a 1 MB payload costs ~70 ms. We send
**two floats at ~30 Hz**, which is nothing. `RecordingState.micLevel` and
`.systemLevel` already exist in [types.ts](src/shared/types.ts) for exactly
this.

**Render with `transform: scaleY()` on a composited layer, never `height`.**
**[reported]** `transform` and `opacity` are the compositor-only properties —
they skip layout and paint entirely and run on the GPU. Animating `height`
triggers layout on every frame.

**Decouple the audio rate from the render rate.** Audio callbacks arrive far
faster than the display refreshes. The IPC handler writes the latest value to a
mutable ref; a single `requestAnimationFrame` loop reads that ref and writes the
transform. **[inferred]** No `setState` per audio frame — that would put React
reconciliation on a 60 Hz path for a value that isn't semantic state.

**Ballistics.** A meter that maps amplitude directly to height looks twitchy
and unreadable. Use a one-pole envelope follower with asymmetric time
constants — fast attack so peaks register, slow release so the eye can track:

```
coeff = exp(-1 / (timeConstantSeconds * updateRateHz))
env   = level > env ? attack·env + (1-attack)·level
                    : release·env + (1-release)·level
```

**[inferred]** Start at attack ≈ 10 ms, release ≈ 300 ms — the VU rise-time
convention — and tune by eye. Display on a **dB scale** (`20·log10(x)`), not
linear amplitude: speech occupies a small part of the linear range and a linear
meter barely moves.

**The dead-mic case is a product requirement, not a nicety.** ARCHITECTURE.md
§3 and the `LIVENESS_CHECK_MS` constant exist because voice processing can
deliver digital silence. If a track reads exactly zero for several seconds, the
meter must say so in words — *"No audio from microphone"* — not just sit at
zero. A user who discovers this after a two-hour meeting has lost the meeting.

---

## 3a. The chosen layout: J, the drawer

**Decided.** Of the eight explored (see the design proposals), v1 is **J — The
Drawer**: notes take the full width of the window, and the transcript lives in
a drawer that pulls up from the bottom, collapsed to a single handle by
default.

```
┌──────────┬──────────────────────────────────────────┐
│ sessions │  Standup            [Summarise ⌘E]       │
│          │  8 Aug · 24 min · 18 turns               │
│  Today   │                                          │
│  ▸ …     │  — ship blocker is the model download    │
│          │    <AI expands here, grey>               │
│          │  — Ana — waveform cache?                 │
│          │    <AI expands here, grey>               │
│          ├──────────────────────────────────────────┤
│          │ ▬▬  Transcript · 18 turns            ⌘T  │  ← handle
└──────────┴──────────────────────────────────────────┘
```

### Why this one

- **It is a superset of A.** Closed, it *is* the notebook — the widest writing
  column of the six and the calmest page. Opening the drawer is additive, so
  we never pay for the transcript when we are not reading it.
- **Full-width turns.** The transcript reads as paragraphs rather than a
  270 px column. At 18 turns that is a nicety; at 400 it is the difference
  between readable and not — and it is the layout that best matches the W3C
  guidance in §4 (paragraphs, not caption lines).
- **Nothing on the critical path is unproven.** D's citation chips depend on
  the model reliably emitting turn IDs, which is open question #8 and
  currently untested. J needs no such guarantee. Citations can be added to J
  later — the drawer is where a cited turn would be revealed — so choosing J
  does not foreclose D.
- **One bit of state.** Open or closed, remembered per session. Compare K's
  bidirectional hover or L's dependence on correct topic segmentation.

### What we accept by choosing it

The known cost, stated in the proposal: **you cannot see notes and transcript
at full size simultaneously.** Opening the drawer takes roughly half the notes
area. This is the right trade for a notes-first app — but it means verifying
an AI claim is a *two-step* action (open, find) rather than D's one click.

Mitigation, and the reason it stays acceptable: the drawer opens **scrolled to
the relevant turn** wherever we have one — from a search hit, from a
click-to-play, and later from a citation. The drawer is not a dumb toggle; it
is a targeted reveal.

### Behaviour to get right

- **Three states, not two:** closed (handle only), half (default open), and
  full. Drag the handle to resize; double-click to cycle.
- `⌘T` toggles. The handle is always visible so the transcript is never
  hidden, which is what Granola got wrong (§1).
- **Persist per session**, so a meeting you were reading reopens as you left
  it.
- The handle shows turn count while closed, and the active timestamp while
  playing — so it carries information even collapsed.
- Opening must not steal focus from the notes editor mid-sentence.

---

## 4. The transcript

The hardest performance problem in the app. A 2-hour meeting is on the order of
**several thousand segments**.

### Render speaker turns, not ASR segments **[verified — W3C]**

W3C's transcript guidance is explicit: use **logical paragraphs**, not
caption-style line-by-line, and *"include timestamps only when useful"*. Their
worked example consolidates six caption lines into two paragraphs.

**[verified]** The transcript-UI convention is that *"the fastest useful
default is a turn-start timestamp immediately before the speaker label"* — one
seek point per handoff.

This is both a readability win and a performance win: merging adjacent
same-speaker segments into turns typically cuts the rendered row count by a
large factor before any virtualization is involved. **[inferred]** This
restructuring should happen once, memoised, not per render.

The current [TranscriptView.tsx](src/renderer/src/components/TranscriptView.tsx)
renders one row per segment with a timestamp on every row. It needs to group
into turns.

### Chat bubbles are the wrong choice at length

Granola uses grey bubbles left (them) / green bubbles right (me) **[verified]**.
Tempting, and it maps perfectly onto our two tracks. But the same review noted
the transcript reads like *"a one-sided WhatsApp"* **[verified]**, and
**[inferred]** bubbles halve horizontal text density — over two hours that is a
lot of scrolling for no information gain.

**Decision: speaker-labelled paragraphs with hanging indents and a colour
accent per track.** Bubbles are acceptable for a *live* view, where there are
few lines and the chat metaphor helps. Paragraphs for review.

### Virtualization

Even at turn granularity a long meeting exceeds what should be in the DOM.
Rows are **variable height** (text wraps unpredictably), which is the hard case.

**[inferred]** The plan, in order of preference:

1. **Try `content-visibility: auto` + `contain-intrinsic-size` first.** It is
   pure CSS, the browser skips rendering off-screen subtrees, and — critically
   — **it does not break ⌘F, text selection, or scroll anchoring**, which every
   JS virtualization library does to some degree. For a list of a few thousand
   rows this may be sufficient on its own.
2. **If not, TanStack Virtual** with dynamic measurement.

**[verified — measured in phase 6]** Option 1 was sufficient and option 2 was
not needed. A 4 000-segment transcript merges to 1 334 turns, every one of them
in the DOM, and 40 forced scroll-and-layout passes over the whole list complete
in **1 ms**. Merging to turns does most of the work before the rendering
strategy matters at all. ⌘F, select-all and scroll anchoring therefore all
still work, which is the outcome this ordering existed to protect.

Two things must survive whatever we choose, because they are the features that
beat Granola: **selecting and copying across the whole transcript**, and
**⌘F finding text that is scrolled out of view**. A virtualization approach that
breaks either is not acceptable — Granola's missing scrollbar and missing
search are two of our four headline advantages, and shipping a transcript we
can't ⌘F would forfeit one of them.

### Click-to-play

Already built and already the differentiator: **click any line, hear that
moment**. Structurally impossible for Granola, which keeps no audio
**[verified]**.

Two audio elements, one per track, because the tracks are never mixed — this
is already correct in `TranscriptView`.

**[verified]** `timeupdate` fires up to 66 times/second. The active-line
highlight therefore:
- mutates `className` on a `ref`'d node — never inserts or removes DOM nodes
  (the Vibe crash class, §1);
- computes the active turn by **binary search** over turn start times, not a
  linear scan;
- scrolls into view only when the active turn *changes*, and never while the
  user is actively scrolling.

### The timeline rail

**[verified]** Meetily #558 asks for exactly this, and Granola's missing
scrollbar is a named complaint.

A thin vertical rail beside the transcript, representing the whole meeting:
- two-colour, showing who was speaking when (free from our two tracks);
- current playback position;
- search-hit markers;
- click to seek.

**[inferred]** This is the answer to "find the bit where we discussed pricing"
in a 2-hour recording, and it is nearly free because speaker-over-time is
already in the transcript data.

### Waveform rendering

**[inferred]** Where a waveform is drawn, use the standard **min/max peak
bucketing** algorithm: for N pixels of width, bucket the samples into N
buckets, keep min and max per bucket, draw a vertical line between them. Never
read every sample per frame; compute the buckets once and cache.

At 16 kHz, a 2-hour recording is ~115 M samples — far too many to touch on a
render. At 1000 buckets that is a ~4 KB summary. Compute it in the main
process when the recording finalises, cache it beside the WAV.

---

## 5. The library

**[verified]** Meetily #424: *"all recordings and notes are displayed in a flat
list, which becomes difficult to manage as the number of meetings grows."*

The current [SessionList](src/renderer/src/components/SessionList.tsx) is a flat
`map` over every session. It needs:

- **Date grouping** — Today / Yesterday / This week / month headings. Cheap,
  and it makes a long list navigable without any folder feature.
- **Virtualization**, same reasoning as the transcript.
- **Status visible per row.** `pending` / `transcribing` already exists in
  `SessionStatus`; a session mid-transcription must say so.
- **Search field at the top**, feeding §6.

**[inferred]** Explicit folders (Meetily #424, Granola's Spaces) are deferred.
Date grouping plus good search covers most of the need, and folders imply
move/rename UI, drag-and-drop, and an "unfiled" concept — a lot of surface for
v1. Revisit when a real vault gets large.

**Merging sessions** (Meetily #393) is also deferred, but noted: an interrupted
meeting fragmenting into two rows is a real and predictable annoyance.

---

## 6. Search

Granola has none within a transcript **[verified]**. This is cheap for us and
visibly better.

**Two distinct features, deliberately not merged:**

1. **⌘F — find in this transcript.** Renderer-side, over already-loaded turns.
   Must feel like the browser's find bar: instant, hit count, next/previous,
   markers on the timeline rail.
2. **⌘K — find across all meetings.** Goes to SQLite FTS5 in the index worker.

For ⌘K, the index worker returns **session IDs and short snippets only** — per
§0, returning whole transcripts over IPC would be the expensive mistake.

**[inferred]** Search-as-you-type must not block typing. React 19's
`useDeferredValue` on the query is the right tool: the input updates at full
priority, the results list re-renders at low priority and is interruptible. A
fixed debounce makes fast typists wait; deferring makes the *input* always win,
which is what actually matters. **[reported]** Keystroke latency is one of the
most perceptible latencies there is, so the input must never be the thing that
waits.

---

## 6a. The summary: one call, five sections

Answering "is the summary of the whole transcript or parts?" — **one call over
the whole transcript, output split into sections.**

### Why one call **[reported]**

The model must see the entire meeting to connect a question at 08:00 to its
answer at 44:00. Chunking severs exactly those links. The two open-source
comparables both ship single-pass: Vibe stuffs the whole transcript into one
call and its chunking issue
([#999](https://github.com/thewh1teagle/vibe/issues/999)) is **open and
unimplemented**; Meetily does map-reduce at a 40 000-token chunk size, which
only engages on very long inputs.

Chunking becomes necessary at roughly **one hour of speech for a local model**
(16k context), and much later for cloud models. Deferred until measured — see
§11.

**[reported]** But context size is not the whole story: long-context models
show a U-shaped attention curve, with accuracy on material in the *middle* of
a long input dropping 20–30 points ("Lost in the Middle", TACL 2024). Hence
`buildUserPrompt` puts instructions first and the transcript **last**, so
nothing load-bearing sits in the trough.

### The section set

`Summary · Decisions · Action items · Discussion · Open questions`

Chosen to match where the industry converged rather than inventing our own
**[verified]**: Google Meet emits Summary / Decisions / Next steps / Details;
Grain's default is summary + key talking points + action items; Granola's
"Meeting recap" template is Context / Discussion summary / Key decisions /
Action items / Open questions.

**Open questions earns its place structurally** — an unresolved thread
recorded as a question cannot become a fabricated decision.

### Sectioned output from a single stream

The model emits `§§ <Section>` on its own line before each section.
`createSectionParser()` demultiplexes the token stream into sections as it
arrives, so A's per-note layout and L's per-topic outline both work without a
second call.

Line-buffered, because a marker splits across tokens — `"§§ Act"` + `"ion
items\n"` is an ordinary delta pair. **Verified** against a stream chopped
into 4-character tokens. Text before any marker falls back to `Summary`, so a
model that ignores the format still renders something.

`§§` is deliberately not Markdown: it cannot occur in speech-derived text,
whereas a `##` heading inside a discussion point would corrupt the parse.

### What the prompt is tuned against **[reported]**

The measured error distribution for LLM meeting summaries
([arXiv:2404.11124](https://arxiv.org/html/2404.11124v2), 8 error types,
Krippendorff α = 0.81) inverts the intuitive priority:

| Error | GPT-3.5 | Zephyr-7B |
|---|---|---|
| **Missing information** | **97%** | **97%** |
| Structural disorganisation | 63% | 63% |
| Hallucination | 14% | 23% |
| Wrong references (misattribution) | 9% | 9% |

**Under-summarising is the dominant failure by a wide margin** — roughly seven
times more common than hallucination. The old prompt's "prefer short sections
and bullets" pushed toward exactly that, so the new one makes completeness the
stated priority and Discussion the longest section.

Two consequences specific to us:

- **The 9% misattribution class is structurally eliminated.** Our two tracks
  make speaker labels ground truth, so the prompt states they are authoritative
  and forbids reassignment. Every mixed-audio competitor eats this error.
- **`Unassigned` is a first-class owner.** Forcing an owner onto an ownerless
  commitment is what manufactures wrong references; Otter ships an explicit
  `UNASSIGNED` state for the same reason **[reported]**.

Also in the prompt: an instruction to ignore directives appearing *inside* the
transcript. Participants are speaking to each other, not to the model — and a
transcript is untrusted input. Meetily's prompt carries the same defence
**[verified]**.

### Inference parameters — one real bug fixed

`temperature: 0.2` on all three providers (extraction, not composition), and
`max_tokens: 8192` so a thorough Discussion section isn't truncated.

**The Ollama default was silently wrong.** Ollama defaults `num_ctx` to 2048
and truncates longer input **from the front**, with no error anywhere. A
25-minute meeting already exceeds that, so the summary would describe only the
tail of the conversation while reporting success. Now set to 32 768 — about
two hours of speech.

**[verified in phase 8]** The request body is asserted against a fake Ollama
that records what we send: `num_ctx` 32 768, `temperature` 0.2, and the
transcript positioned *after* the instructions. That proves what leaves this
app, not what the server does with it — no Ollama is installed on the dev
machine, so whether a real server honours the setting is open question #7.

### Where the summary lives **[settled in phase 8]**

In `notes.md`, in the same file as the user's notes — one meeting, one record,
and it syncs and greps with everything else for free. But that only works if
the two halves are separable again on read, because the notes editor autosaves
into that file 600 ms after every keystroke. Written naively, generating a
summary and then typing one character silently erases it.

So `notes.md` parses into `{ userNotes, summary }` and re-renders from those
two fields. The boundary is an explicit `<!-- oratio:summary -->` marker —
invisible in every Markdown renderer, and unambiguous in a way a `---` rule or
a heading would not be. This is what makes "Reset to my notes" non-destructive
*by construction* rather than by care: clearing one field cannot reach the
other even if the calling code is wrong.

**A partial summary is kept.** Cancelling mid-stream persists what arrived
rather than discarding it — the user watched that text appear, and one click
removes it if they don't want it.

---

## 7. Settings

**[reported]** Superwhisper's settings are described as "overwhelming". Ours
should be small enough to fit on one screen, opened via **⌘,** from the tray or
the main window.

| Group | Contents |
|---|---|
| **Vault** | Folder path, "Reveal in Finder" — which must **actually open Finder** (the anarlog complaint **[verified]**). |
| **Model** | The four models from [models.ts](src/shared/models.ts), with real sizes shown. Download / delete / progress. |
| **Recording** | Launch at login, VAD toggle, optional floating pill. |
| **AI** | Provider, model, API key. Must state plainly that **transcription never leaves the machine** and only summarisation uses a provider. |
| **Permissions** | Mic status, system-audio status. `systemAudio` is inferred, not queried (ARCHITECTURE.md §3), so word it honestly — "appears to be working", not a false green tick. **[built in phase 9]** and dated: the panel says *when* it saw capture work, because "appears to be working" is only honest if the reader can tell it describes a past recording rather than a live check. A denied state links to the right System Settings pane. |

**[verified]** First-run confusion is a named Granola complaint. **[inferred]**
First run does exactly one thing: pick a vault folder, download the default
model with visible progress, then show the record button. Model download is the
first thing a new user experiences and per ARCHITECTURE.md §4.4 the most likely
thing to fail — it needs real progress, real errors, and a retry.

### Where setup actually landed **[built in phase 9]**

The vault question moved *out* of the gate. It cannot be missing — there is
always a default under `~/Documents` — so it is a question, not a blocker, and
making it a step would have turned a one-click setup into two decisions. It sits
below the download as a path with a "Change" link.

So the gate is the model alone, and it is derived from the filesystem on every
check rather than stored as an "onboarded" flag. A flag lies precisely when it
matters: someone who deletes their only model has completed onboarding and
still cannot record.

The setup screen **replaces** the app rather than overlaying it. An overlay
would leave a working record button underneath, which is the failure this
screen exists to prevent — and the same refusal is enforced in
`RecordingController.start()`, because the tray can start a meeting with no
window open at all. The message names the fix ("Open Settings to download one")
and says it happens once.

Past 90% the progress label changes from "downloading" to "verifying and
unpacking". `ModelManager` reserves that last tenth for the checksum and bzip2
extraction, which report no byte progress and take several seconds — so the bar
stops moving exactly where the old label claimed it was still downloading.

---

## 8. Dark mode is a v1 requirement

**[verified]** Three duplicate Meetily issues (#355, #411, #554), an anarlog HN
request, and *"the gray on gray makes me think I'm on Windows 95"* for Granola.

The window already sets `vibrancy: 'sidebar'` and `darkModeSupport: true`.
**[inferred]** Both themes must be designed, not derived — a dark theme made by
inverting a light one looks like exactly what it is. Follow the system by
default with a manual override.

---

## 9. Window opening

**[inferred, and explicitly unmeasured]** The window is created on demand in
[index.ts](src/main/index.ts) — `createWindow()` runs on first
`showMainWindow()`, so the first open pays the full cost of process setup,
React boot, and first paint. Every subsequent open is instant because the
window is only hidden, never closed.

The obvious fix is pre-warming a hidden window at startup. The obvious cost is
that a hidden WebView is **~50 MB resident** **[verified, Raycast's
measurement]**, permanently, on a background app that also runs ASR.

**[verified]** Nobody has published a clean macOS `BrowserWindow` show-latency
number, so this cannot be decided from the literature — it has to be measured
in our app. Ship create-on-demand, measure first-open time, and pre-warm only
if it is above the 1 s threshold.

**[verified]** Two things that are worth doing regardless, because they cost
nothing: keep `show: false` + `ready-to-show` (already correct), and note that
Electron's own guidance is that **bundling** captures most of the startup win
that V8 snapshots would (VS Code measured ~400 ms from bundling alone), without
snapshots' severe constraints.

**[verified]** One free perceived-latency win from VS Code: **acting on
`mousedown` instead of `mouseup` saves ~50 ms** on any control where the action
isn't cancellable. Applies to session selection and tab switching.

---

## 10. Decisions, in one page

| Decision | Why |
|---|---|
| **Layout J — the drawer** | Superset of the plain notebook; full-width transcript; no dependency on unproven citation behaviour |
| Native `Menu` in the tray, not a popover window | NSMenu feel is instant and dismisses correctly; a popover needs a live renderer and ~50 MB, and Raycast needed private APIs to make it feel right |
| Tray never the only path to an action | macOS hides menu bar extras when crowded (HIG) |
| Template icon, opacity for state | bjango: 22 pt max, 16×16 pt circular, alpha-only |
| Elapsed time from sample count, never tick accumulation | Renderer is throttled; `setInterval` drops ticks across suspend |
| Levels over IPC as two floats at ~30 Hz | 1 MB IPC payload ≈ 70 ms; buffers must never cross |
| Meters via `transform: scaleY()` in one rAF loop | Compositor-only property; no layout, no React on a 60 Hz path |
| Envelope follower with fast attack / slow release, dB scale | Raw amplitude is unreadable and twitchy |
| Merge segments into speaker turns, one timestamp per turn | W3C guidance; cuts row count and improves readability at once |
| Paragraphs with hanging indents, not chat bubbles | Bubbles halve density; "one-sided WhatsApp" was a real complaint |
| `content-visibility` before JS virtualization | Preserves ⌘F, selection, and scroll anchoring — which are our advantages |
| Active-line highlight mutates `className` only | Vibe shipped four `removeChild` crashes from exactly this |
| Binary search for the active turn | `timeupdate` fires up to 66×/s |
| Timeline rail showing speaker-over-time | Meetily #558; free from two-track data; fixes Granola's missing scrollbar |
| ⌘F in transcript and ⌘K across meetings, kept separate | Granola has neither; different latency budgets and data paths |
| `useDeferredValue` for search, not debounce | The input must never be the thing that waits |
| Search returns IDs + snippets, never transcripts | §0 payload rule |
| Date grouping now, folders deferred | Meetily #424 is real, but folders imply a lot of v1 surface |
| Dark mode designed, not inverted | Three duplicate Meetily issues; Granola's "Windows 95" palette |
| Create window on demand, measure before pre-warming | Pre-warm costs ~50 MB permanently; no published latency number exists |
| Act on `mousedown` where uncancellable | VS Code measured ~50 ms |

---

## 11. Open questions

| # | Question | Risk if wrong |
|---|---|---|
| ~~1~~ | ~~Is `content-visibility: auto` enough for a 2-hour transcript, or is TanStack Virtual required?~~ **Settled in phase 6: `content-visibility` alone is enough.** 4 000 segments merge to 1 334 turns, all in the DOM; 40 forced scroll-and-layout passes over the full list take 1 ms. TanStack Virtual is not needed, so ⌘F, select-all and scroll anchoring all survive | ~~Determines whether ⌘F and select-all keep working~~ |
| 2 | First main-window open latency on an M-series Mac | Decides pre-warm vs on-demand; ~50 MB permanent cost |
| 3 | Do we render a full waveform, or only the timeline rail? | Waveform needs a cached peak summary per session |
| 4 | Live transcript view during recording — only for streaming models (Moonshine) | Non-streaming models show nothing until stop; the UI must not look broken |
| 5 | Does the hidden renderer's background throttling delay level-meter IPC? | Meters only matter when the window is visible, so probably moot — verify |
| 6 | Editable transcripts (Meetily #377)? | Conflicts with "transcript.json is machine output"; would need provenance |
| 7 | At what duration does single-pass summarisation degrade? | ~1h claimed for 16k local models; unmeasured for ours. Determines when chunking is needed |
| 8 | Can the model reliably emit turn IDs for citation chips? | Not on the v1 path now that J is chosen; prerequisite if we later add citations to the drawer |
| 9 | Do templates (Grain/Granola-style, section = a prompt) belong in v1? | Industry standard is user-editable sections; ours is currently fixed |
