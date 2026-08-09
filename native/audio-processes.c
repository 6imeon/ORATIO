/*
 * audio-processes — print the PID of every Core Audio process object, one per
 * line, and exit.
 *
 * This exists to answer one question that nothing else on macOS answers
 * correctly: which processes can be named in a Core Audio tap.
 *
 * Why it is needed at all. AudioTee's --exclude-processes takes PIDs and
 * translates each to an AudioObjectID; if ANY translation fails it exits with
 * "Error: failure" and records nothing. Only processes that have actually
 * produced audio have an object, and a modern app is a process tree: Spotify
 * runs 7 processes of which exactly 1 is an audio object, and Chrome runs 38 of
 * which 3 are. Passing an app's whole tree therefore aborts the recording, and
 * passing only its main PID misses two thirds of Chrome's audio.
 *
 * Why not a proxy. `lsof` on the CoreAudio frameworks was measured against this
 * list and disagreed in both directions — it named PIDs with no audio object
 * and missed two of Chrome's three. There is no shell-level source that
 * matches; the property below is the ground truth.
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
 * Build (see scripts/build-native.mjs):
 *   clang -arch arm64 -arch x86_64 -O2 -framework CoreAudio \
 *     -o resources/audio-processes native/audio-processes.c
 */

#include <CoreAudio/CoreAudio.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  AudioObjectPropertyAddress listAddr = {
      kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain};

  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &listAddr, 0,
                                     NULL, &size) != noErr) {
    return 1;
  }

  /*
   * No audio objects at all is a legitimate state (nothing has made a sound
   * since boot), not an error. Exit cleanly with no output so the caller reads
   * it as "no PIDs" rather than as a failure.
   */
  if (size == 0) return 0;

  AudioObjectID *objects = malloc(size);
  if (objects == NULL) return 1;

  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &listAddr, 0, NULL,
                                 &size, objects) != noErr) {
    free(objects);
    return 1;
  }

  const int count = (int)(size / sizeof(AudioObjectID));
  AudioObjectPropertyAddress pidAddr = {kAudioProcessPropertyPID,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};

  for (int i = 0; i < count; i++) {
    pid_t pid = 0;
    UInt32 pidSize = sizeof(pid);
    /*
     * Skipped rather than fatal: the list is a snapshot and a process can exit
     * between enumerating it and reading this property. One unreadable entry
     * must not cost the caller the other twenty.
     */
    if (AudioObjectGetPropertyData(objects[i], &pidAddr, 0, NULL, &pidSize,
                                   &pid) != noErr) {
      continue;
    }
    printf("%d\n", (int)pid);
  }

  free(objects);
  return 0;
}
