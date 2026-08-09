#include <CoreAudio/CoreAudio.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
/*
 * Answers, for a REAL meeting: when you press mute in Teams/Zoom/Slack, does
 * anything observable change? Polls twice a second and prints only TRANSITIONS.
 *
 *   A) device input mute   -> does the app set kAudioDevicePropertyMute?
 *   B) IsRunningInput      -> does the app RELEASE the mic when muted?
 *
 * Either would give a permission-free mute signal. Neither is guaranteed.
 *
 * This exists because everything else was measured and RULED OUT (docs/PRIVACY.md
 * §1.2): AVAudioApplication.isInputMuted is strictly per-process and invisible
 * across processes; Core Audio process objects expose no mute property at all
 * (0/26, global and input scope); kAudioHardwarePropertyProcessInputMute returns
 * 'who?' for foreign objects. Only the two signals above remain, and they are
 * behavioural rather than declared — hence a live-call measurement rather than
 * a documentation lookup.
 *
 * Diagnostic, not shipped. No TCC permission required: enumeration raises no
 * prompt, and only creating a *tap* needs the grant.
 *
 * Read the output as: any line at all means the mute WAS observable. Silence
 * across several mute/unmute presses means it was not, which is the expected
 * result and is just as useful.
 */
static const char *APPS[] = {"zoom","teams","Slack","slack","Chrome","Safari",
                             "firefox","edgemac","WebKit","Discord","webex", NULL};
static int interesting(const char *b) {
  if (!b || !*b) return 0;
  for (int i = 0; APPS[i]; i++) if (strcasestr(b, APPS[i])) return 1;
  return 0;
}
static void ts(char *o, size_t n) {
  time_t t = time(NULL); struct tm lt; localtime_r(&t, &lt);
  strftime(o, n, "%H:%M:%S", &lt);
}
int main(void) {
  AudioObjectID pobjs[512]; char pbid[512][128]; UInt32 plast[512]; int pn = 0;
  AudioObjectID dobjs[64]; char dnm[64][128]; UInt32 dlast[64]; int dn = 0;
  int first = 1;
  printf("Watching. Press mute/unmute in your meeting a few times, then Ctrl-C.\n");
  printf("Any line below means that action IS observable.\n\n"); fflush(stdout);
  for (;;) {
    char now[16]; ts(now, sizeof now);
    /* ---- devices ---- */
    AudioObjectPropertyAddress la = {kAudioHardwarePropertyDevices,
      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    UInt32 sz = 0; AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,&la,0,NULL,&sz);
    int n = sz/sizeof(AudioObjectID); AudioObjectID *d = malloc(sz);
    AudioObjectGetPropertyData(kAudioObjectSystemObject,&la,0,NULL,&sz,d);
    for (int i = 0; i < n; i++) {
      AudioObjectPropertyAddress ma = {kAudioDevicePropertyMute,
        kAudioObjectPropertyScopeInput, kAudioObjectPropertyElementMain};
      if (!AudioObjectHasProperty(d[i], &ma)) continue;
      UInt32 m = 0, ms = sizeof m;
      if (AudioObjectGetPropertyData(d[i],&ma,0,NULL,&ms,&m) != noErr) continue;
      CFStringRef nm=NULL; UInt32 ns=sizeof nm;
      AudioObjectPropertyAddress na={kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
      AudioObjectGetPropertyData(d[i],&na,0,NULL,&ns,&nm);
      char nb[128]="?"; if(nm) CFStringGetCString(nm,nb,sizeof nb,kCFStringEncodingUTF8);
      int slot=-1; for(int k=0;k<dn;k++) if(dobjs[k]==d[i]){slot=k;break;}
      if(slot<0){ if(dn<64){slot=dn++; dobjs[slot]=d[i]; strncpy(dnm[slot],nb,127); dlast[slot]=m;} }
      else if(dlast[slot]!=m){
        printf("%s  DEVICE MUTE %s -> %s   [%s]\n", now, dlast[slot]?"on":"off", m?"ON":"off", nb);
        fflush(stdout); dlast[slot]=m; }
    }
    free(d);
    /* ---- processes ---- */
    AudioObjectPropertyAddress pa = {kAudioHardwarePropertyProcessObjectList,
      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    sz = 0; AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,&pa,0,NULL,&sz);
    int m2 = sz/sizeof(AudioObjectID); AudioObjectID *p = malloc(sz);
    AudioObjectGetPropertyData(kAudioObjectSystemObject,&pa,0,NULL,&sz,p);
    for (int i = 0; i < m2; i++) {
      CFStringRef b=NULL; UInt32 bs=sizeof b;
      AudioObjectPropertyAddress ba={kAudioProcessPropertyBundleID,
        kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
      if(AudioObjectGetPropertyData(p[i],&ba,0,NULL,&bs,&b)!=noErr||!b) continue;
      char bb[128]=""; CFStringGetCString(b,bb,sizeof bb,kCFStringEncodingUTF8);
      if(!interesting(bb)) continue;
      UInt32 in=0, is=sizeof in;
      AudioObjectPropertyAddress ia={kAudioProcessPropertyIsRunningInput,
        kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
      if(AudioObjectGetPropertyData(p[i],&ia,0,NULL,&is,&in)!=noErr) continue;
      int slot=-1; for(int k=0;k<pn;k++) if(pobjs[k]==p[i]){slot=k;break;}
      if(slot<0){ if(pn<512){ slot=pn++; pobjs[slot]=p[i]; strncpy(pbid[slot],bb,127); plast[slot]=in;
        if(in && !first){ printf("%s  MIC OPENED    %s\n", now, bb); fflush(stdout);} } }
      else if(plast[slot]!=in){
        printf("%s  MIC %s  %s\n", now, in?"OPENED   ":"RELEASED ", bb);
        fflush(stdout); plast[slot]=in; }
    }
    free(p); first = 0;
    usleep(500000);
  }
}
