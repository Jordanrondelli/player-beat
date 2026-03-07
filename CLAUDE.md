# CLAUDE.md - Player Beat

## Project Overview

Single-file web application (French UI) for audio playback with real-time waveform visualization and a community voting/reaction system. Built with vanilla HTML5, CSS3, and JavaScript — no frameworks, no build tools, no package manager.

## Architecture

Everything lives in **`index.html`** (~407 lines). The file contains inline `<style>` and `<script>` blocks. There is no build step — the file is served directly to the browser.

### Logical Components

| Component | Purpose | Key Functions |
|---|---|---|
| **Audio Engine** | Web Audio API playback, analyser node, kick detection | `pl2()` play, `pa()` pause, `sp()` stop, `ex()` extract waveform |
| **Visualization** | Canvas-based waveform + frequency display | `drawW()` waveform, `drawMini()` mini nav, `dw()` update, `an()` animation loop |
| **Playback Controls** | Play/pause, timeline, file upload, seeking | `fm()` format time, `rs()` resize handler |
| **Voting System** | Emoji reactions (fire/up/down) with stats | `uc()` update counts, `se()` show emoji, `tf()` trigger fire |
| **UI Effects** | Fire particles, glassmorphic design, animations | `mkF()` make fire particles, `gd()` init graphics |

### Variable Naming Convention

The codebase uses heavily abbreviated variable names:

- `ax` = AudioContext
- `ab` = AudioBuffer
- `sn` = source node
- `po` = playback position
- `ip` = isPlaying
- `st` = start time
- `wd` = waveform data
- `vo` = votes object
- `ctx` = canvas context
- `pf/pu/pd` = percentage fire/up/down

## Technology Stack

- **Language**: Vanilla JavaScript (ES6+)
- **Audio**: Web Audio API (decoding, playback, FFT analysis)
- **Graphics**: HTML5 Canvas API (2D)
- **Fonts**: Google Fonts CDN (Space Grotesk, JetBrains Mono)
- **No backend** — fully client-side

## Development

### Running Locally

Serve `index.html` via any HTTP server:

```sh
python3 -m http.server 8000
# or
npx serve .
```

Then open `http://localhost:8000` in a browser.

### Testing

No automated tests. Verify changes manually in the browser:

1. Load an audio file using the file input
2. Confirm waveform renders on the canvas
3. Test play/pause/stop and seeking
4. Test each vote button (fire, thumbs up, thumbs down)
5. Verify responsive layout on window resize

### Linting / Formatting

No linter or formatter is configured. When editing, match the existing minified style with short variable names.

## Key Conventions

- **Single-file architecture**: All changes go in `index.html`. Do not split into separate files unless explicitly requested.
- **Minified JS style**: Use short variable names consistent with existing code.
- **French UI**: All user-facing text is in French (e.g., "Charger un son", "L'avis du chat").
- **No external JS libraries**: Only browser-native APIs and Google Fonts.
- **CSS**: Uses CSS Grid, Flexbox, keyframe animations, backdrop filters, and gradients.

## Git

- **Remote**: GitHub (`Jordanrondelli/player-beat`)
- **Main branch**: `main`
- 3 commits in history; minimal commit messages
