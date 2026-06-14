# backend/tests/test_projects.py
import json
from pathlib import Path

from pipeline import projects
from pipeline.content import Beat, BeatsScript, Source, HookCandidate


def test_project_dir_under_projects_root():
    root = Path("/repo")
    assert projects.project_dir(root, "auto-abc") == Path("/repo/projects/auto-abc")


def test_spec_sources_meta_video_paths():
    root = Path("/repo")
    d = root / "projects" / "auto-abc"
    assert projects.project_spec_path(root, "auto-abc") == d / "spec.json"
    assert projects.project_sources_path(root, "auto-abc") == d / "sources.json"
    assert projects.project_meta_path(root, "auto-abc") == d / "meta.json"
    assert projects.project_video_path(root, "auto-abc") == d / "video.mp4"


def test_voiceover_name_namespaced():
    assert projects.voiceover_name("auto-abc") == "voiceover_auto-abc.wav"


def test_write_meta_writes_one_file(tmp_path: Path):
    out = projects.write_meta(
        tmp_path, "auto-abc",
        meta={"id": "auto-abc", "title": "X", "createdAt": 123},
    )
    assert out == tmp_path / "projects" / "auto-abc" / "meta.json"
    loaded = json.loads(out.read_text())
    assert loaded["id"] == "auto-abc"
    assert loaded["title"] == "X"


def test_write_meta_creates_project_dir(tmp_path: Path):
    projects.write_meta(tmp_path, "auto-abc", meta={"id": "auto-abc"})
    assert (tmp_path / "projects" / "auto-abc").is_dir()


# ── v3-M1: bootstrap + write_sources (ruling 2A) ────────────────────────────

def test_bootstrap_creates_dir_and_meta_stub(tmp_path: Path):
    """bootstrap() creates the project dir and writes an initial meta.json stub
    with exactly {id, topic, createdAt} — matching what main.py's old inline
    block produced before the refactor."""
    t_before = projects._epoch_ms()
    d = projects.bootstrap(tmp_path, "v3-xyz", topic="Deep sea")
    t_after = projects._epoch_ms()

    assert d == tmp_path / "projects" / "v3-xyz"
    assert d.is_dir()

    meta_path = d / "meta.json"
    assert meta_path.exists()
    meta = json.loads(meta_path.read_text())
    assert meta["id"] == "v3-xyz"
    assert meta["topic"] == "Deep sea"
    assert t_before <= meta["createdAt"] <= t_after
    # stub must NOT have title/duration (those are written by write_meta() later)
    assert "title" not in meta
    assert "durationInFrames" not in meta


def test_bootstrap_idempotent_on_existing_dir(tmp_path: Path):
    """bootstrap() must not fail if the project dir already exists."""
    projects.bootstrap(tmp_path, "v3-xyz", topic="First")
    projects.bootstrap(tmp_path, "v3-xyz", topic="Second")  # must not raise
    meta = json.loads((tmp_path / "projects" / "v3-xyz" / "meta.json").read_text())
    assert meta["topic"] == "Second"


def test_bootstrap_then_write_meta_produces_full_record(tmp_path: Path):
    """main.py calls bootstrap() first, then write_meta() to overwrite the stub;
    the final meta.json is behavior-identical to the old inline block."""
    projects.bootstrap(tmp_path, "auto-abc", topic="Reefs")
    projects.write_meta(tmp_path, "auto-abc", meta={
        "id": "auto-abc",
        "topic": "Reefs",
        "title": "All About Reefs",
        "createdAt": 9999,
        "durationInFrames": 120,
        "fps": 30,
    })
    meta = json.loads((tmp_path / "projects" / "auto-abc" / "meta.json").read_text())
    assert meta["title"] == "All About Reefs"
    assert meta["durationInFrames"] == 120


def _fake_script():
    return BeatsScript(
        title="Deep Sea",
        beats=[
            Beat(text="Intro"),
            Beat(text="90% unmapped", source="https://noaa.gov/x"),
        ],
        sources=[Source(url="https://noaa.gov/x", title="NOAA")],
        hook_candidates=[
            HookCandidate(text="90% unmapped!", pattern="stat", score=5.0, chosen=True),
        ],
        verify_report=[{"text": "90% unmapped", "verdict": "kept"}],
    )


def test_write_sources_round_trips_script(tmp_path: Path):
    """write_sources() creates sources.json with the correct sidecar shape."""
    projects.bootstrap(tmp_path, "v3-src", topic="Deep sea")
    out = projects.write_sources(tmp_path, "v3-src", _fake_script())

    assert out == tmp_path / "projects" / "v3-src" / "sources.json"
    data = json.loads(out.read_text())
    assert data["title"] == "Deep Sea"
    assert data["facts"] == [{"text": "90% unmapped", "source": "https://noaa.gov/x"}]
    assert data["sources"] == [{"url": "https://noaa.gov/x", "title": "NOAA"}]
    assert data["hooks"][0]["chosen"] is True
    assert data["verification"] == [{"text": "90% unmapped", "verdict": "kept"}]


def test_write_sources_ungrounded_script(tmp_path: Path):
    """write_sources() handles a plain script with no sources/hooks."""
    projects.bootstrap(tmp_path, "v3-bare", topic="X")
    out = projects.write_sources(tmp_path, "v3-bare", BeatsScript(title="T", beats=[Beat(text="a")]))
    data = json.loads(out.read_text())
    assert data["facts"] == [] and data["sources"] == [] and data["hooks"] == []
