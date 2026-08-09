# Privacy and control — research, and the phases that came out of it

Research completed 9 Aug 2026, against the phase 12 codebase. Prompted by three
requests raised together, which look like one theme ("don't capture or expose
what I didn't mean to share") but decompose into problems of very different
difficulty. §5 turns the decisions into phases P1–P5.

| Ask | Verdict | Decision |
|---|---|---|
| **Mute** — stop recording when I mute in Teams | Reading another app's mute state is **impossible** on macOS (§1, measured). | **Built Oratio's own mute** — P2 ✅ |
| **Delete** — remove a recording from inside the app | Storage was already built; the UI and two main-process guards were not. | **Built** — P1 ✅ |
| **Encryption** — stop someone reading the vault | ~80% already handled by the OS; the rest is a screen-lock problem (§3). | **Not building.** Logseq shipped this and removed it |

Two further decisions taken at the same time, both recorded in §4 because
neither is a privacy *research* question but both change the product's defaults:

| Change | Why it is not trivial |
|---|---|
| **Editing a transcript after the meeting** | `transcript.json` is machine output; editing it needs a provenance design, not a text box — §4.1 |
| **Stop keeping audio by default** | Becomes a Fireflies-style retention *mode* rather than a boolean; reverses a documented differentiator and removes the evidence edits are checked against — §4.2 |

**Sources are cited inline, and measurements were taken on this machine**
(macOS 26.5.1, Darwin 25.5.0) rather than assumed. Where a plausible approach
was disproved, the disproof is recorded next to it — a bare "doesn't work"
invites the next reader to try it again.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the two-track topology and
[UI.md](UI.md) for the layout these features land in.

---

## 1. Mute — what is actually knowable

### 1.1 The problem

You are in a Teams call. You mute yourself *in Teams*. Nobody in the meeting
hears you, so you say something to the room. Oratio is still recording your
microphone, so it lands in `mic.wav` and then in the transcript attributed to
you — a private remark, permanently, in a file you will share.

The failure is quiet and one-directional: nothing looks wrong until you read
the transcript.

### 1.2 What was tested, and what it proved

Four approaches, tested rather than reasoned about. Three are **verified
impossible**, not merely undocumented.

**(a) `AVAudioApplication.isInputMuted` (macOS 14+) — per-process, cannot see
other apps.**

This is the most promising-looking API and the one worth documenting most
carefully, because the header wording reads as though it were global.

Compiled and ran a two-process test: one process registers the required
handler and mutes itself, another process observes.

```
[setter]   handler registered=1
[setter]   HANDLER fired muted=1
[setter]   setInputMuted:YES returned=1
[setter]   t=0..6 isInputMuted=1      <- mute works in the calling process
[observer] t=0..6 isInputMuted=0      <- and is INVISIBLE to any other process
```

Muting is real and durable in the process that called it, and the observer
never sees it. The state is strictly per-process.

A related trap worth recording: calling `setInputMuted:` *before* registering a
handler fails with an error whose text names the fix, which is easy to mistake
for the API being unavailable —

```
NSOSStatusErrorDomain Code=-50 "paramErr"
  "Error - input mute handler not set, please call
   `setInputMuteStateChangeHandler` first"
```

What this API is actually for, per
[WWDC23 session 10233](https://developer.apple.com/videos/play/wwdc2023/10233/):
*"on macOS, your application is responsible for muting any uplink audio when a
gesture has been performed."* It is a **notification sink for the AirPods
press-to-mute gesture**, not a system mute bus. Zoom adopted it
([devforum](https://devforum.zoom.us/t/support-for-macos-14-airpods-mute-api/98345)),
but only to *listen* for that gesture.

Note also that macOS has **no Control Center global mic-mute toggle** — that is
an iOS feature. macOS has only FaceTime-style Mic Modes.

**(b) Core Audio process objects — expose no mute property at all.**

The existing probe (`native/audio-processes.c`) already enumerates process
objects. Asking each of the 26 live objects which properties it answers:

```
IsRunning         supported on 26/26      Name                   0/26
IsRunningInput    supported on 26/26      DevicePropertyMute     0/26
IsRunningOutput   supported on 26/26      VolumeScalar           0/26
Devices           supported on 26/26
BundleID          supported on 26/26
-- input scope --  Mute 0/26   VolumeScalar 0/26
```

Zero mute support, in both global and input scope. Separately verified that
`kAudioHardwarePropertyProcessInputMute` returns `'who?'`
(`kAudioHardwareUnknownPropertyError`) for any *foreign* process object and
works only on `kAudioObjectSystemObject`, where it means the **calling**
process. Per-process mute is write-only-for-yourself, never readable.

**(c) Device mute — exists, but conferencing apps do not touch it.**

```
6imeon Microphone         hasMute=0 settable=0
EarPods Microphone        hasMute=1 settable=1 muted=no
MacBook Pro Microphone    hasMute=1 settable=1 muted=no
```

Real and settable on real hardware, but it is a **device-wide** control. Zoom,
Teams and Slack mute in software inside their own process and never set it.
The corroborating symptom is well documented: headset hardware mute buttons do
not sync with Teams
([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/4412851/mute-doesnt-work-with-teams-desktop-for-macos-and)),
which is exactly what you would expect if device mute were disconnected from
app mute.

`kAudioHardwareServiceDeviceProperty_VirtualMainVolume` is a dead end twice
over — it is a `Float32` *volume*, not mute, and the whole
`AudioHardwareService` family is `API_DEPRECATED("no longer supported",
macos(10.5, 10.11))`.

**(d) Accessibility API — works, and is what the industry actually uses.**

MuteDeck [documents it plainly](https://mutedeck.com/help/api/): scan the UI
for a "Mute" vs "Unmute" button. Zoom tools poll AppleScript menu items
([zoom-mute-status](https://github.com/abersager/zoom-mute-status), whose author
calls per-second polling "less than ideal").

The brittleness is not hypothetical. In February 2024 Microsoft
[replaced Teams' "Mic Muted"/"Mic Unmuted" accessibility identifiers with a
single ambiguous "Mic"](https://muteme.com/blogs/news/microsofts-recent-teams-update-compromises-accessibility-features),
breaking MuteMe and screen readers simultaneously. Slack huddles are worse — no
third-party tool appears to read huddle mute state at all.

Cost: the **Accessibility** TCC permission, which grants full UI control of
every app on the machine. For a product whose pitch is local-first privacy,
requesting the most invasive permission on macOS *in order to record less* is a
hard sell, and it re-introduces exactly the class of permission that choosing
AudioTee over `desktopCapturer` avoided.

### 1.3 What competitors do

- **Fathom** does it. Their docs list a Privacy setting, *"Automatically Detect
  Mute — Detects when you're muted to improve capture experience"*
  ([help docs](https://help.fathom.video/en/articles/449088)). Method
  undisclosed; given the above, AX scraping is the only plausible mechanism.
- **Granola** does not. Its docs describe auto-stopping on call end, never on
  mute.
- **Krisp** knows its own mute state only because it *is* the virtual
  microphone in the chain — architecturally unavailable to us, and it still
  cannot sync headset hardware mute.
- Otter/Fireflies are bot-based; the question does not arise.

**The near-universal absence is itself the finding: this is unsolved
industry-wide because it is not cleanly solvable.**

### 1.4 The one open empirical question

Everything above rules out *reading* a mute flag. One signal remains, and it is
free:

> **Does a conferencing app release the mic stream when you mute?**

If Teams sets `IsRunningInput = 0` on mute, that is an exact, permission-free
mute signal — and Oratio already ships the machinery to read it
(`native/audio-processes.c`, polled by `meetingDetector.ts`, no TCC prompt).
Adding one property to `read_flag()` would be a one-line change.

This cannot be answered without a real call. A harness is built and verified
working — it logs only transitions, for both device mute and per-process mic
state:

```sh
# Any output at all means the mute action IS observable.
clang -framework CoreAudio -framework CoreFoundation \
  -o /tmp/mute-observe native/research/mute-observe.c && /tmp/mute-observe
```

Kept at [native/research/mute-observe.c](../native/research/mute-observe.c)
rather than left in a scratch directory, because the measurement it makes is
the one thing that decides this section and it should not have to be rebuilt
from scratch.

Verified it detects genuine mic open/release transitions. **Untested against a
real Teams/Zoom/Slack mute**, which is the measurement that decides this
section.

My expectation, stated in advance so the measurement can contradict it: apps
**keep the stream open** while muted, because tearing down and re-acquiring a
Core Audio input adds latency to unmuting and risks losing the device. If that
is right, this signal does not exist either and only the heuristic below
remains.

### 1.5 If no exact signal exists — mark, do not drop

Silence detection alone is not a mute detector: muted-and-quiet is
indistinguishable from unmuted-and-listening. Someone quiet for two minutes
while the far end talks is the *normal* case, and suppressing it would delete
real speech.

Two design rules matter more than the detection method:

1. **Mark, never delete.** Plain files are the source of truth and the mic
   track is "me". Dropping audio on a heuristic is unrecoverable. Flagging
   regions in `meta.json` keeps the files authoritative and lets the heuristic
   be tuned later without re-recording. Every available signal here is
   probabilistic, which settles the argument.
2. **Reuse the existing VAD.** It already runs pre-ASR (an invariant), so
   region-level silence data is free. No new audio path.

A muted stretch is structurally the same thing as the discontinuity
`noteSuspend()` already records in `AudioCapture` — a hole in the mic track —
which is the natural place to hang this.

Failure modes to expect regardless of method: push-to-talk users toggle far
faster than any sustained-silence window; headset hardware mute produces true
digital silence while unmuted in-app; and a genuinely quiet participant looks
identical to a muted one. All three argue for marking over pausing.

### 1.6 Recommendation

**Do not build mute detection yet.** Run the harness in a real call first. The
outcome selects the design:

- **Apps release the mic on mute** → build it. Exact, free, no new permission,
  one line in the probe.
- **They do not** (expected) → the only exact method is Accessibility, which
  costs more than the bug. Ship the *marking* heuristic at most, and be honest
  in the UI that it is a guess.

**Decided: build Oratio's own mute button instead** (P2). It does not know what
Teams is doing, but it makes the failure recoverable by intent rather than
inference, works in every app including ones nobody has heard of, needs no
permission and no detection, and cannot break when Microsoft renames a UI
element. Detection remains open only as the measurement in §1.4 — and even a
positive result there would *supplement* the button, not replace it.

---

## 2. Delete — already built, never wired up

The smallest of the three by a wide margin. **The entire delete path exists and
is correct**; nothing in the renderer ever calls it.

| Layer | State |
|---|---|
| `deleteSession()` — [vault.ts:146](../src/main/storage/vault.ts#L146) | Done. `rm(dir, {recursive, force})`, safe to call twice |
| IPC handler — [ipc/index.ts:163](../src/main/ipc/index.ts#L163) | Done. Also unindexes, best-effort, and correctly refuses to fail the delete if unindexing fails |
| Preload bridge — [preload/index.ts:61](../src/preload/index.ts#L61) | Done. `sessions.remove(id)` |
| **UI** | **Missing entirely** |

So this is a UI-only task. What it needs:

- A control in the session list row (context menu, or hover affordance) and/or
  in the meeting view's overflow menu.
- **A confirmation step.** This deletes audio, transcript and notes
  irreversibly. Note the existing precedent cuts the other way — model delete
  has no confirmation — but a model is re-downloadable and a meeting is not.
- Selection must move somewhere sane afterwards; deleting the selected session
  currently has no defined behaviour because it has never happened.
- Honest wording. `deleteSession` is an ordinary `rm`, so
  **the bytes may remain recoverable on the underlying SSD** — the same caveat
  already documented on `discardSessionAudio`, which deliberately refuses to
  promise secure erase because wear levelling puts the physical blocks out of
  reach. Say "deleted", never "securely erased".

There is a related existing feature worth surfacing at the same time: audio can
already be discarded while keeping the transcript (`discardSessionAudio`), which
is what most people actually want when they say "delete the recording."

---

## 3. Encryption — mostly already solved, by the OS

### 3.1 The threat model, made precise

"Someone else uses this Mac" is three different attackers, and they are **not
equally served** by app-level encryption. Measured on this machine:

| # | Attacker | Already mitigated? | By what |
|---|---|---|---|
| (a) | A different macOS account | **Mostly yes** | POSIX. `~` is `drwxr-x---`, `~/Documents` is `drwx------`. A *standard* second user cannot read the vault; an **admin** can, via `sudo` |
| (b) | **The same account, left unlocked** | **No** | Nothing. Finder opens the vault |
| (c) | Physical disk access / theft | **Yes, fully** | FileVault. `fdesetup status` → On |

On Apple Silicon the SSD is always hardware-encrypted; FileVault's contribution
is binding the volume key to the **login password**, which is what stops an
attacker holding the hardware
([Apple Platform Security](https://support.apple.com/guide/security/volume-encryption-with-filevault-sec4c6dc1b6e/web)).

**The decisive point:** FileVault protects data *at rest*. Once the Mac is
booted and unlocked, the volume is decrypted for **every process and every user
on the machine**. FileVault provides no inter-user isolation.

So (c) is solved, (a) is solved against non-admin users, and **(b) is the only
real gap** — the narrowest of the three, and the one users usually mean.

**And (b) is not closed by whole-vault encryption either.** If the app is
running and the vault is unlocked, an unlocked machine reads it anyway. Any
design that auto-unlocks at login is transparent to attacker (b) *by
construction*. This is the crux, and it deserves stating plainly: **the designs
people ask for here defend threats the OS already covers, while leaving the one
they care about open.** The actual mitigation for (b) is a screen-lock delay.

### 3.2 Options, ranked by (threat mitigated) ÷ (damage + data-loss risk)

**1 — Document the real picture; optionally `chmod 0700` the vault. Best ratio
by far.** FileVault and POSIX already cover (a) and (c). A short "How your data
is protected" note that names the screen lock as the fix for (b) costs nothing
and misleads nobody. One line to tighten vault permissions on creation.

**2 — If a visible feature must ship: an encrypted APFS sparse bundle, mounted
on unlock.** Verified: while mounted it is an ordinary APFS filesystem — `grep`
works, atomic `tmp + rename` works, normal POSIX perms, and **Oratio's
filesystem-as-queue logic and `vault.ts` would need zero changes**. At rest it
is genuinely encrypted (`grep -rl` across `bands/` finds nothing). Zero crypto
code, zero new dependencies, no custom format, and the user can mount it in
Finder without Oratio existing — the Granola escape hatch.

  Costs, all real: **Spotlight indexing is off by default** on the mounted
  volume and enabling it needs `sudo`; sparse bundles
  [never auto-shrink](https://eclecticlight.co/2020/04/27/sparse-bundles-what-they-are-and-how-to-work-around-their-bugs/)
  and have no error-correcting code; the size cap is chosen up front; and they
  **must not live in iCloud/Dropbox**, where concurrent access risks
  corruption. That last one directly contradicts the "sync works for free"
  property in `vault.ts`, so it would become a documented either/or.

  Precedent: **DEVONthink's encrypted databases are exactly this** —
  `.dtSparse` encrypted sparse images
  ([DEVONtechnologies](https://www.devontechnologies.com/blog/20240917-unencrypt-database)).
  A serious document manager chose the OS primitive over custom crypto.

  If built: **prompt for the passphrase rather than storing it**, since
  auto-unlock re-opens threat (b) — and require the user to write it down.
  Oratio must not be the only copy of the key.

**3 — Encrypt only transcripts and notes at the app level.** Bad. Kills grep
and Obsidian for exactly the files whose readability is the point, leaves audio
readable, and adds a custom format.

**4 — Encrypt everything with a `safeStorage`-held key. Reject.**

This is worth spelling out because it is the obvious design and it is a trap.
`safeStorage` is already used correctly in this codebase for API keys
([settings.ts](../src/main/storage/settings.ts)) — a *re-enterable* secret.
Using it for the only key to a user's meeting archive is a different risk class:

- On macOS it is **AES-128-CBC with an IV of 16 literal space characters**, so
  ciphertext is deterministic under one key and — CBC with no MAC — unauthenticated
  and malleable. Verified against Chromium source
  ([`os_crypt_mac.mm`](https://chromium.googlesource.com/chromium/src/+/refs/tags/124.0.6351.1/components/os_crypt/sync/os_crypt_mac.mm),
  [`keychain_password_mac.mm`](https://chromium.googlesource.com/chromium/src/+/refs/tags/124.0.6351.1/components/os_crypt/sync/keychain_password_mac.mm)):
  a 128-bit random secret in a generic keychain item, base64'd, then
  PBKDF2-HMAC-SHA1(`"saltysalt"`, 1003 iterations, 128-bit). The base64 string
  is the PBKDF2 *input*, not the AES key itself.
- **Not Secure Enclave backed and not Touch ID gated** — a plain keychain item
  the app reads without user presence, so it does nothing against threat (b),
  the only open one.
- Electron's own docs concede: *"No built-in protection against data loss; you
  remain responsible for backup strategies"*
  ([docs](https://www.electronjs.org/docs/latest/api/safe-storage)).
- Keychain items are not reliably carried by Migration Assistant, and a login
  password reset can orphan the login keychain. The item is **not** marked
  `kSecAttrSynchronizable`, so iCloud Keychain does not carry it either — there
  is no cloud safety net.
- **The worst property, and the reason this is a trap rather than merely a weak
  cipher:** Chromium's `GetPassword()` treats `errSecItemNotFound` as *"mint a
  new random key"*. No error is raised. Every prior ciphertext becomes
  permanently undecryptable, and the app cannot tell the difference between a
  missing key and corrupt data — so it reports the wrong one. Signal shipped
  exactly this: users were shown a *"database corrupted — delete your data"*
  prompt over perfectly intact files
  ([#7256](https://github.com/signalapp/Signal-Desktop/issues/7256),
  [#7005](https://github.com/signalapp/Signal-Desktop/issues/7005), where a user
  recovered only because the old Mac still existed).
- Ordering trap, currently unfixed
  ([electron#45328](https://github.com/electron/electron/issues/45328), fix PR
  closed unmerged): touching `safeStorage` **including
  `isEncryptionAvailable()`** before `app.whenReady()` permanently freezes the
  keychain service name to `Chromium Safe Storage`, colliding with every other
  Electron app. **Checked: the current code is safe** —
  [settings.ts](../src/main/storage/settings.ts) calls `isEncryptionAvailable()`
  only inside `loadSecrets`/`saveSecrets`, which have no callers outside that
  module and are reached via IPC handlers registered after `whenReady()`. Worth
  keeping that way; it is the same shape as the `app.isPackaged`-at-module-scope
  trap already in CLAUDE.md.

A related dev/prod split worth recording, because it fails in the direction that
hides it: **Node 24.7+ exposes `crypto.argon2()`, but it throws
`ERR_CRYPTO_ARGON2_NOT_SUPPORTED` in Electron**, which links BoringSSL rather
than OpenSSL ≥3.2. `typeof argon2Sync === 'function'` passes first — the feature
check succeeds precisely where the feature is broken, and it works under plain
`node`. Same shape as the `existsSync`-returns-true-inside-asar trap in
CLAUDE.md. If a passphrase KDF is ever needed, `crypto.scryptSync` works but
**`maxmem` must be raised explicitly** or it throws
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS` at OWASP parameters.

It would also break `oratio-audio://` playback, the filesystem-as-queue
invariant, and `recoverOrphanedSessions` — which repairs WAV headers from raw
byte counts and cannot work on encrypted files. **And it reproduces the Granola
mistake with a weaker cipher.** That is not a hypothetical: the
`granola-claude-plugin` repo is deprecated with the literal note *"Granola
encrypted local cache — use official Granola MCP instead"*
([repo](https://github.com/varadhjain/granola-claude-plugin)) — users judged a
mediated API an insufficient substitute for files.

### 3.3 Prior art

**Logseq built this exact feature, shipped it, and removed it.** The single most
transferable data point here, and worth reading before anything else. On-disk
encryption was deleted in v0.8.10 (10 Nov 2022)
([announcement](https://discuss.logseq.com/t/deprecation-of-on-disk-encryption/12334)).
Their stated reasons map onto Oratio almost line for line: bugs with no clear
reproduction that risked data integrity, no "idiot-proof design", **"too
intrusive to the core"** with endless cross-platform edge cases, and bad
interaction with sync. They kept encryption where it was a *transport* concern
and pushed at-rest onto the OS. Users with encrypted data had to stay on old
versions or run a standalone decryption tool.

- **Obsidian** — no vault encryption. Notably there is **no official design
  statement**, only moderator remarks — so "by design" overstates it. What is
  well documented is what the plugins break: once encrypted notes stop being
  first-class `.md` (Meld Encrypt moved to `.mdenc`), `[[links]]` and `#tags`
  stop working, backlinks and graph participation are lost, in-note search
  fails, and live preview breaks
  ([#145](https://github.com/meld-cp/obsidian-encrypt/issues/145),
  [#154](https://github.com/meld-cp/obsidian-encrypt/issues/154)). Community
  answer is Cryptomator or an encrypted DMG: **a layer below the app**, not in it.
- **Silverbullet** — rejected E2EE twice on exactly our grounds ("it's just
  markdown files on disk" would go away), then shipped the interesting
  compromise in Oct 2025: encrypt the **client-side cache/index only**, leave
  canonical files plain, for an explicit "public computer" threat model
  ([#467](https://github.com/silverbulletmd/silverbullet/issues/467)). The
  closest thing to a design Oratio could copy without breaking its invariant.
- **Trilium "protected notes"** — the closest structural analogue to an optional
  per-item mode, and its tracker is a catalogue of how that leaks: protected
  content **readable in plaintext in the backup DB**
  ([#4657](https://github.com/zadam/trilium/issues/4657)), search silently
  missing protected notes ([#10406](https://github.com/TriliumNext/Trilium/issues/10406)),
  and the API unable to read them at all
  ([#9010](https://github.com/TriliumNext/Trilium/issues/9010)).
- **Bear** — "Bear Lock" with Touch ID is *authentication, not encryption*, and
  its per-note encryption is real and audited. A useful distinction: gating is
  what most users picture. Costs are instructive — no recovery, previews
  obfuscated even when unlocked, and **app extensions cannot read encrypted
  notes** ([FAQ](https://bear.app/faq/how-to-encrypt-lock-notes-with-bear/)).
- **DEVONthink** — `.dtSparse` encrypted sparse images, but note the leak:
  **the Spotlight index is not encrypted**, and sync does not carry encryption.
- **Joplin / Standard Notes** — E2EE is for *sync*; local SQLite is plaintext in
  Joplin, confirmed by its maintainer. Standard Notes ships Device Storage
  Encryption as a **toggle, mobile only**, specifically because launch-time
  decryption is slow on large libraries.
- **Cryptomator** — still viable, but macFUSE has been deprecated by Apple since
  macOS 12.3 and the replacement (FUSE-T) shipped experimental. Not a free answer.

**Four patterns worth carrying into any design here:**

1. **The cipher is never what leaks — the derived artifacts are.** Trilium's
   plaintext backup DB and DEVONthink's unencrypted Spotlight index are the same
   bug. For Oratio that lands squarely on `index.sqlite`, and on every
   `meta.json`/`transcript.json` written *before* the toggle was flipped —
   users will assume turning it on protects what already exists.
2. **Search is the first casualty, every time.** The apps that avoid it decrypt
   everything into memory, which is what forced Standard Notes' off-switch.
3. **An optional mode splits the invariant in two.** Whatever is encrypted stops
   being the source of truth for every external tool — the Granola complaint,
   arriving by a different road.
4. **Granola's actual sin was removing the escape hatch**, not encrypting.
   Encryption replaced file access with a gated API; the migration path users
   named was "plain markdown in a git repo."

### 3.4 Recommendation

Ship **option 1** now (documentation, plus `0700` on the vault). It is honest
and it is most of the actual protection.

Treat **option 2** as the design if a feature is wanted, but note that "Bear
Lock"-style **app-level gating** — a passphrase or Touch ID prompt to open
Oratio, with the files untouched — may be what is really being asked for. It
defends against the person who sits down at an unlocked laptop and opens the
app, which is threat (b), while leaving every invariant intact. It is *not*
encryption and must not be described as such: anyone who opens Finder still
reads everything.

There is also a **third option the prior art surfaced that is worth preferring
over option 2 if a real encryption feature is wanted**: Silverbullet's
resolution — encrypt the *derived* artifacts, leave the canonical files plain.
For Oratio that means `index.sqlite`, which by invariant holds nothing not
recoverable from the files and is already declared "safe to delete". It is the
one thing here that can be encrypted with **no** cost to the plain-files
property, no custom format for user data, and no recovery risk — losing the key
costs a rescan, nothing more. It does not defend threat (b), but it removes the
one place where a full-text copy of every transcript sits in a single
machine-readable file, which is the thing a casual snooper would actually open.

Whatever is chosen, **do not encrypt only new recordings and call the vault
protected** — pattern 1 above. Existing files stay readable, and that is
precisely the case a user will assume is covered.

Note also that if these are Teams meetings recorded on a work machine, the
question of whether recording is permitted at all is likely to be governed by
policy — worth checking before adding features that make recordings harder for
an employer to audit.

---

## 4. Two decisions taken alongside the research

### 4.1 Editing a transcript after the meeting

Listed in [IMPLEMENTATION.md](IMPLEMENTATION.md) as a known gap with the reason
it was deferred: it *"conflicts with `transcript.json` is machine output; needs
a provenance design."* That conflict is the whole design problem, and it is not
solved by making the text editable.

**Why a plain text box is the wrong answer.** Four things read
`transcript.json` and each breaks differently if edits land in it directly:

| Reader | What an in-place edit does |
|---|---|
| `index.sqlite` (FTS5) | Searches stale text until re-indexed |
| `notes.md` / AI summary | Summary silently disagrees with the transcript it cites |
| Playback (click a line → hear it) | `startMs`/`endMs` no longer describe the audio |
| Re-transcription | Silently destroys every edit |

That last one is decisive. A model upgrade, or the existing retry path, rewrites
`transcript.json` wholesale. Anything written into that file is *by design*
disposable — so user edits must not live there.

**The design: an overlay file, not an edit in place.** A sibling
`corrections.json` holding only what changed, keyed by segment, with the
original kept:

```jsonc
{ "segments": [
    { "index": 42, "text": "Kubernetes", "was": "cooper netties",
      "editedAt": "2026-08-09T18:40:00Z" } ] }
```

This follows the vault's existing grain rather than fighting it: `transcript.json`
stays machine output, plain files stay the source of truth, and the edit survives
re-transcription because it was never in the file being rewritten. It is also the
same shape as the `notes.md` split — machine output and human text already live
apart, so this is a third instance of a pattern the codebase uses twice.

Keeping `was` costs almost nothing and buys two things: an edit can be undone,
and — the reason it matters more here than in a notes app — **it makes plain
which words are the machine's and which are yours.** UI.md §86 already treats
provenance as load-bearing ("keeps the provenance of every sentence visible").

**Decided before building (the question this section left open):** re-application
is **by index, verified against `was`, with a single unambiguous text fallback** —
not index alone, and not fuzzy matching.

Index alone is unsafe here for a reason specific to this codebase rather than a
hypothetical one: A3's bleed removal *deletes* segments, so a re-transcription
shifts every index after the removal. Applying blind would move a correction onto
a different sentence, which is worse than losing it — a wrong word the user typed
themselves is indistinguishable from one they'd have caught.

Fuzzy matching fails the other way. `was` is by definition the text a model got
wrong, so it is short, garbled, and often near-duplicated elsewhere in the same
meeting ("cooper netties" twice in an hour about Kubernetes). A similarity
threshold high enough to be safe rejects the real matches; one low enough to
catch them mis-applies.

So the rule is:

1. If `segments[index]` still equals `was`, apply — the overwhelmingly common
   case, since most re-transcriptions change nothing before the correction.
2. Otherwise search the whole transcript for segments equal to `was`. Exactly
   one match, apply and record the new index. Zero or more than one, drop it.
3. A dropped correction is **kept in the file**, marked `orphaned`, never
   silently deleted — the user typed it, and it is the only copy.

Every step is exact string equality. The design gets its safety from `was`
rather than from a matching algorithm, which is why no threshold appears
anywhere in it.

**Not in scope:** editing timings, splitting or merging segments, or changing
speaker attribution. Each is a bigger design than the text edit and none was
asked for.

### 4.2 Retention as a mode, not a boolean — default "transcript only"

Modelled on **Fireflies' recording modes**, which is the only competitor
treating this as a workspace-level choice rather than a hidden default
([Fireflies docs](https://guide.fireflies.ai/articles/3598930706-Recording+Modes+for+Compliance+in+Fireflies:+Summary-Only,+Transcript-Only,+and+More)).
Every other competitor keeps audio unconditionally; Granola keeps none.

| Mode | Keeps | Notes |
|---|---|---|
| **Transcript only** *(default)* | transcript, notes, summary | Audio deleted the moment transcription succeeds |
| **Audio + transcript** | everything | Enables click-a-line-to-hear-it and later re-transcription |

Two reasons a mode beats the current boolean, beyond matching what was asked
for. It is **named from the user's side** — "what is kept" rather than
`discardAudioByDefault`, a negated flag that has to be read twice. And it leaves
room for a third mode later (Fireflies has "summary only") without another
migration.

**Mechanically this is nearly free.** The retention machinery is already built
and correct — `discardAudio` is wired through `RecordingController`,
`SessionMeta`, the record button and settings; `discardSessionAudio` runs only
*after* transcription succeeds
([TranscriptionQueue.ts:301](../src/main/transcription/TranscriptionQueue.ts#L301)),
re-reads `meta.json` rather than trusting a stale copy, and is safe to call
twice. The playback UI already degrades correctly when the WAVs are gone. So
this phase is a **rename plus a default flip plus UI**, not new plumbing.

**On permanent deletion — already correct, and worth keeping that way.**
Verified: `discardSessionAudio` uses `fs.rm`, an ordinary unlink, and **nothing
in the codebase calls `shell.trashItem`** — so discarded audio has never gone to
the Trash and does not now. Two things must stay true:

- Keep using `rm`, not `shell.trashItem`. A "delete the audio" setting that
  files a copy in the Trash is worse than not offering it, because the user
  believes it is gone.
- **Do not upgrade the wording to "securely erased."** `discardSessionAudio`
  already documents why: this is an unlink, so the bytes may remain recoverable
  on the device, and *"promising secure erase would be a lie on a modern SSD,
  where wear levelling puts the physical blocks out of our reach entirely."*
  Overwriting the file first would not fix that and would only make the lie
  more convincing. Say "deleted".

**What the default flip costs, all real:**

1. **It reverses a stated differentiator.** [UI.md §77](UI.md) lists Granola's
   "no audio, ever" against our "click any line, hear it — **we keep the WAVs**",
   and [RESEARCH.md](RESEARCH.md) ranks transcript-anchored playback as the
   **#1 structural complaint in the category** and Oratio's highest-value
   differentiator. That table entry must be rewritten, not left to rot — and
   note its Granola quote is **stale anyway**: Granola's current wording is that
   audio is *"deleted from our systems and any third-party services"*, an
   admission it reaches both.
2. **It removes the evidence an edit is checked against.** The direct
   interaction with §4.1: the way you fix a garbled name is to click the line
   and hear what was actually said. This is why P3 ships **after** P4.
3. **`nearEndDb` and bleed diagnosis become unrecoverable** — already flagged in
   [bleed.ts](../src/main/transcription/bleed.ts). Reports A and B were both
   diagnosed *from the WAVs*; future ones will not be.

**The argument the other way, recorded because it is easy to lose:** Granola
discards audio but **streams it to Deepgram/AssemblyAI** for cloud ASR. Oratio
transcribes locally, so the audio never leaves the machine at all — which means
the marginal privacy gain from deleting a local file is much smaller here than
the same change would be for a cloud tool, while the capability lost is real.
Note also that Granola's July 2026 class action turns on *consent*, not storage:
not keeping audio did not protect them. **This is precisely why the mode matters
more than the default** — users who want playback keep it, and the default stays
conservative.

---

## 5. Phases

Ordered by dependency, not by size. P1 first because it is finished code missing
a button; P3 after P4 for the reason in §4.2.

### P1 — Delete a recording ✅

Assumed to be UI-only. It was *nearly* — `deleteSession`, its IPC handler and
the preload bridge were all correct — but two main-process gaps turned up once
the UI existed to hit them, both recorded below.

- [x] Delete control in the session list row, and in the meeting view's header
- [x] Confirmation step naming exactly what is lost (audio, transcript, notes, summary)
- [x] Selection moves somewhere sane when the *selected* session is deleted — to the neighbouring row, not to the empty state
- [x] Wording says "deleted", never "securely erased" — an ordinary `rm` cannot promise erasure on an SSD, and `discardSessionAudio` already documents why
- [x] Deleting a **pending** session does not strand the transcription queue or leave a worker writing into a removed directory — `#transcribe` throws `ENOENT` on the missing `meta.json`, `#drain` catches it, and `#log` swallows its own failure, so the job is dropped rather than the queue stalling
- [x] Search index no longer returns it (verified: the handler unindexes, best-effort, and cannot fail the delete)
- [x] Surface the existing "discard audio, keep transcript" path nearby — it is offered *inside* the confirmation, which is where the person is standing when they discover they meant the smaller thing

**Two gaps found while building, both fixed:**

- [x] **Deleting the session being recorded right now was unguarded.** The capture pipeline holds open WAV writers into that directory, so the delete either loses the race (writers recreate the files, half a meeting survives as an orphan with no `meta.json`) or wins it (the controller writes into a removed path for the rest of the meeting). Now refused in the handler, and the sidebar hides the control on a `recording` row rather than offering one that only errors.
- [x] **Neither delete nor discard-audio told other windows.** The acting window refreshed itself, so this was invisible with one window open and left a second window showing a dead session, or a play button for files that no longer exist. Both handlers now broadcast `SESSION_CHANGED` via a new `sessionChanged` dep.

### P2 — Mute in Oratio ✅

Oratio's own mute, not detection of anyone else's. Works in every app, including
ones nobody has heard of, and needs no permission.

**Design decision, settled as planned: a muted stretch writes silence.** Silence
keeps `mic.wav` and `system.wav` sample-aligned, which the whole two-track
timeline depends on; writing nothing shortens the mic track and desynchronises
it. The existing `markDiscontinuity()` mechanism
([MacAudioCapture.ts:391](../src/main/audio/MacAudioCapture.ts#L391)) is the
wrong tool here — it announces a gap the timeline must *not* close, and nothing
is in fact missing from a muted stretch.

- [x] Mute state owned by main, alongside recording state — the tray can mute with no window open, exactly as it can record
- [x] Mute gates PCM at `pushMicPcm`, so a muted stretch is silence of the correct length rather than an absence
- [x] `IPC` channel + preload bridge, following the existing recording-control shape
- [x] Record button area shows mute state, and shows it unambiguously while recording
- [x] Tray menu item with an accelerator, and a tray title/icon that differs while muted
- [x] Muted ranges recorded in `meta.json`, **and rendered in the transcript** — "Your microphone was muted for 1 min 20 sec" rather than an unexplained silence
- [x] Muting mid-recording does not produce a discontinuity marker or shift the merged timeline
- [x] Mute cannot survive into the next recording — it must reset on start, or someone will lose a meeting to it

**The gate went one layer above where the checklist put it.** "Gates PCM at
`pushMicPcm`" would have meant gating inside `MacAudioCapture`, which is wrong
on two counts: mute is not a platform concept, so every future capture backend
would have to re-implement it identically; and `pushMicPcm` *also* emits `pcm`
for streaming transcription, so a gate downstream of it would have left Oratio
transcribing words the user believed it had not heard — the exact failure this
feature exists to prevent. The gate therefore sits in
[micPort.ts](../src/main/audio/micPort.ts), the single choke point every
platform shares, and substitutes a zero-filled buffer of the same length.

**Two things found while building:**

- [x] **A muted mic tripped the dead-track detector.** The liveness check reads a *cumulative* peak, so muting from the start of a recording leaves it at exactly zero — indistinguishable from the silent-success capture failure the check exists to catch. Reporting a dead microphone to someone who muted it themselves would teach them to distrust a warning that is right every other time. Filtered in `RecordingController#onDead`, which is the only object that knows both facts.
- [x] **The level meter had the same ambiguity, visibly.** A flat "You" meter is exactly what a dead mic looks like, and that meter exists to make a dead track noticeable mid-meeting. The muted meter now reads `muted` in place of the bar, so labelling the deliberate case keeps the alarming case alarming.

**Verified by test rather than by eye** (both harnesses in the session
scratchpad, not committed — they exercise logic, not the module graph):

- Sample-alignment: a 20-chunk mute inside a 50-chunk stream produces an
  identical total sample count to an unmuted control (32 000 either way),
  exactly 12 800 zeroed samples, zero signal surviving inside the muted
  stretch, and zero discontinuity markers.
- Range bookkeeping: 11/11 — ranges accumulate correctly across repeated
  cycles, a range still open at `stop()` is closed rather than lost, repeated
  `setMuted(true)` does not double-count, and **mute does not survive into the
  next recording**.

`RecordingController` cannot be imported outside Electron — it pulls in
`electron` transitively through `settings.ts` — so the second harness mirrors
the state machine rather than importing it. Worth knowing before trying to
unit-test anything else on the recording path.

**One thing deliberately not built: a mute keyboard shortcut inside the
window.** `CommandOrControl+Shift+M` is registered globally, which covers the
window too. A second, window-only binding would shadow it inconsistently
depending on focus.

#### The reader half — "you were muted here"

Writing `mutedRanges` was only half the checklist item, and the missing half was
the half that matters longest. Muting resolves its own ambiguity *live* — the
meter reads `muted`, the menu bar says `Muted` — but none of that survives the
meeting. A week later the transcript is all there is, and a muted stretch in it
is indistinguishable from a microphone that failed: VAD correctly drops the
silence, ASR is never called, and the user simply is not there. Several short
mutes scattered through an hour is the case that exposes it, because nobody
remembers where they were.

`meta.json` is the only record of the difference, so
[mutedMarkers.ts](../src/renderer/src/lib/mutedMarkers.ts) reads it and
[TranscriptView](../src/renderer/src/components/TranscriptView.tsx) draws a rule
across the transcript at each one. The ranges reach the renderer on the existing
`Session` object rather than through a new IPC channel — `listSessions` already
reads `meta.json` and `MeetingView` already holds the result.

Three decisions in the placement, none of them obvious until the test was
written:

- **Anchored to the end of a range, not the start.** A marker placed before the
  last turn *preceding* the mute sits above speech that happened while the mic
  was still live, which reads as though that speech were muted too. Anchoring to
  the turn that resumes puts it in the visual gap where the silence actually is.
- **The other side keeps talking through a mute**, since only the mic is gated.
  So the anchor is the first turn starting after the mute *ended*, from either
  track — not "the next turn", which is usually a `them` turn from the middle of
  the muted stretch and puts the marker in the wrong place entirely.
- **Sub-second mutes are not drawn.** A mis-click removes no meaningful speech,
  and rendering it would put a full-width rule in the transcript for nothing.

Not clickable, deliberately, even though the audio exists and is seekable: the
point of the stretch is that there is nothing of the user in it, and offering to
play it invites the reading that Oratio kept something. The other track is in
there and is reachable from the turns either side.

Verified against the real module this time — `mutedMarkers` is renderer-side and
pulls in no Electron, so unlike `RecordingController` it imports directly.
17/17, including both mutes of a two-mute recording landing on the correct turn
and on *neither* of the `them` turns spoken through them, a mute still open at
`stop()` rendering after the last turn, a mute covering an entire recording with
no turns at all, and the sub-second filter. Then confirmed on screen against a
real 26-second recording with ranges injected into its `meta.json`.

### P3 — Retention mode, defaulting to transcript-only ✅

Design in §4.2. Shipped **after** P4, so a correction could still be checked
against the audio while that feature was built. As predicted, mostly a rename
and a default flip — the retention machinery already existed and was correct.

**Settings**
- [x] `retention: 'transcript-only' | 'audio-and-transcript'` in `Settings`, replacing the negated `discardAudioByDefault` boolean
- [x] Default is `'transcript-only'`, with the reasoning in the comment beside it
- [x] Migration: an existing stored `discardAudioByDefault` maps to the new field, so **no existing user is silently switched** — and the old key is not left to rot in `settings.json`
- [x] Settings UI is a two-option choice naming what is *kept*, not a negated checkbox
- [x] Per-recording override still works and reads correctly against the new default

**Deletion must be permanent**
- [x] Discarded audio is `rm`'d, **never** `shell.trashItem` — verified again: zero occurrences of `trashItem` in `src/`, and `shell` is imported only for `openExternal`, `showItemInFolder` and `openPath`
- [x] Wording stays "deleted", **not** "securely erased". No overwrite pass was added
- [x] Audio is gone within one queue cycle of transcription succeeding, and a crash mid-delete retries on next launch (verified, not assumed — `rm` uses `force`, so the sweep is idempotent)
- [x] `audioDiscardedAt` is written only *after* the files are gone (verified by source order and on real files)

**Consequences**
- [x] [UI.md §77](UI.md) comparison table rewritten — and its stale Granola quote replaced with the current "deleted from our systems and any third-party services" wording
- [x] Copy says audio is deleted **after** transcription, never that it is not recorded
- [x] A transcript-only session still searches, summarises, exports, and shows no broken playback affordance
- [x] A transcript-only session that fails transcription does **not** lose its audio

**The migration was the whole phase.** Everything else was a rename. The danger
is specific and one-directional: the default *flipped*, so `loadSettings`'
existing `{ ...defaultSettings(), ...saved }` merge — which is correct for every
key that has ever been added — would have handed the new `transcript-only`
default to every existing user, because their file has no `retention` key to
override it with. That is not a cosmetic bug. It silently starts deleting audio
from people who explicitly chose to keep it, and unlike almost every other
mistake in this codebase it is unrecoverable: a transcript can be re-read, a
deleted WAV cannot be un-deleted.

`migrateRetention` therefore runs as a *later spread* over the merge rather than
inside it, mapping the old boolean whenever `retention` is absent, and the write
is forced immediately (following the provider-migration precedent) rather than
waiting for the user to change something — otherwise the old key sits in
`settings.json` describing a field nothing reads. Checked against the four file
shapes that exist in the wild, then against a real pre-P3 `settings.json`:
`[settings] retention migrated { from: false, to: 'audio-and-transcript' }`, the
old key gone, `retention` written, and every other key byte-identical.

**The per-recording checkbox had to invert.** It read "Delete audio after
transcribing", which was the deviation from the old default and is now the
default itself — so it would have sat pre-ticked on every recording, reading as
though *this* meeting had been singled out. It now says "Keep the audio for this
meeting" and negates the `discardAudio` it drives. `meta.json` still stores the
boolean, not the mode: it records what was decided for that session, and must
not be re-interpreted against a setting the user may have changed before the
transcript lands, possibly on a later launch.

### P4 — Editable transcripts

Design in §4.1. The overlay file is the load-bearing decision.

- [x] `corrections.json` written beside `transcript.json`, never into it
- [x] Each correction keeps `was`, so an edit is reversible and provenance stays visible
- [x] Vault read path merges corrections over segments; `transcript.json` alone remains valid and complete
- [x] Re-transcription does **not** destroy corrections — the case that makes the overlay necessary
- [x] Search index reflects corrected text, not stale machine output
- [x] AI summary and exports read corrected text, so the summary cannot cite words the transcript no longer shows
- [x] Edited lines are visually distinguishable from machine output
- [x] Playback still seeks correctly from an edited line — timings are not touched by an edit
- [x] Decide and record the re-application rule (segment index vs fuzzy match) before building it

**How the last five came out for free.** Every consumer — search indexing, all
four export formats, the AI summary and the renderer — already read the
transcript through `readTranscript`, so the merge went *there* rather than at the
call sites. Doing it per-caller would have meant six places that each have to
remember, where forgetting one produces a summary quoting words the transcript no
longer shows. `readRawTranscript` exists for the one caller that genuinely wants
machine output: the re-application pass itself.

**One thing the merge could not paper over.** A turn is several segments merged
into a paragraph for reading; a correction is per-*segment*, because that is what
carries `startMs`/`endMs`. So the editor puts one field per segment rather than
one per paragraph. A single paragraph-wide field would have to split the edited
text back across those segments to save it, and any split that isn't exactly
where the model put the boundary moves words onto a neighbouring timestamp —
click-to-play then seeks to the wrong moment, silently, which is the feature the
transcript exists for.

### P5 — Vault protection *(not planned — recorded for completeness)*

No encryption, per §3 and the decision above. If this is ever revisited, the
only two designs worth considering are an app-level **lock** (which is not
encryption and must not be called it) and encrypting `index.sqlite` alone.

- [ ] If ever built: the threat model is stated in user-facing terms, including what it does *not* cover

### Still open, needing hardware rather than a decision

- [ ] Run [native/research/mute-observe.c](../native/research/mute-observe.c) during a real Teams call, then Zoom, then a Slack huddle; record the output in §1.4. It decides whether *detecting* someone else's mute is possible at all — expected negative.
