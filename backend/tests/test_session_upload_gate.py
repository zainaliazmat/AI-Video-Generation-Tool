"""HITL A.2b — the upload gate: an upload edit binds a user file (video OR image)
to a footage scene, emits the right Media.type/loop, stamps source='uploaded',
leaves timing + the Pexels pool untouched, and fails loud on bad input.

Offline: ffprobe is faked via media_probe.ffprobe_duration_seconds monkeypatch;
uploaded files are tmp_path bytes. Reuses the footage-gate seed shape."""
import json
from pathlib import Path

import pytest

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming
from pipeline import validate as validate_stage
from session import store, engine, executors

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _seed(tmp_path, monkeypatch):
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1))
                                              for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])
    pool = {"coral reef": [
        {"duration": 6, "video_files": [{"link": "first.mp4", "width": 1080, "height": 1920,
                                         "file_type": "video/mp4"}], "video_pictures": [{"picture": "t1"}]},
        {"duration": 9, "video_files": [{"link": "second.mp4", "width": 1080, "height": 1920,
                                         "file_type": "video/mp4"}], "video_pictures": [{"picture": "t2"}]},
    ]}
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": pool.get(q, [])})
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog, assets_dir=tmp_path / "a",
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.run_all()
    return conn, eng


def _scene1_media(tmp_path):
    spec = json.loads((tmp_path / "spec.json").read_text())
    return spec["scenes"][1]["templateProps"]["media"]


def test_upload_video_binds_kind_video_loops_and_stamps_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    timing0 = [(s["startFrame"], s["durationInFrames"]) for s in spec0["scenes"]]
    pool_before = store.get_footage_candidates(conn, "s1", scene_index=1)

    # a 0.1s video (3 frames at 30fps) — shorter than scene-1's span → loops
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds",
                        lambda path, run=None: 0.1)
    f = tmp_path / "Beach Clip.mp4"
    f.write_bytes(b"VIDEOBYTES")
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})

    media = _scene1_media(tmp_path)
    assert media["type"] == "video"
    assert media["loop"] is True               # 3-frame clip < scene span
    assert "footage_upload_s1_beach-clip_" in media["src"]
    assert media["src"].endswith(".mp4")

    # timing unchanged; pool untouched
    spec1 = json.loads((tmp_path / "spec.json").read_text())
    assert [(s["startFrame"], s["durationInFrames"]) for s in spec1["scenes"]] == timing0
    assert store.get_footage_candidates(conn, "s1", scene_index=1) == pool_before

    prov = store.get_media_provenance(conn, "s1")[1]
    assert prov == {"source": "uploaded", "query": "Beach Clip.mp4",
                    "rank": None, "pexels_id": None, "pexels_url": None}
    conn.close()


def test_upload_image_binds_kind_image_no_loop(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)

    # ffprobe must NOT be called for an image — make it explode if it is
    def _boom(path, run=None):
        raise AssertionError("ffprobe must not run for an image upload")
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds", _boom)

    f = tmp_path / "sunset.png"
    f.write_bytes(b"PNGBYTES")
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})

    media = _scene1_media(tmp_path)
    assert media["type"] == "image"
    assert media["loop"] is False
    assert media["src"].endswith(".png")
    assert store.get_media_provenance(conn, "s1")[1]["source"] == "uploaded"
    conn.close()


def test_upload_missing_file_fails_loud(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    with pytest.raises(RuntimeError, match="file not found"):
        eng.edit("footage", {"op": "upload", "scene_index": 1,
                             "file": str(tmp_path / "nope.mp4")})
    conn.close()


def test_upload_bad_extension_fails_loud(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    f = tmp_path / "notes.txt"
    f.write_bytes(b"x")
    with pytest.raises(ValueError, match="unsupported upload extension"):
        eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    conn.close()


def test_upload_unprobeable_video_fails_loud(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)

    def _fail(path, run=None):
        raise RuntimeError("ffprobe failed (exit 1)")
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds", _fail)
    f = tmp_path / "broken.mp4"
    f.write_bytes(b"x")
    with pytest.raises(RuntimeError, match="ffprobe failed"):
        eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    conn.close()


def test_upload_to_scene_without_clip_fails_loud(tmp_path, monkeypatch):
    # The footage scene is index 1; scenes 0 and 2 are non-footage (hook/outro) and
    # have no clip. Uploading to a hero scene without target:'background' must fail loud.
    # v3 M5 T6: the hero guard fires first with a clear ValueError telling the caller
    # to use target:'background' — a more informative error than the old "no footage clip".
    conn, eng = _seed(tmp_path, monkeypatch)
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds",
                        lambda path, run=None: 2.0)
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"DATA")
    with pytest.raises(ValueError, match="hero"):
        eng.edit("footage", {"op": "upload", "scene_index": 0, "file": str(f)})
    conn.close()


def test_upload_same_content_is_idempotent_on_disk(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds",
                        lambda path, run=None: 2.0)
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"SAME")
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    staged = sorted((tmp_path / "a").glob("footage_upload_*"))
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    assert sorted((tmp_path / "a").glob("footage_upload_*")) == staged  # no duplicate
    conn.close()
