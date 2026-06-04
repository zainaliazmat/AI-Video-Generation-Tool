# Phase 4 — Backend Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `python backend/main.py --topic "..."` runs five stages (script → tts → timing → footage → assemble) and writes a schema-valid `spec.json` at the repo root plus assets in `remotion/public/assets/`, consumable unchanged by the Phase 2 renderer and Phase 3 preview.

**Architecture:** Five independently-runnable stage modules under `backend/pipeline/`, wired by `backend/main.py`. Each stage splits a pure, unit-tested core (frames math, parsing, offset/scene building, `by_alias` serialization) from a thin I/O wrapper (DeepSeek/Pexels HTTP, Kokoro/faster-whisper models) injected as a dependency so tests need no network or model weights. `backend/` is the import root; everything imports as `pipeline.*` / `schema`.

**Tech Stack:** Python 3.12, pydantic v2 (`backend/schema.py`), `openai` SDK → DeepSeek (`deepseek-v4-flash`), Kokoro TTS (`af_heart`, 24 kHz), faster-whisper (`base`, CPU int8), Pexels video API via `requests`, `python-dotenv`, pytest.

---

## Import & test conventions (read once, applies to every task)

- **Import root is `backend/`.** Modules import siblings as `from pipeline.config import ...` and the contract as `from schema import Spec`.
- Every **runnable** module (`main.py`, the five stages) starts with a 2-line path bootstrap so it works both standalone (`python backend/pipeline/script.py`) and when imported:
  ```python
  import sys, pathlib
  sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/ ; main.py uses .parent
  ```
  Pure modules (`contracts.py`, `frames.py`, `config.py`) need no bootstrap — they are only imported after the path is set.
- **Tests** live in `backend/tests/` with a `conftest.py` that puts `backend/` on `sys.path`, so tests use the same `pipeline.*` / `schema` rooting (single module identity — avoids dual-import dataclass mismatches).
- **Run tests** from the repo root: `python -m pytest backend/tests -v` (inside the venv).
- **Commit** after every task. Prefix: `feat(pipeline): ...` / `test(pipeline): ...` / `chore: ...`. End commit bodies with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Task 0: Environment setup

**Files:**
- Create: `backend/.venv/` (virtualenv)
- Modify: `.env` and `.env.example` (`DEEPSEEK_MODEL`)
- Modify: `backend/requirements.txt` (add `pytest`)

- [ ] **Step 1: Create venv and install deps**

Run:
```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
python3 -m venv backend/.venv
backend/.venv/bin/pip install --upgrade pip
backend/.venv/bin/pip install -r backend/requirements.txt
```
Expected: pydantic, kokoro, soundfile, faster-whisper, openai, anthropic, requests, python-dotenv install successfully.

- [ ] **Step 2: Add pytest to requirements and install it**

Edit `backend/requirements.txt`, append:
```
pytest>=8.0               # unit tests (dev)
```
Run: `backend/.venv/bin/pip install pytest`

- [ ] **Step 3: Fix the DeepSeek model id (verified `deepseek-chat` is not on this account)**

In `.env`, change `DEEPSEEK_MODEL=deepseek-chat` → `DEEPSEEK_MODEL=deepseek-v4-flash`.
In `.env.example`, change `DEEPSEEK_MODEL=deepseek-chat` → `DEEPSEEK_MODEL=deepseek-v4-flash` and update its trailing comment to `# deepseek-v4-flash | deepseek-v4-pro`.

- [ ] **Step 4: Provide the espeak-ng install command to the user (do NOT run sudo)**

Kokoro uses espeak-ng for out-of-dictionary phonemization. It is not installed. Hand the user this command to run themselves (it may already be satisfied by misaki's bundle — Task 4's smoke test confirms):
```bash
sudo apt install espeak-ng
```

- [ ] **Step 5: Commit**

```bash
git add backend/requirements.txt .env.example
git commit -m "chore: Phase 4 env — add pytest, default DEEPSEEK_MODEL=deepseek-v4-flash"
```
(`.env` is gitignored and is not committed.)

---

## Task 1: Shared contracts + frames math

**Files:**
- Create: `backend/pipeline/contracts.py`
- Create: `backend/pipeline/frames.py`
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_frames.py`

- [ ] **Step 1: Write `conftest.py`**

`backend/tests/conftest.py`:
```python
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/
```

- [ ] **Step 2: Write the failing test**

`backend/tests/test_frames.py`:
```python
import pytest
from pipeline.frames import seconds_to_frames


def test_whole_seconds():
    assert seconds_to_frames(2.0, 30) == 60


def test_zero():
    assert seconds_to_frames(0.0, 30) == 0


def test_rounds_to_nearest():
    assert seconds_to_frames(1.04, 30) == 31   # 31.2 -> 31
    assert seconds_to_frames(1.06, 30) == 32   # 31.8 -> 32


def test_negative_raises():
    with pytest.raises(ValueError):
        seconds_to_frames(-0.1, 30)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_frames.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.frames'`.

- [ ] **Step 4: Write `contracts.py` and `frames.py`**

`backend/pipeline/contracts.py`:
```python
"""Lightweight data passed between pipeline stages (not the spec.json contract)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class LineOffset:
    index: int
    text: str
    start: float  # seconds, inclusive
    end: float    # seconds, exclusive


@dataclass
class WordTiming:
    text: str
    start_frame: int
    end_frame: int


@dataclass
class Clip:
    index: int
    query: str
    path: str  # relative to remotion/public/, e.g. "assets/footage_ab12cd34.mp4"
```

`backend/pipeline/frames.py`:
```python
"""Seconds -> frames conversion. All spec timing is in frames; fps lives in meta."""
from __future__ import annotations


def seconds_to_frames(seconds: float, fps: int) -> int:
    if seconds < 0:
        raise ValueError(f"seconds must be >= 0, got {seconds}")
    return round(seconds * fps)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_frames.py -v`
Expected: PASS (4 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/contracts.py backend/pipeline/frames.py backend/tests/conftest.py backend/tests/test_frames.py
git commit -m "feat(pipeline): stage contracts + seconds_to_frames with tests"
```

---

## Task 2: Config / env loader

**Files:**
- Create: `backend/pipeline/config.py`
- Create: `backend/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/test_config.py`:
```python
import pytest
from pipeline.config import require_env, get_env


def test_require_env_missing_raises():
    with pytest.raises(RuntimeError) as exc:
        require_env("DEFINITELY_MISSING_VAR_XYZ")
    assert "DEFINITELY_MISSING_VAR_XYZ" in str(exc.value)


def test_get_env_returns_default():
    assert get_env("DEFINITELY_MISSING_VAR_XYZ", "fallback") == "fallback"


def test_require_env_reads_set_value(monkeypatch):
    monkeypatch.setenv("SOME_TEST_VAR", "  hello  ")
    assert require_env("SOME_TEST_VAR") == "hello"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.config'`.

- [ ] **Step 3: Write `config.py`**

`backend/pipeline/config.py`:
```python
"""Env loading. Loads .env once from the repo root (cwd when running main.py)."""
from __future__ import annotations

import os

from dotenv import load_dotenv

_loaded = False


def load_env() -> None:
    global _loaded
    if not _loaded:
        load_dotenv()  # finds .env in cwd / parent dirs; does not override real env
        _loaded = True


def get_env(name: str, default: str = "") -> str:
    load_env()
    val = os.environ.get(name, "").strip()
    return val or default


def require_env(name: str) -> str:
    val = get_env(name)
    if not val:
        raise RuntimeError(
            f"Missing required environment variable: {name}. Set it in .env"
        )
    return val
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_config.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/config.py backend/tests/test_config.py
git commit -m "feat(pipeline): env config loader (load_env/get_env/require_env)"
```

---

## Task 3: Script stage (LLM, pluggable; DeepSeek default)

**Files:**
- Create: `backend/pipeline/script.py`
- Create: `backend/tests/test_script.py`

- [ ] **Step 1: Write the failing test (parsing + dispatch with a fake client)**

`backend/tests/test_script.py`:
```python
import json
import pytest
from pipeline.script import parse_script_response, generate_script


def test_parse_valid():
    content = json.dumps({"title": " T ", "lines": [" a ", "b"]})
    assert parse_script_response(content) == {"title": "T", "lines": ["a", "b"]}


def test_parse_missing_lines_raises():
    with pytest.raises(ValueError):
        parse_script_response(json.dumps({"title": "T"}))


def test_parse_empty_lines_raises():
    with pytest.raises(ValueError):
        parse_script_response(json.dumps({"title": "T", "lines": []}))


class _FakeMessage:
    def __init__(self, content):
        self.message = type("M", (), {"content": content})


class _FakeCompletions:
    def __init__(self, content):
        self._content = content
        self.captured = {}

    def create(self, **kwargs):
        self.captured = kwargs
        return type("R", (), {"choices": [_FakeMessage(self._content)]})


class _FakeClient:
    def __init__(self, content):
        self.chat = type("C", (), {"completions": _FakeCompletions(content)})()


def test_generate_script_deepseek_with_fake_client():
    fake = _FakeClient(json.dumps({"title": "Deep Sea", "lines": ["one", "two"]}))
    out = generate_script("deep sea", provider="deepseek", client=fake, model="deepseek-v4-flash")
    assert out == {"title": "Deep Sea", "lines": ["one", "two"]}
    assert fake.chat.completions.captured["model"] == "deepseek-v4-flash"
    assert fake.chat.completions.captured["response_format"] == {"type": "json_object"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_script.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.script'`.

- [ ] **Step 3: Write `script.py`**

`backend/pipeline/script.py`:
```python
"""Stage 1 — generate a short-form video script via a pluggable LLM provider.

LLM_PROVIDER: deepseek (default) | ollama | anthropic.
Run standalone:  python backend/pipeline/script.py --topic "3 facts about octopuses"
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import json

from pipeline.config import get_env, require_env

SYSTEM_PROMPT = (
    "You are a scriptwriter for short-form faceless videos (vertical, ~60-90s). "
    "Write punchy, factual narration. Respond ONLY with a JSON object of the form "
    '{"title": string, "lines": string[]} where each line is one spoken sentence '
    "(8-18 words), 5-8 lines total, no emojis, no markdown, no numbering."
)


def build_user_prompt(topic: str) -> str:
    return f"Topic: {topic}\nReturn the JSON object now."


def parse_script_response(content: str) -> dict:
    data = json.loads(content)
    title = data.get("title")
    lines = data.get("lines")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("Script response missing a non-empty 'title'")
    if (
        not isinstance(lines, list)
        or not lines
        or not all(isinstance(x, str) and x.strip() for x in lines)
    ):
        raise ValueError("Script response 'lines' must be a non-empty list of strings")
    return {"title": title.strip(), "lines": [x.strip() for x in lines]}


def generate_script(topic: str, *, provider: str | None = None, client=None, model: str | None = None) -> dict:
    provider = provider or get_env("LLM_PROVIDER", "deepseek")
    if provider == "deepseek":
        return _generate_openai_compatible(
            topic, client=client, model=model,
            default_model="deepseek-v4-flash",
            api_key_env="DEEPSEEK_API_KEY",
            base_url=get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            model_env="DEEPSEEK_MODEL",
        )
    if provider == "ollama":
        return _generate_openai_compatible(
            topic, client=client, model=model,
            default_model="llama3.1",
            api_key_env=None,
            base_url=get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1",
            model_env="OLLAMA_MODEL",
        )
    if provider == "anthropic":
        return _generate_anthropic(topic, client=client, model=model)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider!r}")


def _generate_openai_compatible(topic, *, client, model, default_model, api_key_env, base_url, model_env) -> dict:
    if client is None:
        from openai import OpenAI
        api_key = require_env(api_key_env) if api_key_env else "ollama"
        client = OpenAI(api_key=api_key, base_url=base_url)
    model = model or get_env(model_env, default_model)
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_prompt(topic)},
        ],
        response_format={"type": "json_object"},
        temperature=0.8,
    )
    return parse_script_response(resp.choices[0].message.content)


def _generate_anthropic(topic, *, client, model) -> dict:
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))
    model = model or get_env("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    msg = client.messages.create(
        model=model,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_user_prompt(topic)}],
    )
    return parse_script_response(msg.content[0].text)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    args = ap.parse_args()
    print(json.dumps(generate_script(args.topic), indent=2))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_script.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Live smoke test against DeepSeek**

Run: `backend/.venv/bin/python backend/pipeline/script.py --topic "3 facts about deep sea creatures"`
Expected: prints a JSON object with a `title` and 5–8 `lines`. (Uses `DEEPSEEK_API_KEY` from `.env`.) If it errors with an auth/model message, re-confirm `DEEPSEEK_MODEL=deepseek-v4-flash` in `.env`.

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/script.py backend/tests/test_script.py
git commit -m "feat(pipeline): script stage — pluggable LLM, DeepSeek default + tests"
```

---

## Task 4: TTS stage (Kokoro)

**Files:**
- Create: `backend/pipeline/tts.py`
- Create: `backend/tests/test_tts.py`

- [ ] **Step 1: Write the failing test (offset math + stitched-file length, fake synth)**

`backend/tests/test_tts.py`:
```python
import numpy as np
import soundfile as sf
from pipeline.tts import compute_offsets, synthesize, SAMPLE_RATE, SILENCE_SEC
from pipeline.contracts import LineOffset


def test_compute_offsets_inserts_gaps():
    offs = compute_offsets(["a", "b"], [1.0, 2.0], gap=0.5)
    assert offs == [
        LineOffset(0, "a", 0.0, 1.0),
        LineOffset(1, "b", 1.5, 3.5),
    ]


def test_synthesize_writes_wav_and_offsets(tmp_path):
    one_sec = np.ones(SAMPLE_RATE, dtype=np.float32)
    out = tmp_path / "vo.wav"
    offs = synthesize(["x", "y"], out, synth=lambda line: one_sec)
    assert out.exists()
    data, sr = sf.read(out)
    assert sr == SAMPLE_RATE
    gap = int(SILENCE_SEC * SAMPLE_RATE)
    assert len(data) == SAMPLE_RATE * 2 + gap          # 2 lines + 1 gap
    assert offs[0].start == 0.0 and abs(offs[0].end - 1.0) < 1e-6
    assert abs(offs[1].start - (1.0 + SILENCE_SEC)) < 1e-6
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_tts.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.tts'`.

- [ ] **Step 3: Write `tts.py`**

`backend/pipeline/tts.py`:
```python
"""Stage 2 — synthesize the voiceover with Kokoro (voice af_heart, 24 kHz).

Writes one continuous wav and returns per-line second offsets for scene timing.
Run standalone:  python backend/pipeline/tts.py --line "Hello world" --out /tmp/vo.wav
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline.contracts import LineOffset

SAMPLE_RATE = 24000
SILENCE_SEC = 0.15  # gap inserted between lines


def compute_offsets(lines, durations, *, gap=SILENCE_SEC) -> list[LineOffset]:
    offsets: list[LineOffset] = []
    cursor = 0.0
    for i, (text, dur) in enumerate(zip(lines, durations)):
        start = cursor
        end = start + dur
        offsets.append(LineOffset(index=i, text=text, start=start, end=end))
        cursor = end + gap
    return offsets


def _kokoro_synth(line: str, pipeline) -> np.ndarray:
    chunks = []
    for _, _, audio in pipeline(line, voice="af_heart", speed=1):
        chunks.append(np.asarray(audio, dtype=np.float32))
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def synthesize(lines, out_path, *, synth=None, pipeline=None) -> list[LineOffset]:
    if synth is None:
        if pipeline is None:
            from kokoro import KPipeline
            pipeline = KPipeline(lang_code="a")
        synth = lambda line: _kokoro_synth(line, pipeline)

    audios = [synth(line) for line in lines]
    durations = [len(a) / SAMPLE_RATE for a in audios]
    offsets = compute_offsets(lines, durations)

    gap = np.zeros(int(SILENCE_SEC * SAMPLE_RATE), dtype=np.float32)
    parts = []
    for i, a in enumerate(audios):
        parts.append(a)
        if i < len(audios) - 1:
            parts.append(gap)
    full = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), full, SAMPLE_RATE)
    return offsets


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--line", action="append", required=True, help="repeatable")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    offs = synthesize(args.line, args.out)
    for o in offs:
        print(f"[{o.start:.2f}-{o.end:.2f}] {o.text}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_tts.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Live smoke test (real Kokoro — confirms espeak-ng)**

Run: `backend/.venv/bin/python backend/pipeline/tts.py --line "The deep sea is the largest habitat on Earth." --out /tmp/vo_smoke.wav`
Expected: prints one offset line; `/tmp/vo_smoke.wav` exists and is audible. If it fails with a phonemizer/espeak error, the user must run `sudo apt install espeak-ng`, then re-run.

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/tts.py backend/tests/test_tts.py
git commit -m "feat(pipeline): tts stage — Kokoro voiceover + offset math + tests"
```

---

## Task 5: Timing stage (faster-whisper word timestamps)

**Files:**
- Create: `backend/pipeline/timing.py`
- Create: `backend/tests/test_timing.py`

- [ ] **Step 1: Write the failing test (seconds→frames word conversion)**

`backend/tests/test_timing.py`:
```python
from pipeline.timing import words_to_timings
from pipeline.contracts import WordTiming


def test_words_to_timings_converts_and_strips():
    raw = [("Hello ", 0.0, 0.5), (" world", 0.5, 1.0)]
    out = words_to_timings(raw, 30)
    assert out == [
        WordTiming("Hello", 0, 15),
        WordTiming("world", 15, 30),
    ]


def test_skips_blank_and_guarantees_min_one_frame():
    raw = [("  ", 1.0, 1.0), ("hi", 2.0, 2.0)]
    out = words_to_timings(raw, 30)
    assert out == [WordTiming("hi", 60, 61)]  # blank skipped; end bumped to start+1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_timing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.timing'`.

- [ ] **Step 3: Write `timing.py`**

`backend/pipeline/timing.py`:
```python
"""Stage 3 — word-level caption timing from the generated voiceover (faster-whisper).

Times against the AUDIO, not the script text, so captions stay in sync.
Run standalone:  python backend/pipeline/timing.py --wav /tmp/vo.wav --fps 30
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

from pipeline.contracts import WordTiming
from pipeline.frames import seconds_to_frames


def words_to_timings(raw_words, fps) -> list[WordTiming]:
    out: list[WordTiming] = []
    for text, start, end in raw_words:
        t = text.strip()
        if not t:
            continue
        sf_ = seconds_to_frames(start, fps)
        ef = seconds_to_frames(end, fps)
        if ef <= sf_:
            ef = sf_ + 1
        out.append(WordTiming(text=t, start_frame=sf_, end_frame=ef))
    return out


def transcribe_words(wav_path, fps, *, model=None) -> list[WordTiming]:
    if model is None:
        from faster_whisper import WhisperModel
        model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav_path), word_timestamps=True, language="en")
    raw = []
    for seg in segments:
        for w in (seg.words or []):
            raw.append((w.word, w.start, w.end))
    return words_to_timings(raw, fps)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args()
    for w in transcribe_words(args.wav, args.fps):
        print(f"[{w.start_frame}-{w.end_frame}] {w.text}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_timing.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Live smoke test (real faster-whisper on the Task 4 wav)**

Run: `backend/.venv/bin/python backend/pipeline/timing.py --wav /tmp/vo_smoke.wav --fps 30`
Expected: prints per-word frame ranges roughly matching "The deep sea is the largest habitat on Earth". First run downloads the `base` model (~150 MB).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/timing.py backend/tests/test_timing.py
git commit -m "feat(pipeline): timing stage — faster-whisper word frames + tests"
```

---

## Task 6: Footage stage (Pexels)

**Files:**
- Create: `backend/pipeline/footage.py`
- Create: `backend/tests/test_footage.py`

- [ ] **Step 1: Write the failing test (file selection + query-keyed cache, fakes)**

`backend/tests/test_footage.py`:
```python
from pipeline.footage import pick_video_file, fetch_footage, query_slug
from pipeline.contracts import Clip


def test_pick_prefers_portrait_mp4_near_1920():
    files = [
        {"link": "land", "width": 1920, "height": 1080, "file_type": "video/mp4"},
        {"link": "tall_sd", "width": 540, "height": 960, "file_type": "video/mp4"},
        {"link": "tall_hd", "width": 1080, "height": 1920, "file_type": "video/mp4"},
    ]
    assert pick_video_file(files) == "tall_hd"


def test_pick_returns_none_when_no_mp4():
    assert pick_video_file([{"link": "x", "width": 1080, "height": 1920, "file_type": "video/webm"}]) is None


def test_fetch_caches_by_query(tmp_path):
    calls = {"search": 0, "download": 0}

    def fake_search(query, key):
        calls["search"] += 1
        return {"videos": [{"video_files": [
            {"link": "u", "width": 1080, "height": 1920, "file_type": "video/mp4"}]}]}

    def fake_download(url, dest):
        calls["download"] += 1
        dest.write_bytes(b"fakevideo")

    lines = ["ocean waves", "ocean waves", "coral reef"]  # dup query
    clips = fetch_footage(lines, tmp_path, key="K", search=fake_search, downloader=fake_download)

    assert len(clips) == 3
    assert calls["download"] == 2          # "ocean waves" downloaded once, reused
    assert clips[0].path == clips[1].path  # same query -> same file
    assert clips[0].path == f"assets/footage_{query_slug('ocean waves')}.mp4"
    assert all(isinstance(c, Clip) for c in clips)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_footage.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.footage'`.

- [ ] **Step 3: Write `footage.py`**

`backend/pipeline/footage.py`:
```python
"""Stage 4 — fetch one portrait stock clip per script line from Pexels.

Caches downloads by query (filename = hash of query) so re-runs don't re-fetch.
Run standalone:  python backend/pipeline/footage.py --line "ocean waves" --out remotion/public/assets
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import hashlib
from pathlib import Path

import requests

from pipeline.config import require_env
from pipeline.contracts import Clip

PEXELS_VIDEO_SEARCH = "https://api.pexels.com/videos/search"


def query_slug(query: str) -> str:
    return hashlib.sha1(query.strip().lower().encode("utf-8")).hexdigest()[:8]


def pick_video_file(video_files):
    """Pick the best portrait mp4: closest height to 1920, taller wins ties."""
    mp4 = [v for v in video_files if v.get("file_type") == "video/mp4"]
    portrait = [v for v in mp4 if v.get("height", 0) >= v.get("width", 0)]
    pool = portrait or mp4
    if not pool:
        return None
    pool.sort(key=lambda v: (abs(v.get("height", 0) - 1920), -v.get("height", 0)))
    return pool[0].get("link")


def search_pexels(query: str, key: str) -> dict:
    r = requests.get(
        PEXELS_VIDEO_SEARCH,
        params={"query": query, "orientation": "portrait", "per_page": 5, "size": "medium"},
        headers={"Authorization": key},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _download(url: str, dest: Path) -> None:
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)


def fetch_footage(lines, out_dir, *, key=None, search=None, downloader=None) -> list[Clip]:
    key = key or require_env("PEXELS_API_KEY")
    search = search or search_pexels
    downloader = downloader or _download
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    clips: list[Clip] = []
    for i, line in enumerate(lines):
        query = line.strip()
        dest = out_dir / f"footage_{query_slug(query)}.mp4"
        if not dest.exists():
            data = search(query, key)
            videos = data.get("videos", [])
            url = pick_video_file(videos[0]["video_files"]) if videos else None
            if not url:
                raise RuntimeError(f"No Pexels portrait video for line {i}: {query!r}")
            downloader(url, dest)
        clips.append(Clip(index=i, query=query, path=f"assets/{dest.name}"))
    return clips


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--line", action="append", required=True, help="repeatable")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    for c in fetch_footage(args.line, args.out):
        print(f"{c.index}: {c.path}  <- {c.query!r}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_footage.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Live smoke test against Pexels (downloads into the real assets dir)**

Run: `backend/.venv/bin/python backend/pipeline/footage.py --line "deep sea creatures" --out remotion/public/assets`
Expected: prints `0: assets/footage_xxxxxxxx.mp4 <- 'deep sea creatures'` and the mp4 exists under `remotion/public/assets/`.

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/footage.py backend/tests/test_footage.py
git commit -m "feat(pipeline): footage stage — Pexels portrait clips, query cache + tests"
```

---

## Task 7: Assemble stage (build & write spec.json) — the contract task

**Files:**
- Create: `backend/pipeline/assemble.py`
- Create: `backend/tests/test_assemble.py`

- [ ] **Step 1: Write the failing test (scene timing + `kenBurns.from` alias + round-trip)**

`backend/tests/test_assemble.py`:
```python
import json
from pipeline.assemble import build_spec, write_spec
from pipeline.contracts import LineOffset, WordTiming, Clip
from schema import Spec


def _fixture():
    offsets = [LineOffset(0, "a", 0.0, 1.0), LineOffset(1, "b", 1.15, 3.15)]
    words = [WordTiming("a", 0, 15), WordTiming("b", 35, 95)]
    clips = [Clip(0, "a", "assets/footage_0.mp4"), Clip(1, "b", "assets/footage_1.mp4")]
    return offsets, words, clips


def test_build_spec_timing_and_structure():
    offsets, words, clips = _fixture()
    spec = build_spec("My Title", offsets, words, clips, fps=30)
    assert spec.meta.durationInFrames == 95          # round(3.15 * 30)
    assert spec.scenes[0].startFrame == 0
    assert spec.scenes[0].durationInFrames == 30     # round(1.0*30) - 0
    assert spec.scenes[1].startFrame == 35           # round(1.15*30)
    assert spec.scenes[1].media.src == "assets/footage_1.mp4"
    assert len(spec.captions) == 2


def test_kenburns_from_alias_serialization():
    offsets, words, clips = _fixture()
    spec = build_spec("T", offsets, words, clips, fps=30)
    data = spec.model_dump(by_alias=True)
    kb = data["scenes"][0]["media"]["kenBurns"]
    assert "from" in kb and "from_" not in kb        # #1 contract gotcha
    assert kb["from"] == 1.0


def test_write_spec_roundtrips_through_schema(tmp_path):
    offsets, words, clips = _fixture()
    spec = build_spec("T", offsets, words, clips, fps=30)
    out = tmp_path / "spec.json"
    write_spec(spec, out)
    loaded = json.loads(out.read_text())
    assert "from" in loaded["scenes"][0]["media"]["kenBurns"]
    Spec.model_validate(loaded)                       # must not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_assemble.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.assemble'`.

- [ ] **Step 3: Write `assemble.py`**

`backend/pipeline/assemble.py`:
```python
"""Stage 5 — assemble all stage outputs into a schema-valid spec.json.

CRITICAL: serialize with model_dump(by_alias=True) so kenBurns.from (not from_)
is emitted — otherwise the Remotion contract breaks.
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import json
from pathlib import Path

from schema import Spec, Meta, Audio, Scene, Media, KenBurns, Caption, Style
from pipeline.frames import seconds_to_frames
from pipeline.contracts import LineOffset, WordTiming, Clip


def build_spec(title, line_offsets, word_timings, clips, *, fps: int = 30, music: str | None = None) -> Spec:
    clips_by_index = {c.index: c for c in clips}
    scenes = []
    for lo in line_offsets:
        start_f = seconds_to_frames(lo.start, fps)
        end_f = seconds_to_frames(lo.end, fps)
        clip = clips_by_index.get(lo.index)
        if clip is None:
            raise ValueError(f"No clip for scene index {lo.index}")
        scenes.append(
            Scene(
                id=f"scene-{lo.index}",
                startFrame=start_f,
                durationInFrames=max(1, end_f - start_f),
                media=Media(type="video", src=clip.path, fit="cover", kenBurns=KenBurns()),
            )
        )

    total_frames = seconds_to_frames(line_offsets[-1].end, fps) if line_offsets else 0
    captions = [
        Caption(text=w.text, startFrame=w.start_frame, endFrame=w.end_frame)
        for w in word_timings
    ]

    return Spec(
        meta=Meta(title=title, fps=fps, width=1080, height=1920, durationInFrames=total_frames),
        audio=Audio(voiceover="assets/voiceover.wav", music=music, musicVolumeDb=-18.0),
        scenes=scenes,
        captions=captions,
        style=Style(),
    )


def write_spec(spec: Spec, path) -> None:
    data = spec.model_dump(by_alias=True)
    Path(path).write_text(json.dumps(data, indent=2), encoding="utf-8")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_assemble.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/assemble.py backend/tests/test_assemble.py
git commit -m "feat(pipeline): assemble stage — build/write spec.json (by_alias) + tests"
```

---

## Task 8: Orchestrator CLI (`main.py`)

**Files:**
- Create: `backend/main.py`

- [ ] **Step 1: Write `main.py`**

`backend/main.py`:
```python
"""Faceless video generator — Phase 4 pipeline orchestrator.

Usage:  python backend/main.py --topic "3 facts about deep sea creatures"
Runs: script -> tts -> timing -> footage -> assemble, writing spec.json at the repo root.
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import argparse
from pathlib import Path

from pipeline import script as script_stage
from pipeline import tts as tts_stage
from pipeline import timing as timing_stage
from pipeline import footage as footage_stage
from pipeline import assemble as assemble_stage

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "remotion" / "public" / "assets"
SPEC_OUT = REPO_ROOT / "spec.json"
DEFAULT_FPS = 30


def run(topic: str, fps: int = DEFAULT_FPS):
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    voiceover = ASSETS_DIR / "voiceover.wav"

    print("[1/5] script (LLM)...")
    result = script_stage.generate_script(topic)
    title, lines = result["title"], result["lines"]
    print(f"      title={title!r}  lines={len(lines)}")

    print("[2/5] tts (Kokoro)...")
    offsets = tts_stage.synthesize(lines, voiceover)

    print("[3/5] timing (faster-whisper)...")
    words = timing_stage.transcribe_words(str(voiceover), fps)
    print(f"      {len(words)} words timed")

    print("[4/5] footage (Pexels)...")
    clips = footage_stage.fetch_footage(lines, ASSETS_DIR)

    print("[5/5] assemble -> spec.json...")
    spec = assemble_stage.build_spec(title, offsets, words, clips, fps=fps)
    assemble_stage.write_spec(spec, SPEC_OUT)
    print(f"      wrote {SPEC_OUT}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
    return spec


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS)
    args = ap.parse_args()
    run(args.topic, args.fps)
```

- [ ] **Step 2: Verify imports resolve (no run)**

Run: `backend/.venv/bin/python backend/main.py --help`
Expected: argparse help with `--topic` and `--fps`, no import errors.

- [ ] **Step 3: Commit**

```bash
git add backend/main.py
git commit -m "feat(pipeline): main.py orchestrator CLI wiring all five stages"
```

---

## Task 9: Integration — point the renderer & preview at the generated `spec.json`

Switch the served spec from `sample-spec.json` to the generated `spec.json`, with a `sample-spec.json` fallback so Phases 1–3 still work when no real spec exists yet. Source is overridable via `SPEC_PATH`.

**Files:**
- Create: `remotion/scripts/copy-spec.mjs`
- Modify: `remotion/package.json:7` (copy-spec script)
- Modify: `remotion/src/Root.tsx:14` (`SPEC_PUBLIC_PATH`)
- Modify: `preview/scripts/copy-assets.mjs:27-37` (spec section)
- Modify: `preview/components/Studio.tsx:26,34,111` (fetch path + messages)

- [ ] **Step 1: Create `remotion/scripts/copy-spec.mjs`**

```javascript
// Stage the generated spec into public/ for the renderer. Prefers the real
// spec.json (override via SPEC_PATH), falls back to sample-spec.json so the
// Phase 1-3 skeleton still renders. Dest is always public/spec.json.
import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const remotionRoot = resolve(__dirname, '..');
const repoRoot = resolve(remotionRoot, '..');

const override = process.env.SPEC_PATH ? resolve(repoRoot, process.env.SPEC_PATH) : null;
const generated = resolve(repoRoot, 'spec.json');
const sample = resolve(repoRoot, 'sample-spec.json');
const src = [override, generated, sample].find((p) => p && existsSync(p));

if (!src) {
  console.error('[copy-spec] no spec.json or sample-spec.json found');
  process.exit(1);
}

const publicDir = resolve(remotionRoot, 'public');
mkdirSync(publicDir, {recursive: true});
copyFileSync(src, resolve(publicDir, 'spec.json'));
console.log(`[copy-spec] ${src} -> public/spec.json`);
```

- [ ] **Step 2: Update `remotion/package.json` copy-spec script**

Replace line 7:
```json
    "copy-spec": "node -e \"require('fs').copyFileSync('../sample-spec.json','public/sample-spec.json')\"",
```
with:
```json
    "copy-spec": "node scripts/copy-spec.mjs",
```

- [ ] **Step 3: Update `remotion/src/Root.tsx`**

Change line 14 from:
```ts
const SPEC_PUBLIC_PATH = 'sample-spec.json';
```
to:
```ts
const SPEC_PUBLIC_PATH = 'spec.json';
```

- [ ] **Step 4: Update the spec section of `preview/scripts/copy-assets.mjs`**

Replace the block (currently lines 27-37, from `const srcSpec = ...` through its closing `}`):
```javascript
const override = process.env.SPEC_PATH ? resolve(repoRoot, process.env.SPEC_PATH) : null;
const specCandidates = [override, resolve(repoRoot, 'spec.json'), resolve(repoRoot, 'sample-spec.json')];
const srcSpec = specCandidates.find((p) => p && existsSync(p));
const dstSpec = resolve(previewPublic, 'spec.json');
if (srcSpec) {
  copyFileSync(srcSpec, dstSpec);
  console.log(`[copy-assets] ${srcSpec} -> ${dstSpec}`);
} else {
  console.warn('[copy-assets] WARN: no spec.json or sample-spec.json found');
}
```

- [ ] **Step 5: Update `preview/components/Studio.tsx`**

- Line 26: change `fetch('/sample-spec.json', {signal: ac.signal})` → `fetch('/spec.json', {signal: ac.signal})`.
- Line 34: change the log message `'Failed to load sample-spec.json:'` → `'Failed to load spec.json:'`.
- Line 111: change the user-facing text `Could not load sample-spec.json. Run{' '}` → `Could not load spec.json. Run{' '}`.

- [ ] **Step 6: Verify the renderer still type-checks and copy-spec works**

Run (with node on PATH):
```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
cd remotion && npm run copy-spec && npm run typecheck && cd ..
cd preview && npm run copy-assets && npm run typecheck && cd ..
```
Expected: `copy-spec` logs `-> public/spec.json` (using `sample-spec.json` fallback if no real spec yet); both typechecks pass.

- [ ] **Step 7: Commit**

```bash
git add remotion/scripts/copy-spec.mjs remotion/package.json remotion/src/Root.tsx preview/scripts/copy-assets.mjs preview/components/Studio.tsx
git commit -m "feat: serve generated spec.json (SPEC_PATH override, sample-spec fallback)"
```

---

## Task 10: End-to-end run + validation

**Files:** none (verification task)

- [ ] **Step 1: Full unit-test pass**

Run: `python -m pytest backend/tests -v`
Expected: all tests pass (frames, config, script, tts, timing, footage, assemble).

- [ ] **Step 2: Run the whole pipeline on the acceptance topic**

Run: `backend/.venv/bin/python backend/main.py --topic "3 facts about deep sea creatures"`
Expected: prints `[1/5]`…`[5/5]`, writes `spec.json` at repo root and assets (`voiceover.wav`, `footage_*.mp4`) in `remotion/public/assets/`.

- [ ] **Step 3: Validate the generated spec against the contract**

Run: `backend/.venv/bin/python backend/schema.py spec.json`
Expected: `OK: spec.json is a valid Spec — N scenes, M captions, F frames @ 30fps (1080x1920)`.

- [ ] **Step 4: Confirm the `kenBurns.from` alias landed in the real output**

Run: `backend/.venv/bin/python -c "import json; d=json.load(open('spec.json')); kb=d['scenes'][0]['media']['kenBurns']; print('from' in kb, 'from_' not in kb)"`
Expected: `True True`.

- [ ] **Step 5: (Optional) stage the spec into the renderer and render a still**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
cd remotion && npm run copy-spec && npx remotion still Video out/frame.png --frame=30 && cd ..
```
Expected: `out/frame.png` shows footage + a caption, confirming the generated spec drives the renderer end-to-end.

- [ ] **Step 6: STOP for user verification**

Per the phased-build mandate, stop here and report results to the user for end-to-end verification before Phase 5. Update the project memory: Phase 4 done, resume at Phase 5 (preview "Generate" button → backend wiring + full E2E).

---

## Self-review notes

- **Spec coverage:** script/tts/timing/footage/assemble (design §"Stage modules") → Tasks 3–7; env setup + espeak-ng (design §"Environment setup") → Task 0; `by_alias` contract gotcha → Task 7; `SPEC_PATH` generalization of copy-spec/copy-assets → Task 9; pluggable `LLM_PROVIDER` → Task 3; live + unit testing strategy (design §"Error handling & testing") → per-task tests + Task 10. All covered.
- **Type consistency:** `LineOffset(index,text,start,end)`, `WordTiming(text,start_frame,end_frame)`, `Clip(index,query,path)` defined in Task 1 and used identically in Tasks 4–7. `generate_script`/`synthesize`/`transcribe_words`/`fetch_footage`/`build_spec`/`write_spec` signatures consistent between definition and `main.py` (Task 8). `seconds_to_frames(seconds,fps)` used uniformly. `query_slug` defined and asserted in Task 6.
- **No placeholders:** every code/test step contains complete code and exact run commands with expected output.
