# backend/pipeline/projects.py
"""Project library — per-session snapshot directories under projects/<sid>/.

A "project" IS a session (the sid the pipeline already mints). Each session's
render contract (spec.json), grounding sidecar (sources.json), list sidecar
(meta.json) and — after a render — video.mp4 live in projects/<sid>/. Media stays
in the shared content-addressed assets pool; the per-session voiceover is
namespaced (voiceover_<sid>.wav) so it is never overwritten, which is what makes
pixel-perfect re-preview possible. No id minting here: the sid is the id.
"""
from __future__ import annotations

import json
from pathlib import Path


def projects_root(repo_root: Path) -> Path:
    return Path(repo_root) / "projects"


def project_dir(repo_root: Path, sid: str) -> Path:
    return projects_root(repo_root) / sid


def project_spec_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "spec.json"


def project_sources_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "sources.json"


def project_meta_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "meta.json"


def project_video_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "video.mp4"


def voiceover_name(sid: str) -> str:
    return f"voiceover_{sid}.wav"


def project_voice_path(repo_root: Path, sid: str) -> Path:
    """Studio v2 Voice gate sidecar: {voice, speed}. Persists the operator's voice
    choice so a later resume (or a script edit that re-derives voice) keeps it."""
    return project_dir(repo_root, sid) / "voice.json"


def read_voice(repo_root: Path, sid: str, *, default_voice="af_heart", default_speed=1.0) -> dict:
    p = project_voice_path(repo_root, sid)
    if not p.exists():
        return {"voice": default_voice, "speed": default_speed}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return {"voice": d.get("voice", default_voice), "speed": float(d.get("speed", default_speed))}
    except (ValueError, OSError):
        return {"voice": default_voice, "speed": default_speed}


def write_voice(repo_root: Path, sid: str, *, voice: str, speed: float) -> Path:
    d = project_dir(repo_root, sid)
    d.mkdir(parents=True, exist_ok=True)
    out = d / "voice.json"
    out.write_text(json.dumps({"voice": voice, "speed": speed}, indent=2), encoding="utf-8")
    return out


def write_meta(repo_root: Path, sid: str, *, meta: dict) -> Path:
    d = project_dir(repo_root, sid)
    d.mkdir(parents=True, exist_ok=True)
    out = d / "meta.json"
    out.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return out
