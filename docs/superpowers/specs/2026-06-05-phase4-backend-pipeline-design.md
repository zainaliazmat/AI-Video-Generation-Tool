# Phase 4 — Backend Pipeline Design

**Date:** 2026-06-05
**Status:** Approved
**Spec authority:** `faceless-video-build-prompt.md` §6 (Phase 4), §3 (constraints), §7–§8.
**Prereqs:** Phases 1–3 complete & committed (`290cf9c`): the `spec.json` contract
(`backend/schema.py` ↔ `remotion/src/schema.ts`), the Remotion renderer, and the
Next.js preview app.

## Goal

`python backend/main.py --topic "..."` runs five stages in order and emits a valid
`spec.json` at the repo root plus assets in `remotion/public/assets/`, ready for the
Phase 2 renderer and Phase 3 preview to consume unchanged.

## Verified facts (2026-06-05, live against the user's account)

- DeepSeek model ids on this account: **`deepseek-v4-flash`**, **`deepseek-v4-pro`**.
  There is **no `deepseek-chat`**. **Default = `deepseek-v4-flash`** (fast/cheap,
  sufficient for ~60–90 s scripts; swappable to `-pro` via `DEEPSEEK_MODEL`).
- DeepSeek key + Pexels key both work live (Pexels returns vertical portrait clips).
- Env: Python 3.12.3, no venv yet, `espeak-ng` not installed.

## Hard constraints carried from the spec

- LLM provider **pluggable** via `LLM_PROVIDER` (`deepseek` default, `ollama`/`anthropic`
  optional). DeepSeek uses the `openai` SDK pointed at `DEEPSEEK_BASE_URL`.
- Voice: **Kokoro** TTS, local, CPU, default voice `af_heart`, 24 kHz.
- Captions: **faster-whisper**, word-level timestamps from the **generated voiceover**.
- Footage: **Pexels** video (portrait), cache downloads by query; Pixabay = future fallback.
- All timing in **frames** (fps in `meta`), never seconds.
- Assets written to `remotion/public/assets/`; paths in `spec.json` are relative to
  `remotion/public/` (loaded with `staticFile()`).

## Environment setup (one-time)

1. Create `backend/.venv` (Python 3.12); `pip install -r requirements.txt`.
2. Fix config: `.env` + `.env.example` `DEEPSEEK_MODEL` → `deepseek-v4-flash`.
3. Kokoro phonemization may require system `espeak-ng`. If misaki's bundle is
   insufficient, **hand the user `sudo apt install espeak-ng`** (do not run sudo).
4. faster-whisper + Kokoro download model weights on first run (CPU-only).

## Stage modules — `backend/pipeline/` (each independently runnable behind a CLI)

Each module exposes a pure-ish function plus an `if __name__ == "__main__"` CLI so it
can be run and debugged standalone. Shared helpers (env loading, frames math, asset
paths) live in small support modules to keep each stage focused.

### `script.py` — LLM script generation
- Input: `topic: str`. Output: `ScriptResult { title: str, lines: list[str] }` (ordered).
- Provider dispatch on `LLM_PROVIDER`. DeepSeek path: `openai` SDK, `base_url=DEEPSEEK_BASE_URL`,
  `model=DEEPSEEK_MODEL`, JSON-only response (title + N concise narration lines).
- Missing/invalid key → fail loudly naming `DEEPSEEK_API_KEY`.

### `tts.py` — voiceover
- Input: `lines`. Output: `remotion/public/assets/voiceover.wav` (24 kHz mono) +
  per-line audio offsets (seconds) for scene boundaries.
- Kokoro pipeline, voice `af_heart`; synthesize per line, concatenate, record offsets.

### `timing.py` — word-level caption timing
- Input: the generated `voiceover.wav`. Output: per-word `(startFrame, endFrame)`.
- faster-whisper `word_timestamps=True`; seconds→frames via shared `seconds_to_frames(fps)`.
- Timed against the **audio**, not the script text, so captions stay in sync.

### `footage.py` — stock clips
- Input: `lines`. Output: one downloaded portrait clip per line in
  `remotion/public/assets/`, returned as relative paths.
- Pexels video search per line (`orientation=portrait`), pick best vertical result,
  download. **Cache by query** (skip re-download on re-runs); respect rate limits.
- Missing key → fail loudly naming `PEXELS_API_KEY`.

### `assemble.py` — build & write `spec.json`
- Input: title, line offsets, word frames, footage paths. Output: validated `spec.json`
  at repo root.
- Build `Spec`: scenes (startFrame/duration from line offsets, Ken Burns per scene),
  captions (word-level karaoke from timing), audio (voiceover, optional music).
- **Serialize with `model_dump(by_alias=True)`** so `kenBurns.from` (not `from_`) is
  emitted — #1 contract gotcha. Validate via `Spec.model_validate` before writing.

### `main.py` — orchestrator CLI
- `python backend/main.py --topic "..."` wires the five stages in order:
  `topic → script → tts → timing → footage → assemble → spec.json`.
- Flags for partial runs / overrides as useful (e.g. `--no-footage` for offline dev).

## Data flow

```
topic
  → script.py      → title + ordered lines
  → tts.py         → voiceover.wav + per-line offsets (sec)
  → timing.py      → per-word (startFrame, endFrame)
  → footage.py     → portrait clip per line (cached)
  → assemble.py    → spec.json (validated) + assets in remotion/public/assets/
```
Scene boundaries derive from per-line audio offsets; total `durationInFrames` from the
VO length; captions are word-level from faster-whisper.

## Contract / integration fixes (memory's #1 gotcha)

- `assemble.py` output matches `backend/schema.py` ↔ `remotion/src/schema.ts` exactly,
  validated before write; `by_alias=True` mandatory.
- Generalize the renderer's `copy-spec` (remotion) and preview's `copy-assets` to use the
  generated **`spec.json`** via env-driven `SPEC_PATH` (default `spec.json`), not
  `sample-spec.json`, so a real run flows through to render + preview.

## Error handling & testing

- Each stage validates inputs and fails with actionable messages (missing key → names the
  env var; empty LLM output → clear error).
- **TDD where it pays** — pure logic gets unit tests with fixtures, no network:
  `seconds_to_frames` / frame rounding, scene-boundary math from offsets, caption
  windowing, and `assemble` JSON shape incl. `by_alias` (`kenBurns.from` present).
- **Live smoke tests** — one minimal real call each for DeepSeek and Pexels; Kokoro and
  faster-whisper run on a short sample.
- **End-to-end** — `python backend/main.py --topic "3 facts about deep sea creatures"`
  → assert `spec.json` validates against `schema.py`; optionally render to confirm playback.

## Build cadence

All five stages + orchestrator + config/integration fixes this session, then **stop for
user end-to-end verification** before Phase 5. Independent stage modules may be drafted in
parallel, then integrated and tested sequentially.

## Out of scope (Phase 4)

- Pixabay fallback (Pexels only for now).
- Music selection logic beyond reading a local `assets/music/` file if present.
- Preview "Generate" button wiring to the backend (Phase 5 end-to-end).
