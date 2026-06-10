"""HITL A.6.1 — session CLI entrypoints (state read + pick edit) and the sid emit."""
import json
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming
from pipeline import validate as validate_stage
from session import store, executors, engine


def _seed_session(tmp_path, monkeypatch, *, sid="s-cli"):
    """A real cold session via the engine with faked upstream stages (offline).
    Footage scene is beat index 1 ('mid', keyword 'coral reef')."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None: script)
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

    catalog = validate_stage.load_catalog(Path(__file__).resolve().parents[2] / "templates")
    ctx = executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog, assets_dir=tmp_path / "a",
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    eng.run_all()
    return conn, ctx, sid


def test_run_emits_session_id(tmp_path, monkeypatch):
    import main as m
    # fake the stages main.run drives (same shapes as the seed) + redirect output paths
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script", lambda topic, cache_dir=None: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1))
                                              for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])
    pool = {"coral reef": [{"duration": 6, "video_files": [{"link": "f.mp4", "width": 1080,
            "height": 1920, "file_type": "video/mp4"}], "video_pictures": [{"picture": "t"}]}]}
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": pool.get(q, [])})
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr(m, "ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr(m, "SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr(m, "SOURCES_OUT", tmp_path / "src.json")
    monkeypatch.setattr(m, "SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr(m, "RETRIEVAL_CACHE", tmp_path / "c")

    events = []
    m.run("Reefs", on_stage=lambda key, state: events.append((key, state)))
    sid_events = [v for (k, v) in events if k == "session"]
    assert len(sid_events) == 1
    assert sid_events[0].startswith("auto-")


def test_job_ctx_paths_match_main():
    import main as m
    from session import job_ctx
    ctx = job_ctx.build_ctx(topic="X", fps=30)
    assert ctx.spec_out == m.SPEC_OUT
    assert ctx.assets_dir == m.ASSETS_DIR
    assert ctx.sources_out == m.SOURCES_OUT
    assert ctx.cache_dir == m.RETRIEVAL_CACHE
    assert ctx.topic == "X" and ctx.fps == 30
    assert ctx.catalog  # templates loaded
