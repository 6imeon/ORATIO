/*
 * audio-processes — report the Core Audio process objects, and optionally keep
 * reporting them as they change.
 *
 * Two modes, one binary, because both answer the same question from the same
 * property and duplicating that in two programs would let them drift:
 *
 *   audio-processes           print "pid" per line once, and exit
 *   audio-processes --watch   print "pid<TAB>in<TAB>out<TAB>bundle" per line,
 *                             a blank line to end each scan, forever
 *
 * The one-shot mode exists for exclusion (phase 11): which processes can be
 * named in a Core Audio tap. AudioTee's --exclude-processes takes PIDs and
 * translates each to an AudioObjectID; if ANY translation fails it exits with
 * "Error: failure" and records nothing. Only processes that have actually
 * produced audio have an object, and a modern app is a process tree: Spotify
 * runs 7 processes of which exactly 1 is an audio object, and Chrome runs 38 of
 * which 3 are. Passing an app's whole tree therefore aborts the recording, and
 * passing only its main PID misses two thirds of Chrome's audio.
 *
 * The watch mode exists for meeting detection (phase 12): IsRunningInput tells
 * us an app is using the microphone *right now*, which separates "Zoom is open"
 * from "you are in a call", and works for Meet and Slack huddles too because it
 * does not care which app it is.
 *
 * Why not a proxy for either. `lsof` on the CoreAudio frameworks was measured
 * against this list and disagreed in both directions — it named PIDs with no
 * audio object and missed two of Chrome's three. There is no shell-level source
 * that matches; the property below is the ground truth.
 *
 * Why a separate binary rather than a native Node addon. An addon would couple
 * us to Electron's ABI (a rebuild on every upgrade), require node-gyp, and have
 * to dlopen inside the main process. This is a subprocess that prints integers,
 * in the same shape as the mdfind and pgrep calls beside it, and it can crash
 * without taking the app with it.
 *
 * Enumeration needs no TCC permission and raises no prompt — verified. Only
 * creating a tap needs the grant.
 *
 * WHY WATCH MODE POLLS RATHER THAN USING A PROPERTY LISTENER. Measured on this
 * machine (macOS 15), not assumed — and the answer is more specific than "the
 * listeners are broken", which is the folklore:
 *
 *   - A listener on kAudioHardwarePropertyProcessObjectList DOES fire, several
 *     times per audio event. That much of Apple Forums 770348 is stale.
 *   - A listener on kAudioProcessPropertyIsRunningInput on a specific object
 *     never fired at all across a full QuickTime record/stop cycle.
 *   - The two combined still miss the event that matters. Registering listeners
 *     over every object at startup and re-scanning on each list change caught
 *     CoreSpeech but MISSED QuickTime entirely: an app that starts using the
 *     microphone appears as a *new* object, so there was no listener on it yet,
 *     and the wake that would have found it did not arrive.
 *
 * A 1 s poll over the same window tracked QuickTime exactly — appearing at 4 s
 * and clearing at 11 s, matching the recording. Polling is therefore not a
 * fallback here; it is the only approach measured to be correct. One scan is
 * ~2 ms, so the duty cycle is about 0.2% of one core.
 *
 * This process is long-lived and polls internally rather than being re-spawned
 * each second: fork+exec costs ~50 ms against the scan's 2 ms, so re-spawning
 * would be twenty-five times the work to get the same answer.
 *
 * Build (see scripts/build-native.mjs):
 *   clang -arch arm64 -arch x86_64 -O2 -framework CoreAudio -framework CoreFoundation \
 *     -o resources/audio-processes native/audio-processes.c
 */

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/*
 * How often watch mode re-scans.
 *
 * One second is a compromise between the two failure modes: slower and the
 * suggestion arrives after the meeting's opening exchange, which is the part
 * people most want recorded; faster buys nothing, because a human still has to
 * see the tray and click it.
 */
static const unsigned WATCH_INTERVAL_US = 1000000;

/** Read a UInt32 flag, treating any failure as "off" rather than as fatal. */
static UInt32 read_flag(AudioObjectID object, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = {selector, kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
  UInt32 value = 0;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(object, &address, 0, NULL, &size, &value) != noErr) return 0;
  return value;
}

/**
 * The process object's bundle ID, or an empty string.
 *
 * Empty is a normal answer, not a failure: a plain executable has no bundle at
 * all — `afplay` reports an empty bundle ID while audibly playing — so the
 * caller resolves a name from the PID instead.
 */
static void read_bundle(AudioObjectID object, char *out, size_t out_size) {
  out[0] = '\0';
  AudioObjectPropertyAddress address = {kAudioProcessPropertyBundleID,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
  CFStringRef bundle = NULL;
  UInt32 size = sizeof(bundle);
  if (AudioObjectGetPropertyData(object, &address, 0, NULL, &size, &bundle) != noErr) return;
  if (bundle == NULL) return;
  CFStringGetCString(bundle, out, (CFIndex)out_size, kCFStringEncodingUTF8);
  CFRelease(bundle);
}

/**
 * Fetch the process object list.
 *
 * Returns the count and stores a malloc'd array in *objects, which the caller
 * frees. A count of 0 with a NULL array is a legitimate state (nothing has made
 * a sound since boot), not an error.
 */
static int process_objects(AudioObjectID **objects) {
  *objects = NULL;
  AudioObjectPropertyAddress address = {kAudioHardwarePropertyProcessObjectList,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) {
    return -1;
  }
  if (size == 0) return 0;

  AudioObjectID *buffer = malloc(size);
  if (buffer == NULL) return -1;

  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, buffer) !=
      noErr) {
    free(buffer);
    return -1;
  }

  *objects = buffer;
  return (int)(size / sizeof(AudioObjectID));
}

/**
 * One scan.
 *
 * In watch mode every object is printed with its flags, and the caller decides
 * what is interesting — the alternative, filtering to IsRunningInput here,
 * would mean the reader could not tell "nothing is using the microphone" from
 * "the probe died", which are very different things to a detector.
 */
static int scan(int watch) {
  AudioObjectID *objects = NULL;
  const int count = process_objects(&objects);
  if (count < 0) return 1;

  AudioObjectPropertyAddress pid_address = {kAudioProcessPropertyPID,
                                            kAudioObjectPropertyScopeGlobal,
                                            kAudioObjectPropertyElementMain};

  for (int i = 0; i < count; i++) {
    pid_t pid = 0;
    UInt32 pid_size = sizeof(pid);
    /*
     * Skipped rather than fatal: the list is a snapshot and a process can exit
     * between enumerating it and reading this property. One unreadable entry
     * must not cost the caller the other twenty.
     */
    if (AudioObjectGetPropertyData(objects[i], &pid_address, 0, NULL, &pid_size, &pid) != noErr) {
      continue;
    }

    if (!watch) {
      printf("%d\n", (int)pid);
      continue;
    }

    char bundle[512];
    read_bundle(objects[i], bundle, sizeof(bundle));
    /*
     * Tab-separated because a bundle ID cannot contain a tab but the process
     * names we fall back to to can contain almost anything else.
     */
    printf("%d\t%u\t%u\t%s\n", (int)pid, read_flag(objects[i], kAudioProcessPropertyIsRunningInput),
           read_flag(objects[i], kAudioProcessPropertyIsRunningOutput), bundle);
  }

  free(objects);
  return 0;
}

int main(int argc, char **argv) {
  const int watch = argc > 1 && strcmp(argv[1], "--watch") == 0;

  if (!watch) return scan(0);

  for (;;) {
    if (scan(1) != 0) return 1;
    /*
     * A blank line terminates the scan. Without it the reader cannot
     * distinguish "no process is using audio" from a scan still in progress,
     * and would hold a stale detection indefinitely.
     */
    printf("\n");
    if (fflush(stdout) != 0) return 0;  // parent closed the pipe: exit quietly
    usleep(WATCH_INTERVAL_US);
  }
}
