# Speaker attribution — two bugs, and what the literature actually says

Research completed 9 Aug 2026, against the phase 12 codebase. Prompted by two
reproducible field reports, both of which turned out to be attribution bugs
rather than capture bugs — the audio was correct in both cases.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the two-track topology this depends
on. The reasoning behind the current detector is in the header of
`src/main/transcription/bleed.ts`. Part of it was wrong; §2 records what and
why, and phase A1 has since been built and shipped.

**Sources are cited inline.** Where this document contradicts an earlier claim
in the codebase, the earlier version is recorded next to the correction. That
is the part worth keeping — a bare "fixed" invites the next reader to fix it
back.

---

## 0. The two reports

Both reproduced with a YouTube video playing as the far end.

**Report A — an interjection lands after the turn it interrupted, not inside
it.** With a headset, speaking over a continuously-playing video: the
interjection is transcribed and attributed correctly to `me`, but appears
*after* the entire far-end paragraph rather than between the words it
interrupted.

**Report B — without a headset, near-end speech vanishes entirely.** Speakers
instead of a headset, video playing, speaking over it: nothing appears on the
`me` side at all.

Different causes, one shared root: **the level relationship between a
pre-mixer digital tap and an acoustic microphone is not what the code assumes.**

---

## 1. Report A — the ordering unit is too coarse

Not a capture bug and not an attribution bug. The transcript's ordering unit is
the VAD region, and regions are sorted by start time alone
(`TranscriptionQueue.ts:273`):

```ts
merged.sort((a, b) => a.startMs - b.startMs)
```

Each track is VAD'd independently. Continuous far-end audio never produces the
500 ms silence gap that `minSilenceDurationMs` needs to split a region, so the
whole stretch stays one region up to `maxSpeechDuration` (`worker/sherpa.ts`).
A two-second interjection *starts* later than that region did, so it sorts after
it — even though it happened in the middle.

The sort is correct. The granularity is wrong. **Segments genuinely overlap in
time, and a start-time sort cannot express overlap at all.** That is a data-model
limit, not a comparator bug, and it is worth being explicit that phase A3 below
mitigates it rather than solving it.

> **Since fixed by A3**, which lowered that cap from 30 s to 7 s — measured, not
> guessed. Note the cap is a *target* rather than a ceiling: Silero cuts only
> where speech probability dips, so it never splits mid-speech, which is both why
> regions can still exceed it and why the seams stay clean. Details in A3 below.

---

## 2. Report B — the correction to `bleed.ts`

### What the module header claims

> *"Wrigley found correlation so dominant that removing log energy entirely
> barely moved their ROC curves."*

The quote is accurate. The conclusion drawn from it — that correlation should
replace the level test — is not, for a reason the header does not account for:
**every channel in Wrigley's setup is a microphone.** Ours are a pre-mixer
digital tap and an acoustic mic. Cross-channel energy comparisons behave
differently when the channels are not the same kind of device.

### What Pfau actually measured

[Pfau, Ellis & Stolcke (ASRU 2001)](https://www.ee.columbia.edu/~dpwe/pubs/asru01-sad.pdf),
Table 2 — frame error rate on the ICSI meeting corpus:

| Energy norm. | Correlation post-proc. | FER | False alarms | False rejections |
|---|---|---|---|---|
| no | no | 18.6% | 16.9% | 1.7% |
| **yes** | no | **13.7%** | 11.9% | 1.8% |
| yes | yes | 12.0% | 9.8% | 2.2% |

Energy normalization alone is **26.4% relative**. Adding correlation
contributes a further **12.4%**, for 35% combined. Energy is the larger win,
not the smaller one — so replacing the level test with correlation would have
been a downgrade. The paper is explicit that normalization was *"essential to
cope with the channel variations found on this data"*, and that the channel it
mattered most for was the **lapel mic** — the channel most like a laptop mic.

### The step we are missing

Pfau's normalization is two stages, and stage one is absent from our code:

> *"First, the minimum frame energy `E_min,j` of channel `j` is subtracted from
> the current energy value to compensate for the different channel gains. The
> minimum frame energy is used as an estimate of the noise floor."*

Then the mean log-energy across channels is subtracted, leaving *"solely the
relative gain of the source at channel j compared to the average across all
channels."*

`TranscriptionQueue.ts` compared **raw** dB between the two tracks, so
the fixed `BLEED_LEVEL_DB = -20` was measuring the *channel gain difference* at
least as much as bleed. Measured on the W1 recording: mic RMS 11.4× below
system, roughly −21 dB, with `transcribe.log` reporting `median -20.4 dB` — past
the threshold **on a recording containing no bleed at all**, which is precisely
report B. Of that −20.5 dB, channel gain accounts for −19.8 dB, leaving a true
gap of −0.7 dB.

> **Superseded by measurement.** The obvious repair — subtract each channel's
> own floor, then compare per segment — was implemented and **fails**, inverting
> the two classes rather than separating them. See phase A1 for the numbers and
> for the per-recording gate that replaced it. Pfau's diagnosis (unnormalized
> energy is the bug) held; his estimator and its per-frame application did not
> transfer to a tap-plus-mic pair.

The comment that used to sit beside `BLEED_LEVEL_DB` assumed *"speaking into
your own laptop mic is normally LOUDER than the meeting audio."* Against a
pre-mixer tap running near full scale, it is not.

### Correlation, correctly scoped

Pfau's correlation stage is a *confirming* signal applied to overlap regions,
and its rule is a direct match for our case: when smoothed peak correlation
exceeds threshold, **reject the channel with the lower average energy.**

Concrete parameters, all from the paper:

- Peak normalized short-time cross-correlation, skew up to **±250 samples**
- **1024-point** signal windows
- Maximum smoothed by **median filter over 31 windows**
- Threshold **0.4–0.7** ("choosing a threshold between 0.4 and 0.7 will
  successfully reject many of the cases")

Our measured baseline for genuinely separate speech is **r = 0.087** (W1, 1.35%
identical aligned samples), which sits far below that band — so the separation
this relies on is present in our data.

[Wrigley et al. (IEEE TSAP 2005)](https://eprints.whiterose.ac.uk/id/eprint/812/1/wrigleysn1.pdf)
supports adding it: best-performing features were **kurtosis, fundamentalness
and cross-correlation metrics**, reaching up to **96%** classification accuracy.
Maximum normalized cross-correlation was individually strong; ZCR was weak,
which the authors attribute to varying background noise and breath noise.

### Both papers reject cancellation

Worth recording, because it is the obvious thing to reach for. Pfau tried it —
Block Least Squares — and abandoned it over *"the very rapid changes in
coupling."* This agrees with the existing reasoning in `bleed.ts`, which stays
correct: our two clocks free-run, our reference is pre-mixer, and a
mis-converging AEC would eat the user's own words. **Detection, not
cancellation, remains the right call.**

---

## 3. What the industry does

None of these solve our problem. They avoid it — which is itself the finding.

**Zoom** offers *"Record a separate audio file of each participant."* That
converts diarization into **channel** diarization: attribution goes from ~70% on
a four-person call to 99%+, because the file identifies the speaker and there is
no overlap within a file
([AssemblyAI](https://www.assemblyai.com/blog/transcribe-multichannel-zoom),
[Sonix](https://help.sonix.ai/en/articles/5520629-how-to-separate-speakers-in-zoom-and-set-up-multitrack-transcription-in-sonix)).

**Microsoft Teams** uses **Continuous Speech Separation** in an architecture
Microsoft calls **SRD — "separate, recognize, diarize."** Separation happens
*before* ASR. It leans on the observation that **>98% of meeting frames contain
two or fewer concurrent speakers**, so audio is separated into two output
channels, each then recognized independently. Reported **16.1% WER improvement**
over an optimized beamformer
([MSR blog](https://www.microsoft.com/en-us/research/blog/making-machines-recognize-and-transcribe-conversations-in-meetings-using-audio-and-video/),
[arXiv:1810.03655](https://arxiv.org/pdf/1810.03655)).

This is the real answer to report A: **overlap is handled by separation, not by
sorting.** Our two-track split already *is* a separation stage — we get for free
what CSS spends a neural network to recover. The defect is purely in how the
two tracks are reconciled afterwards.

**Granola** captures mic + system audio exactly as we do, and explicitly
[cannot isolate per-application audio](https://docs.granola.ai/help-center/taking-notes/transcription).
Same architecture, same constraint.

**Superwhisper** ships [speaker separation off by default](https://superwhisper.com/docs/modes/meeting)
in Meeting mode, and when on, speaker labels appear only in the segments view —
not in summaries or action items.

**Conclusion:** the two-track design is already the Zoom-grade approach and is
the right one. Nothing here suggests changing the capture architecture.

---

## 4. Phases

Ordered by payoff per unit of risk. A1 alone was expected to fix report B, and
did. A3 mitigates report A. **A2 is the only phase still outstanding**, and A1
narrowed its scope to a single case — see below.

### Phase A1 — per-channel normalization ✅ done 9 Aug 2026

Shipped as a per-recording **gate**, not the per-segment normalizer planned
below. Two things the plan got wrong were found by measurement; both are
recorded here because both are easy to "fix" back.

**Correction 1 — Pfau's minimum-frame-energy estimator does not transfer.** It
assumes every channel has a noise floor. Our system track is a digital tap:
**13.7% of its frames are exactly zero**, so its minimum energy is 0 and the
subtraction is undefined. A percentile of *active* frames is the workable
reference.

**Correction 2 — normalizing per segment cannot work at all, and this is the
important one.** Dividing each track by its own speech level is circular: if the
mic contains only bleed, the mic's own speech level *is* the bleed level, so the
ratio is ~1 by construction. Measured, it does not merely weaken — it **inverts**
the classes:

| case | raw gap | after per-segment normalization |
|---|---|---|
| genuine headset speech | −20.2 dB | **+5.4 dB** |
| bleed, −15 dB path | −15.0 dB | +30.6 dB |
| bleed, −27 dB path | −26.9 dB | +24.4 dB |
| bleed, −36 dB path | −35.6 dB | +16.1 dB |

Bleed scores *higher* than real speech, so no threshold on that quantity can
separate them. The root cause is that within one segment, "user speaking quietly
over loud far-end audio" and "room echo of that audio" are the same measurement.
**The question is not answerable per segment.**

**What was built instead.** Measure the mic only on *solo frames* — where the
system track is quiet, so there is nothing to bleed from — and ask a
whole-recording question: does this mic ever hear anything of its own?

| case | gate |
|---|---|
| real near-end speech (headset) | **−25.7 dB** |
| simulated bleed, −15 dB path | −45.6 dB |
| simulated bleed, −27 dB path | −51.3 dB |
| simulated bleed, −36 dB path | −51.7 dB |

~20 dB of separation, and the bleed side **saturates** near −51 dB — past about
−20 dB of acoustic attenuation the mic hears its own noise floor rather than the
room, so the margin does not shrink as the acoustic path worsens. Threshold set
at −35 dB, ~10 dB clear of both sides.

- [x] Estimate the mic's level on solo frames (system-quiet), not a per-track
      noise floor — see corrections above
- [x] Gate the whole recording on it rather than normalizing each segment
- [x] Re-derive the constants: `BLEED_LEVEL_DB`/`CONCLUSIVE_LEVEL_DB` (−20/−25,
      raw) replaced by a single `NEAR_END_PRESENT_DB` = −35 (gate)
- [x] Record the derivation, and the failed normalizer, in `bleed.ts` and
      `readWav.ts` next to the code
- [x] Remove `similarity()`/`MIN_SIMILARITY` — dead once the gate decides, and
      already documented as not separating the classes

**Verification** — all run against the real W1 recording, which reproduces
report B (`removed 1 speaker-bleed segment`, transcript containing **zero** `me`
lines).

- [x] W1 headset recording (no bleed present) yields **zero** removals
- [x] Simulated speakers-only bleed still removed at −15, −27 and −36 dB paths
- [x] No-op when there are no mic segments to remove
- [x] Fails **open** when uncalibratable — too little far-end silence, empty
      track, or digitally silent track all leave the transcript untouched
- [x] Degrades safely on pauseless far-end audio: the gate reads *higher*
      (−27 dB vs −51 dB for the same bleed), erring toward keeping mic segments
- [x] `pnpm typecheck` and `pnpm build` clean

**Still to confirm on hardware** — the fixtures cover the real no-bleed case and
simulated bleed, but not a real acoustic one:

- [ ] A genuine speakers-only recording still has its bleed removed
- [ ] Report B reproduction end-to-end: speakers + far-end audio + near-end
      speech → near-end speech survives into the transcript

### Phase A2 — correlation for the case the gate cannot decide

**Scope narrowed by A1.** Text similarity is gone rather than replaced — A1
removed it, since a whole-recording gate has no ambiguous band for it to guard.
What is left for correlation is the one case A1 deliberately declines to judge:
a recording with **both** a near-end speaker and bleed. There the gate says
"person present, keep everything", so bleed lines survive. Correlation is what
could recover those without reintroducing a per-segment level test.

This is now a refinement on a narrow case, not a fix for a reported bug — worth
weighing against A3, which addresses a bug that is still open.

- [ ] Peak normalized cross-correlation over the segment window: ±250 sample
      skew, 1024-point windows, median-smoothed over 31 windows
- [ ] On high correlation, reject the **lower-energy** channel (Pfau's rule)
- [ ] Threshold from the 0.4–0.7 band, chosen against our own r = 0.087
      separation baseline rather than adopted blind
- [ ] Keep text similarity only where it is cheap and additive, or remove it if
      correlation subsumes it — do not keep both by default

**Verification**

- [ ] Genuine simultaneous speech (both parties talking, headset) is preserved
- [ ] Measured correlation for real bleed lands well above the chosen threshold
- [ ] Measured correlation for the W1 tracks stays near the 0.087 baseline

### Phase A3 — segmentation for overlap ✅ done 9 Aug 2026

Mitigates report A. Full CSS is out of scope — we already have separated tracks,
so the work is segmentation, not separation.

`maxSpeechDuration` lowered from 30 s to **7 s**, moved into
`DEFAULT_VAD_OPTIONS` as `maxSpeechDurationMs`, and mirrored into the energy
fallback. Measured on the W1 fixture, whose far-end track is one unbroken 17.4 s
region:

| cap | far-end regions | mic regions | reorders? | seams |
|---|---|---|---|---|
| 30 / 20 / 15 s | 2 | 1 | no | clean |
| 12 s | 3 | 1 | no | clean |
| 10 / 9 / 8 s | 3 | 2 | yes | **damaged** |
| **7.5 – 5.5 s** | 3 | 2 | **yes** | **clean** |
| 5 s | 4 | 2 | yes | damaged |
| 4 s | 5 | 2 | yes | word cut in half |

**Two corrections found by measuring.** Both matter more than the number.

**Correction 1 — `maxSpeechDuration` is a target, not a ceiling.** Silero only
cuts where speech probability dips, so it will not split mid-speech at all. At a
7 s cap the fixture's mic track still returns 11.3 s and 9.6 s regions, and
setting 10, 7 or 5 s yields *identical* mic regions because those are the only
two places a cut is available. Consequences:

- The old 30 s value **never bounded decoder backlog**, which was the reason
  given for it. Only a downstream split can do that.
- It is also *why the seams stay clean* — a cap that cut at exactly N seconds
  would slice mid-word. The looseness is the feature.

**Correction 2 — `speechPadMs` does not protect the primary path.** The A3 plan
said it "exists for this". It is applied only in the energy fallback; sherpa's
Silero binding exposes no padding parameter, so on the sherpa path the cut is
unpadded and *where it falls* is the only thing protecting the words either side.
That is why 7 s was chosen from the middle of a plateau rather than as the
smallest value that reorders.

- [x] Lower `maxSpeechDuration` from 30 s so a continuous far-end stretch
      becomes several regions an interjection can sort between
- [x] Confirm the split does not degrade ASR accuracy at region boundaries
      — by seam inspection, since `speechPadMs` turned out not to apply here
- [x] Mirror the cap in the energy fallback, which had no cap at all, so both
      detectors share an ordering unit
- [ ] Decide whether the transcript model should represent **concurrent** turns
      rather than linearizing them — a start-time sort cannot express overlap,
      and this is a UI/schema question, not a VAD one (open question 1)

**Verification** — 13/13, run against the real W1 recording.

- [x] Report A reproduction: the mic segment now sorts **between** two far-end
      segments rather than after all of them
- [x] Regions shrink well below the 30 s baseline (21.0 s → 11.3 s longest)
- [x] No far-end seam ends in a mid-phrase stub
- [x] No transcript content lost (119 words retained)
- [x] `mergeTurns` preserves the interleaving in the UI — 4 turns, `me` between
      the far-end turns, rather than one far-end block followed by both mic turns
- [x] Energy fallback splits the continuous track and **strictly** respects the
      cap (6.7 s longest), and its regions tile the source with no gaps
- [x] Degenerate inputs safe: empty, digitally silent, constant tone (correctly
      not speech), and 45 s of pauseless speech-like audio still terminates
- [x] `pnpm typecheck` and `pnpm build` clean

**Not fixed by this.** Genuinely simultaneous speech still cannot be expressed by
a flat start-time sort; this makes the ordering unit fine enough that
interjections land in roughly the right place. See open question 1.

---

## 5. Open questions

1. **Should the transcript schema carry overlap?** `TranscriptSegment` has
   `startMs`/`endMs` and sorts by start. Genuinely concurrent turns cannot be
   rendered faithfully in a flat sorted list. Deciding this is a prerequisite
   for the second half of A3 and touches `UI.md`.

   **Less pressing after A3, and better understood.** A finer ordering unit
   turned out to be most of the practical fix — the interjection now lands
   between the far-end segments, and `mergeTurns` preserves that. What remains is
   the genuinely simultaneous case, where the honest rendering is not a list at
   all. Worth noting the segments *already* overlap in the data (mic 3036–14354
   against far-end 3366–14236 on the fixture); the schema can express that, and
   only the flat sort and the UI discard it. So this is a rendering decision
   before it is a schema one.
2. ~~**Is normalization enough on its own, or is A2 required for report B?**~~
   **Answered: yes.** A1 fixes report B on the recording that exhibited it, and
   removes simulated bleed across a −15 to −36 dB range. A2 is refinement, not a
   fix — as Pfau's numbers predicted. Its value is narrower than the doc first
   assumed, though: the gate is a whole-recording verdict, so correlation's job
   is now the case the gate cannot decide — a recording that has **both** a
   near-end speaker and bleed, where A1 deliberately keeps everything.
3. **Does the far-end track need bleed detection at all?** `bleed.ts` argues the
   asymmetry is physical — there is no acoustic path from mic into a digital tap
   — and nothing found here contradicts that. Worth keeping as a stated
   invariant rather than an assumption.

---

## 6. Sources

- Pfau, Ellis & Stolcke — [*Multispeaker Speech Activity Detection for the ICSI Meeting Recorder*](https://www.ee.columbia.edu/~dpwe/pubs/asru01-sad.pdf) (ASRU 2001)
- Wrigley, Brown, Wan & Renals — [*Speech and Crosstalk Detection in Multichannel Audio*](https://eprints.whiterose.ac.uk/id/eprint/812/1/wrigleysn1.pdf) (IEEE TSAP 2005)
- Yoshioka et al. — [*Recognizing Overlapped Speech in Meetings*](https://arxiv.org/pdf/1810.03655) (2018)
- Microsoft Research — [*Making machines recognize and transcribe conversations in meetings*](https://www.microsoft.com/en-us/research/blog/making-machines-recognize-and-transcribe-conversations-in-meetings-using-audio-and-video/)
- AssemblyAI — [*Transcribe multichannel Zoom recordings*](https://www.assemblyai.com/blog/transcribe-multichannel-zoom)
- Sonix — [*Separate speakers in Zoom / multitrack transcription*](https://help.sonix.ai/en/articles/5520629-how-to-separate-speakers-in-zoom-and-set-up-multitrack-transcription-in-sonix)
- Granola — [*How transcription works*](https://docs.granola.ai/help-center/taking-notes/transcription)
- Superwhisper — [*Meeting mode*](https://superwhisper.com/docs/modes/meeting)
