"""A.6 — lightweight EngineContext builder for the session CLI entrypoints.

Mirrors main.py's REPO_ROOT-relative paths so a resumed session writes spec.json
exactly where the preview reads it. Deliberately imports only the cheap modules
(no pipeline.tts / torch) so a state read / pick edit starts fast.
"""
from __future__ import annotations

from pathlib import Path

from schema import Theme
from pipeline import validate as validate_stage
from pipeline import projects as projects_mod
from session.executors import EngineContext

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_DIR = REPO_ROOT / "remotion" / "public" / "assets"
TEMPLATES_DIR = REPO_ROOT / "templates"
SPEC_OUT = REPO_ROOT / "spec.json"
SOURCES_OUT = REPO_ROOT / "sources.json"
RETRIEVAL_CACHE = REPO_ROOT / ".cache" / "retrieval"
SESSIONS_DB = REPO_ROOT / "backend" / ".sessions" / "sessions.db"


def build_ctx(*, topic: str, fps: int = 30, sid: str | None = None,
              voice: str | None = None, speed: float | None = None,
              extra_user_block: str = "", target_length: int = 60) -> EngineContext:
    spd = 1.0
    if sid is None:
        spec_out, sources_out, voiceover_path = SPEC_OUT, SOURCES_OUT, ASSETS_DIR / "voiceover.wav"
        vc = voice or "af_heart"
    else:
        spec_out = projects_mod.project_spec_path(REPO_ROOT, sid)
        sources_out = projects_mod.project_sources_path(REPO_ROOT, sid)
        voiceover_path = ASSETS_DIR / projects_mod.voiceover_name(sid)
        # explicit arg wins; otherwise load the persisted sidecar choice
        saved = projects_mod.read_voice(REPO_ROOT, sid)
        vc = voice or saved["voice"]
        spd = speed if speed is not None else saved["speed"]
    return EngineContext(
        topic=topic, fps=fps, theme=Theme(),
        catalog=validate_stage.load_catalog(TEMPLATES_DIR),
        assets_dir=ASSETS_DIR, cache_dir=RETRIEVAL_CACHE,
        voiceover_path=voiceover_path,
        spec_out=spec_out, sources_out=sources_out,
        voice=vc, speed=spd, extra_user_block=extra_user_block,
        target_length=target_length)


STYLE_MEMORY_PATH = REPO_ROOT / "style_memory.json"
