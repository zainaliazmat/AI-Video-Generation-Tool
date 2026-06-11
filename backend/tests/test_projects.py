# backend/tests/test_projects.py
import json
from pathlib import Path

from pipeline import projects


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
