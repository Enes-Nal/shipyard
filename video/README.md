# Terminal launch video

A 33.5-second launch video for Terminal, built as code so it can be rendered
again: one HTML page with inline SVG, put at time `t` by `window.seek(t)`,
stepped frame by frame in headless Chrome and encoded with ffmpeg. It is cut
to the beats of a CC0 track (see [MUSIC.md](MUSIC.md)).

The design follows the brand board (`design/brand/index.html`): the
landing page's daylight harbour drawn in line, Terminal Dark's quiet neutrals,
Inter for words and JetBrains Mono for commands, hosts and branches, and
amber only for the one light that means "needs you" (or the logo's dot).

## Outputs

`npm run render:all` writes `out/` (ignored by git):

| File | Frame | Notes |
| --- | --- | --- |
| `berth-launch.mp4` | 1920×1080, 60 fps | H.264 High, AAC 192k 48 kHz, about 7 MB |
| `berth-launch-square.mp4` | 1080×1080, 60 fps | same timeline, layout adapted |
| `berth-launch-vertical.mp4` | 1080×1920, 60 fps | same timeline, layout adapted |
| `berth-launch-poster.png` | 1920×1080 | the end card |

`npm run check` adds `out/*-contact-sheet.png` (a frame from every bar) and
`out/*-cuts.png` (each scene change: 8 frames before, on, 8 after, and half
a second in), and prints how far each cut is from its downbeat and the
audio offset.

## Storyboard

115 BPM, so a beat is 0.522 s and a bar 2.087 s. Scenes change on bar lines;
words, cards, typing, dots and checks land on beats and eighths.

| Time | Bars | Music | Scene |
| --- | --- | --- | --- |
| 0:00.0 | 0–1 | pad intro | The harbour draws itself; the mark rises, its amber dot drops in on beat 3, "berth" slides out on beat 4. "A harbour for your agents." on bar 1. |
| 0:04.2 | 2–3 | pad intro | "When your laptop sleeps," … on bar 3 the lid shuts with "your agents stop." (`claude · stopped`). |
| 0:08.3 | 4–5 | drums in | "One line installs berthd on a box." The curl command types in eighths, Enter on beat 4, the installer's lines one a beat; on bar 5 the harbour master's shed (the box) builds on the quay, labelled `devl`. |
| 0:12.5 | 6–7 | groove | "Every agent on every box, by what it needs." The Agent Dashboard: a card a beat into Working while a boat sets out for each (claude, codex, cursor). Bar 7: checkout-fix moves to Needs you (amber) and its boat's masthead lamp lights; qa-deck moves to Done on beat 3. |
| 0:16.7 | 8–9 | groove | "One prompt, several agents." Send on beat 2; a dot runs each line in eighths. Bar 9: "Each in its own worktree." The lines become branches, commits pop on the beats, each agent ticks done. |
| 0:20.9 | 10–11 | groove | "Every worktree gets a private URL." `3110.devl.localhost:1377` types in eighths, the page loads on beat 4; bar 11: "On your laptop only. Nothing public." |
| 0:25.0 | 12–13 | breakdown, pads | "Close the laptop." The lid shuts on beat 2 and its line goes dashed, "asleep"; the agent's line runs on through the night (23:18 → 07:40), the sun sets and comes up again, the boats keep going, one lamp still lit. Bar 13: "Your agents keep going." Done on beat 4. |
| 0:29.2 | 14– | final F chord | End card: the mark and "berth" on the chord, then the site's line, "Download for macOS", and "berthd.app · open source, MIT", one a beat. Held as the chord fades out at 0:33.5. |

## Re-render

Needs Node 22+, Google Chrome, ffmpeg (with libx264) and Python 3.

```sh
cd video
npm install                                   # playwright-core, drives your installed Chrome
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
npm run music        # downloads the track, cuts it, writes src/beats.json and .cache/music.wav
npm run render:all   # the three cuts and the poster (about 3 minutes)
npm run check        # cuts against the downbeats, audio sync, contact sheets
```

`npm run render` makes only the 16:9 cut. `npm run preview` serves the page
at <http://127.0.0.1:4417/video/src/index.html?f=16x9&hud=1&t=0>
(`?f=1x1` or `9x16` for the other frames, `?t=` to open at a time; call
`seek(12.5)` in the console). `npm run stills` writes a PNG at every bar
line of every frame to `out/stills/`.

## How it is built

- `scripts/music.py` (librosa): beat-tracks the source, fits a steady
  115 BPM grid to it, finds the downbeats from where the chords change,
  splices whole bars just before their transients (equal-power, 6 ms),
  fades the final chord, and analyses the edit again. `src/beats.json` holds
  the grid (downbeats, beats), the detected beats and strong onsets, the
  edit list, and the measured error: splices sit 0.8 ms from the grid, and
  the groove's transients a median 2.8 ms from it.
- `src/video.js`: everything on screen is a pure function of time.
  `at(bar, beat)` turns the grid into seconds; every scene starts on
  `at(n)` and every cue is a beat or an eighth of it. No CSS animations or
  transitions, so any frame can be rendered alone. Motion is transforms and
  opacity with expo-out entrances, a short ease-in exit that ends exactly on
  the next downbeat, and a slow push-in through each scene.
- `scripts/render.mjs`: a static server over the repository (the page uses
  `site/assets/fonts`), headless Chrome via playwright-core, one PNG per
  frame over CDP into ffmpeg (bt709, yuv420p, CRF 17, `-tune animation`,
  loudness-normalised to −15 LUFS).
- `scripts/check.py`: finds the empty frame at each scene change in the
  encoded file and compares it with the downbeat (all cuts land within one
  frame at 60 fps), and cross-correlates the mp4's audio with the edit
  (0 ms).

## Why not Remotion

Remotion (React → MP4) would have worked; the plain page needs no framework
and reuses the site's SVG and CSS as they are. Remotion's licence, as of
October 2026 (<https://github.com/remotion-dev/remotion/blob/main/LICENSE.md>):
free, commercial use included, for individuals, for-profit organisations
with up to 3 employees, non-profits, and for evaluation; any other
for-profit organisation needs a Company License (<https://www.remotion.pro/license>).
Nothing here depends on it.

## Licences

The code is MIT, like the repository. Inter and JetBrains Mono are under the
SIL Open Font License (`site/assets/fonts/`). The music is CC0 (MUSIC.md).
