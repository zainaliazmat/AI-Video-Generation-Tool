# Faceless Video Generator — Build Spec & Claude Code Prompt

> Paste this whole file into Claude Code as the project brief. It is also written
> so you can keep it in the repo (e.g. rename to `CLAUDE.md`) as persistent context.

---

## 0. How to start (read this to Claude Code first)

You are building the project described below. **Do not write any code yet.**
First, read the entire spec, then reply with:
1. A short restatement of the architecture in your own words.
2. The exact library versions you intend to install (Remotion, Kokoro, faster-whisper, etc.).
3. Any ambiguities or decisions you want me to confirm.
Wait for my "go" before Phase 1. Then build **one phase at a time**, stopping after
each so I can run it and confirm before you continue.

---

## 1. Goal

A **local, near-zero-cost faceless short-form video generator**. I give it a topic;
it produces a vertical (1080×1920) narrated video with stock footage and animated
word-by-word captions. No paid SaaS. Everything runs on my machine.

## 2. Architecture (hybrid)

```
  TOPIC
    │
    ▼
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  BACKEND  (Python)          │        │  RENDERER  (Remotion / TS)    │
│  the "what to show" brain   │ spec   │  the "how it looks" engine    │
│                             │ .json  │                               │
│  1. Script  (LLM)           │ ─────▶ │  • Player preview app         │
│  2. Voice   (Kokoro TTS)    │  +     │    (@remotion/player)         │
│  3. Timing  (faster-whisper)│ assets │  • <Video> composition        │
│  4. Footage (Pexels API)    │ ─────▶ │  • render → out/video.mp4     │
│  5. Assemble spec.json      │        │                               │
└─────────────────────────────┘        └──────────────────────────────┘
```

The **`spec.json` file is the only contract** between the two halves. The backend
never touches rendering; Remotion never makes network/AI calls. Either side can be
rebuilt independently as long as the spec stays the same shape.

## 3. Hard constraints

- **$0 running cost.** No paid APIs in the default path.
- **Voice:** Kokoro TTS, run locally (`pip install kokoro soundfile`). Apache-2.0, runs on CPU. Default voice `af_heart`.
- **Caption timing:** `faster-whisper`, run locally, to get **word-level timestamps** from the generated voiceover.
- **Footage:** Pexels API (free key) for stock video, Pixabay as fallback. Match keywords from each script line.
- **Music:** read royalty-free files from a local `assets/music/` folder. Do not fetch music from any API.
- **Script LLM:** make the provider **pluggable** via env var `LLM_PROVIDER`:
  - `ollama` (default, free, local) — call a local model like `llama3.1` or `qwen2.5`.
  - `anthropic` (optional) — use the Anthropic SDK with `ANTHROPIC_API_KEY`.
- **Remotion:** use Remotion 4.x. Install all `remotion` and `@remotion/*` packages at the **same exact version** (`--save-exact`). This project is for personal use, which qualifies for Remotion's free license.

## 4. The data contract — `spec.json`

This is the single source of truth. Define it **twice and keep them identical**:
a Pydantic model on the Python side and a TypeScript type on the Remotion side.
All timing is in **frames** (fps lives in `meta`), never seconds, so rendering is exact.

```jsonc
{
  "meta": {
    "title": "string",
    "fps": 30,
    "width": 1080,
    "height": 1920,
    "durationInFrames": 900
  },
  "audio": {
    "voiceover": "assets/voiceover.wav",   // path relative to remotion public/
    "music": "assets/music/lofi.mp3",      // optional, null if none
    "musicVolumeDb": -18                    // ducked under the voice
  },
  "scenes": [
    {
      "id": "scene-1",
      "startFrame": 0,
      "durationInFrames": 150,
      "media": {
        "type": "video",                    // "video" | "image"
        "src": "assets/clip-1.mp4",
        "fit": "cover",
        "kenBurns": { "from": 1.0, "to": 1.12, "originX": 0.5, "originY": 0.4 }
      }
    }
  ],
  "captions": [
    { "text": "word", "startFrame": 3, "endFrame": 14 }   // one entry PER WORD
  ],
  "style": {
    "captionFontFamily": "Inter",
    "captionFontWeight": 800,
    "captionColor": "#FFFFFF",
    "captionHighlightColor": "#FFE600",     // color of the word currently spoken
    "captionStrokeColor": "#000000",
    "captionPositionY": 0.78                 // 0 = top, 1 = bottom
  }
}
```

Rules:
- `captions` drive the animated subtitles: render all visible words, highlight/scale
  the word whose `[startFrame, endFrame]` contains the current frame.
- `scenes` are laid end to end; `media.kenBurns` gives slow zoom/pan so stills feel alive.
- The backend computes `durationInFrames` from the voiceover length and writes it to `meta`.

## 5. Project structure

```
faceless-video/
├─ CLAUDE.md                    # this file
├─ backend/
│  ├─ main.py                   # CLI: topic in → spec.json + assets out
│  ├─ pipeline/
│  │  ├─ script.py              # LLM (ollama | anthropic)
│  │  ├─ tts.py                 # Kokoro → voiceover.wav
│  │  ├─ timing.py              # faster-whisper → word timestamps
│  │  ├─ footage.py             # Pexels/Pixabay search + download
│  │  └─ assemble.py            # build & write spec.json
│  ├─ schema.py                 # Pydantic models for the spec
│  └─ requirements.txt
├─ remotion/
│  ├─ src/
│  │  ├─ Video.tsx              # main composition, reads spec props
│  │  ├─ Scene.tsx              # footage + Ken Burns
│  │  ├─ Captions.tsx           # animated word-by-word subtitles
│  │  ├─ schema.ts              # TS type mirroring schema.py
│  │  └─ Root.tsx               # registerRoot / Composition
│  ├─ preview/                  # @remotion/player app
│  │  └─ App.tsx                # load spec.json, scrub, "Render" button
│  ├─ public/assets/            # backend writes assets here
│  ├─ package.json
│  └─ remotion.config.ts
└─ spec.json                    # latest generated spec (gitignored)
```

## 6. Build phases (one at a time, stop after each)

**Phase 1 — Skeleton + contract.** Create the repo structure. Implement `schema.py`
(Pydantic) and `schema.ts` (TS type) so they match exactly. Hand-write a
`sample-spec.json` and drop 2–3 dummy video clips + a short wav into
`remotion/public/assets/` so the renderer can be built before the backend exists.

**Phase 2 — Renderer.** Build the Remotion `<Video>` composition that reads the spec:
scenes with Ken Burns, the voiceover + ducked music, and the animated word captions
(highlight the current word). Confirm `npx remotion studio` plays `sample-spec.json`
correctly and `npx remotion render` outputs `out/video.mp4`.

**Phase 3 — Preview app.** Build the `@remotion/player` app in `preview/`: load a
`spec.json`, scrub/play it, and a button that triggers a local render. `npm run preview`.
**Style this app per the UI Design System in section 10** (glassmorphism). The Player
sits in a glass card; controls, the topic input, and the render button all use the tokens below.

**Phase 4 — Backend pipeline.** Implement each stage behind a CLI, in order:
`script.py` (pluggable LLM) → `tts.py` (Kokoro) → `timing.py` (faster-whisper word
timestamps) → `footage.py` (Pexels search per line, download into public/assets) →
`assemble.py` (compute frame timings, write `spec.json`). Each stage independently runnable.

**Phase 5 — End to end.** `python backend/main.py --topic "..."` produces spec.json +
assets; preview shows it; `npm run render` outputs the MP4. Add a short README.

## 7. Current gotchas to respect

- **Remotion version alignment:** every `remotion` / `@remotion/*` package must be the
  identical exact version, or rendering breaks. Use `--save-exact`.
- **Fonts:** load caption fonts via `@remotion/google-fonts` (or a local file) and wait
  for the font to be ready before rendering, or text will render in a fallback font.
- **Kokoro voices:** use a known voice id (e.g. `af_heart`); generate at 24kHz and resample if needed.
- **faster-whisper:** request word-level timestamps (`word_timestamps=True`); feed it the
  generated voiceover, not the script text, so timing matches the actual audio.
- **Asset paths:** Remotion serves from `public/`, so spec paths must be relative to that and
  loaded with `staticFile()`. The backend must write assets into `remotion/public/assets/`.
- **Pexels:** respect rate limits; cache downloads by query so re-runs don't re-fetch.

## 8. Environment variables

```
PEXELS_API_KEY=...            # required (free at pexels.com/api)
LLM_PROVIDER=ollama           # ollama | anthropic
ANTHROPIC_API_KEY=...         # only if LLM_PROVIDER=anthropic
OLLAMA_MODEL=llama3.1         # only if LLM_PROVIDER=ollama
```

## 9. Acceptance test

```
python backend/main.py --topic "3 facts about deep sea creatures"
# → writes spec.json and remotion/public/assets/*

cd remotion && npm run preview     # scrub the result in the browser Player
npm run render                     # → out/video.mp4, 1080x1920, captions in sync
```

Definition of done: the MP4 has continuous voiceover, footage that changes per scene
with gentle Ken Burns, and word-by-word captions whose highlight lands on the spoken word.

---

## 10. UI Design System — Glassmorphism

**Source (single source of truth for visuals):**
https://app.notion.com/p/UI-Design-System-Glassmorphism-Reference-3734c89fff958177a1fcfbcd62790328

**Where it applies:** the `@remotion/player` **preview app** and any control UI around it
(topic input, render button, pipeline-progress view, history). It does **not** restyle the
rendered video — caption look stays in `spec.style`. The design tokens below were authored for
the "AI Newsroom" project; reuse the *aesthetic and tokens verbatim*, and map its screen ideas
onto this app as described in 10.8.

### 10.1 Aesthetic direction
Apple liquid-glass morphism — dark navy base, frosted glass cards, blue/purple gradient accent.
Refined, fast, editorial; every animation purposeful. **One rule:** if a component doesn't need
`backdrop-filter`, it doesn't get it. Glass is earned, not default.

### 10.2 Color tokens
| Token | Value | Usage |
|---|---|---|
| `--bg-base` | `#080c18` | Root background |
| `--bg-surface` | `#0d1220` | Card backgrounds |
| `--bg-elevated` | `#111827` | Raised surfaces |
| `--glass-bg` | `rgba(255,255,255,0.04)` | Default glass fill |
| `--glass-bg-hover` | `rgba(255,255,255,0.07)` | Glass on hover |
| `--glass-border` | `rgba(255,255,255,0.08)` | Default glass border |
| `--glass-border-active` | `rgba(99,102,241,0.4)` | Active/focus border |
| `--accent-1` | `#6366f1` | Indigo — primary |
| `--accent-2` | `#8b5cf6` | Violet — gradient end |
| `--accent-3` | `#a78bfa` | Light violet — text accents |
| `--grad-main` | `linear-gradient(135deg, #6366f1, #8b5cf6)` | Buttons, fills, active states |
| `--green` | `#10b981` | Success / done |
| `--amber` | `#f59e0b` | Warning / partial |
| `--red` | `#ef4444` | Error / failed |
| `--text-primary` | `rgba(255,255,255,0.92)` | Headings, key values |
| `--text-secondary` | `rgba(255,255,255,0.55)` | Body text |
| `--text-muted` | `rgba(255,255,255,0.30)` | Labels, metadata, placeholders |

### 10.3 Typography (DM Sans + DM Mono, via `next/font`)
| Role | Font | Size | Weight | Tracking |
|---|---|---|---|---|
| Hero title | DM Sans | clamp(32px, 5vw, 52px) | 600 | -0.03em |
| Page title | DM Sans | 22px | 600 | -0.025em |
| Section name | DM Sans | 13.5px | 600 | -0.01em |
| Body / output | DM Sans | 14px | 400 | 0 |
| Label / eyebrow | DM Sans | 11px | 700 | +0.08em |
| Code / prompts | DM Mono | 11–12px | 400–500 | 0 |
| Numbers / cost | DM Mono | varies | 600 | tabular-nums |

```typescript
import { DM_Sans, DM_Mono } from 'next/font/google'
export const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-ui', weight: ['300','400','500','600'] })
export const dmMono = DM_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400','500'] })
```

### 10.4 Spacing, radii, motion
Radii: `--radius-sm` 8px · `--radius-md` 12px · `--radius-lg` 16px · `--radius-xl` 24px.
Page padding 28–32px · card padding 14–20px · card stack gap 8–10px.
Motion: `--ease-out` `cubic-bezier(0.16,1,0.3,1)` for all transitions · `--dur-fast` 150ms (hover/badges)
· `--dur-med` 220ms (accordion) · Framer Motion spring stiffness 300 / damping 30 (page transitions)
· shimmer 1.6s linear infinite (skeletons) · ring-pulse 1.5s ease-in-out infinite (running step).

### 10.5 Glass card recipe (core pattern)
```css
.glass {
  background: rgba(255,255,255,0.04);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 16px;
}
.glass:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.12); }
.glass.active { border-color: rgba(99,102,241,0.35); background: rgba(99,102,241,0.05); }
```
Tailwind: `bg-white/[0.04] backdrop-blur-xl backdrop-saturate-180 border border-white/[0.08] rounded-2xl`

### 10.6 Ambient background (apply once to `<body>`, never per-screen)
```css
body::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(ellipse 80% 50% at 20% 10%, rgba(99,102,241,0.12) 0%, transparent 60%),
    radial-gradient(ellipse 60% 40% at 80% 80%, rgba(139,92,246,0.10) 0%, transparent 60%),
    radial-gradient(ellipse 40% 60% at 50% 50%, rgba(59,130,246,0.04) 0%, transparent 70%);
}
```

### 10.7 Component patterns
**Buttons** (`border-radius: 8px`, 13.5px, weight 500, 150ms ease-out):
Primary → `--grad-main`, no border, hover `translateY(-1px)` + glow · Ghost → glass bg + glass border
· Danger → `rgba(239,68,68,0.10)` bg + `rgba(239,68,68,0.25)` border.

**Badges / pills** (`border-radius: 100px`, 11px, weight 600, tracking 0.04em, padding 3px 8px):
green `rgba(16,185,129,0.15)`/text `#34d399` · amber `rgba(245,158,11,0.15)`/`#fbbf24`
· red `rgba(239,68,68,0.15)`/`#f87171` · purple `rgba(139,92,246,0.15)`/`#a78bfa`
· blue `rgba(59,130,246,0.15)`/`#60a5fa` · dim `rgba(255,255,255,0.05)`/muted.

**Progress bar** (reuse the source's confidence-bar pattern for render/pipeline progress):
horizontal, never circular — `h-[5px] bg-white/[0.06] rounded-full`, fill uses `--grad-main`,
mono tabular-nums percentage on the right.

**Stepper** (for the backend pipeline view): 38×38px circle; states queued (dim) → running
(indigo border + ring-pulse) → done (gradient fill + check + glow) → failed (red); 2px connector
line transitions from glass-border to `--grad-main` on completion.

**Toasts:** use **Sonner** — `<Toaster theme="dark" position="bottom-right" />`, e.g.
`toast.success('Render complete')`, `toast.loading('Generating voiceover…')`.

### 10.8 Screen mapping for THIS app
The source page describes 6 newsroom screens; reuse the *patterns*, remapped:
- **Home** → enter a topic in a glass input card (radius 24px, glow on focus), recent videos below as glass cards.
- **Pipeline** → the horizontal stepper for the 5 backend stages (script → voice → timing → footage → assemble), running stage tinted indigo.
- **Preview** → the `@remotion/player` inside a glass card; scrub controls + a primary "Render MP4" button; status badges (done/failed).
- **History** → table of generated videos (glass rows, hover lighten), duration + cost in DM Mono.
- Ignore the newsroom-specific Carousel and Settings screens unless you later want them.

### 10.9 Dependencies & Tailwind additions (preview app)
`sonner`, `framer-motion`, `clsx`, `tailwind-merge`, `tailwindcss` 3.x, `next/font` (built-in if Next).
The preview app should be a small React app (Next.js makes `next/font` trivial; Vite works too if you
self-host the fonts).
```javascript
// tailwind.config.ts — theme.extend
colors: { accent: { 1:'#6366f1', 2:'#8b5cf6', 3:'#a78bfa' } },
backgroundImage: { 'grad-main': 'linear-gradient(135deg, #6366f1, #8b5cf6)' },
backdropBlur: { glass: '20px' }, backdropSaturate: { glass: '180%' },
fontFamily: { ui: ['var(--font-ui)','sans-serif'], mono: ['var(--font-mono)','monospace'] },
animation: {
  'ring-pulse': 'ring-pulse 1.5s ease-in-out infinite',
  'shimmer': 'shimmer 1.6s linear infinite',
  'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
},
keyframes: {
  'ring-pulse': { '0%,100%': { boxShadow:'0 0 0 0 rgba(99,102,241,0.4)' }, '50%': { boxShadow:'0 0 0 6px rgba(99,102,241,0)' } },
  'shimmer': { '0%': { backgroundPosition:'-400px 0' }, '100%': { backgroundPosition:'400px 0' } },
  'pulse-dot': { '0%,100%': { opacity:'1', transform:'scale(1)' }, '50%': { opacity:'0.4', transform:'scale(0.7)' } },
},
```

> Note: the source page also lists a desktop-only mobile blocker (min 1024px). Optional here —
> apply it only if you want the preview app to be desktop-only too.
