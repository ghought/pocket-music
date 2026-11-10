# Pocket Music — browser prototype

A mobile-first music sketchbook: hum a melody, finger-drum a beat, or play keys; capture performances as editable clips; make variations; arrange a short song; export a WAV. Built from `Pocket_Music_PRD_v1.md` (v1.0, 2026-11-10).

## Run it

```bash
npm install
npm run dev          # http://localhost:5173 (mic works on localhost)
npm run dev:https    # HTTPS on your LAN so a phone can use the microphone (self-signed cert)
npm test             # unit tests (domain, sequencing, transcription, backup, WAV)
npm run build        # typecheck + production build to dist/
```

Node 22, all dependencies pinned exactly in `package.json`. No server, accounts, analytics, or API keys.

Debug hooks: in dev, `window.__pm` (store) and `window.__engine` (audio engine) exist. Add `?simulateStorageFailure` to the URL to make every write fail like a full disk.

## Architecture

| Module | Path | Notes |
| --- | --- | --- |
| Project domain | `src/domain/` | Serializable model (960 ticks/quarter), ops (scenes, song, make-unique), quantize, scales/chords, validation + migrations, demo song |
| Audio engine | `src/audio/` | One `AudioContext`; 25 ms poll / 100 ms look-ahead scheduler on audio time; live notes trigger immediately; mixer graph + instruments shared by live and `OfflineAudioContext` export |
| Transcription | `src/transcribe/` | YIN pitch tracking + conservative note segmentation, runs in a Web Worker; replaceable adapter (`client.ts`) |
| Persistence | `src/persist/` | IndexedDB (atomic transactions, takes stored immediately), ZIP backup/import with validation |
| UI | `src/ui/`, `src/state/store.ts` | React renders state only; it never schedules notes |

Undo is snapshot-based (immer structural sharing), 100 steps, with coalescing for fader drags and recording passes. Raw takes are immutable; unreachable takes are cleaned only when a project is closed after a successful save.

## What works (verified in desktop Chrome in this build)

- **Three start paths** (Hum / Drums / Keys) create an autosaved project; demo project; recent projects with rename/duplicate/delete (delete is confirmed).
- **Drums:** top-down kit and 4×4 pads share one kit and clip model; two synthesized kits; open/closed hat choke; desktop keys A–K, Q–I, Shift = accent.
- **Keys:** multitouch keyboard (glide, octave, sustain, hideable labels), scale pads (key-restricted, chromatic fallback, bass register), diatonic chord pads that ask for a key when none is set; piano, warm synth, pluck, mono bass with last-note priority.
- **Recording:** selected track only, 1-bar count-in, drum overdub, pitched takes never erase — Replace/Keep choice, all takes stay in the clip list.
- **Hum:** in-time (1–8 bars, 20 s cap, visual beat, no click) or free take; take saved before analysis; worker analysis with cancel; review with Original vs Instrument audition, sound choice, timing strength, start-point trim, clip length, out-of-clip warning (nothing silently dropped), re-analyze into a new clip, “no melody found” recovery with manual entry. Uncertain notes are dashed — no confidence percentages.
- **Editing:** piano roll (tap add/select, drag selected to move, edge handle to resize, step buttons, velocity, zoom, grid), fit-to-key preview/apply, quantize Off/Gentle/Tight + strength + restore original; drum step editor with bar paging, accents, clear.
- **Arrange:** scene matrix (desktop) / scene tabs (phone), next-bar scene launch with queued/cancel state, duplicate scene → independent copies, song timeline with move/duplicate/delete/loop-resize/reorder lanes, overlap rejection with highlight, linked instances + Make unique, separate Scene/Song playback source.
- **Mix/export:** level, pan, mute, multi-solo, tone + space knobs (vertical drag or arrow keys), master meter + clip LED; 44.1 kHz/16-bit stereo WAV of song or scene with 2 s tail, progress/cancel, post-render verification; download or system share; ZIP backup/import.
- **Resilience:** Saving / Saved on this device / Save failed (with retry + backup); persistent storage request; second tab goes read-only with “Edit here instead” takeover (Web Locks); backgrounding stops transport, releases notes, and keeps a partial hum take marked incomplete.

Browser checks run during this build: demo song playback, WAV export (correct length, 2 channels, 44.1 kHz, bounded, events on the beat), in-browser hum → notes on a synthetic voice-like take (7/7 notes exact, 90 ms), note editing keeps raw analysis, reload restores edits and takes, multi-pointer glide/cancel/blur leaves no stuck notes, drum recording timing, scene launch queue/cancel, simulated storage failure, 375 px phone layout.

## Not done / known limitations (please read)

- **Phase 0 device gates are not measured.** Touch-to-sound latency, 3-minute loop timing, conversion speed on phones, memory/CPU and thermal behavior need a physical iPhone (Safari), a midrange Android (Chrome), and an external measurement rig. Nothing here has been tested on Safari, iOS, or Android yet.
- **Hum accuracy is unproven on real voices.** The detector passes synthetic fixtures (clean, legato, noisy, silence). The PRD’s ≥85% note F1 gate needs a consented set of 20+ real phrases from 5+ singers. Spotify Basic Pitch has not been evaluated against it.
- **Instruments are synthesized, not sampled.** The PRD asks for curated samples; synthesis avoids licensing questions and keeps the app ~100 KB gzipped, but the piano in particular is an approximation. Swapping in a sampled piano or kit fits behind `playPitched` / `playDrum`.
- Export events land ~12 ms after their nominal time in Chromium (the master compressors’ look-ahead). Live playback has the same offset, so relative timing is unaffected.
- Recording latency is a manual offset in Settings; there is no automatic calibration and no Bluetooth detection.
- Mic capture uses an AudioWorklet with a ScriptProcessor fallback. MediaRecorder is not used. Capture chunks are kept in memory until stop, so a crash or force-quit mid-take loses that take. Backgrounding keeps it as an incomplete take.
- Song blocks move with buttons, not drag (the PRD allows visible commands as the alternative). The piano roll does support drag.
- Not implemented (optional or deferred in the PRD): “Balance levels”, service worker/offline caching, persistent undo across reload, tempo detection for free takes (tap tempo is offered instead).
- Changing tempo stops playback first, with an inline notice (by design).
- Browsers without the Web Locks API get no second-tab protection.

## Assets and licenses

- All sounds (instruments, drum kits, reverb impulse, metronome) are generated in code at runtime; no third-party samples, models, or fonts ship with the app. The system font stack is used.
- The demo song “Night Bus” is an original composition written for this project (`src/domain/demo.ts`).
- Runtime dependencies: React 18.3.1 (MIT), immer 10.1.1 (MIT), fflate 0.8.2 (MIT).

## Project format

`project.json` (schema v1, validated + migrated on load/import) plus `takes/<id>.wav` (mono 16-bit PCM originals) and `manifest.json` (SHA-256 hashes, factory instrument ids/versions). Import limits: 100 MB compressed, 250 MB expanded, 200 files, allow-listed paths only, 20 s takes, and future schema versions are rejected. An import always creates a new project.
