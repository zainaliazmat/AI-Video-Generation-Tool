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


def test_build_state_shape(tmp_path, monkeypatch):
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    conn.close()
    import session_state as ss
    # point the CLI at the seed's DB + spec via monkeypatched job_ctx constants
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    state = ss.build_state(sid)

    assert state["sid"] == sid
    scenes = state["scenes"]
    # footage scene (index 1) has a non-empty candidate pool with the documented fields
    foot = next(s for s in scenes if s["needsFootage"])
    assert foot["index"] == 1
    cand = foot["candidates"]
    assert cand and {"rank", "thumbUrl", "durationFrames", "selected"} <= cand[0].keys()
    assert any(c["selected"] for c in cand)           # exactly the auto pick is selected
    assert foot["provenance"]["source"] == "auto"
    # a non-footage scene reports needsFootage False + empty pool
    nonfoot = next(s for s in scenes if not s["needsFootage"])
    assert nonfoot["candidates"] == []


def test_build_state_bad_sid_raises(tmp_path, monkeypatch):
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    import session_state as ss
    import pytest
    # empty db (no such session) → KeyError
    with pytest.raises(KeyError):
        ss.build_state("nope")


def test_apply_pick_rebinds_and_returns_selection(tmp_path, monkeypatch):
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    media0 = spec0["scenes"][1]["templateProps"]["media"]["src"]
    conn.close()

    # point the CLI's ctx + db at the seed (build_ctx reads job_ctx constants)
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.SOURCES_OUT", tmp_path / "src.json")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")

    import session_edit as se
    res = se.apply_pick(sid, scene=1, rank=2)

    assert res["ok"] is True and res["scene"] == 1 and res["selectedRank"] == 2
    assert res["provenance"]["source"] == "pick" and res["provenance"]["rank"] == 2
    spec1 = json.loads((tmp_path / "spec.json").read_text())
    media1 = spec1["scenes"][1]["templateProps"]["media"]["src"]
    assert media1 != media0 and "_2." in media1   # rank-2 clip bound + spec re-materialized
    # timing unchanged (footage edit invariant)
    t0 = [(s["startFrame"], s["durationInFrames"]) for s in spec0["scenes"]]
    t1 = [(s["startFrame"], s["durationInFrames"]) for s in spec1["scenes"]]
    assert t0 == t1


def test_apply_pick_fails_loud(tmp_path, monkeypatch):
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    conn.close()
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.SOURCES_OUT", tmp_path / "src.json")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")
    import session_edit as se
    import pytest
    with pytest.raises(Exception):          # unknown rank → engine raises
        se.apply_pick(sid, scene=1, rank=99)
    with pytest.raises(KeyError):           # bad sid → resume raises
        se.apply_pick("nope", scene=1, rank=1)


def _point_ctx_at_seed(tmp_path, monkeypatch):
    """Aim the CLI's job_ctx constants at the seeded session's tmp paths."""
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.SOURCES_OUT", tmp_path / "src.json")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")


def test_apply_requery_rebinds_and_stamps(tmp_path, monkeypatch):
    """A.6.2 — re_query via the CLI rebinds to the new pool's top hit, stamps
    source='re_query', and preserves timing. The pool is re-fetched (replaced)."""
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    media0 = spec0["scenes"][1]["templateProps"]["media"]["src"]
    conn.close()
    _point_ctx_at_seed(tmp_path, monkeypatch)
    # the re-query returns a FRESH pool regardless of the hardened query string
    fresh = [{"duration": 7, "video_files": [{"link": "fresh.mp4", "width": 1080, "height": 1920,
              "file_type": "video/mp4"}], "video_pictures": [{"picture": "tn"}]}]
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": fresh})

    import session_edit as se
    res = se.apply_requery(sid, scene=1, query="vivid coral macro")

    assert res["ok"] is True and res["scene"] == 1
    assert res["provenance"]["source"] == "re_query"
    spec1 = json.loads((tmp_path / "spec.json").read_text())
    media1 = spec1["scenes"][1]["templateProps"]["media"]["src"]
    assert media1 != media0                                   # rebound to the fresh clip
    t0 = [(s["startFrame"], s["durationInFrames"]) for s in spec0["scenes"]]
    t1 = [(s["startFrame"], s["durationInFrames"]) for s in spec1["scenes"]]
    assert t0 == t1                                           # footage-edit timing invariant


def test_apply_upload_binds_and_stamps(tmp_path, monkeypatch):
    """A.6.3 — upload via the CLI binds the user file, stamps source='uploaded'
    (rank None), and emits the right Media.type."""
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    conn.close()
    _point_ctx_at_seed(tmp_path, monkeypatch)
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds", lambda path, run=None: 2.0)
    f = tmp_path / "My Clip.mp4"
    f.write_bytes(b"VIDEOBYTES")

    import session_edit as se
    res = se.apply_upload(sid, scene=1, file=str(f))

    assert res["ok"] is True and res["scene"] == 1
    assert res["selectedRank"] is None                        # an upload is not a pool rank
    assert res["provenance"]["source"] == "uploaded"
    assert res["provenance"]["query"] == "My Clip.mp4"
    spec1 = json.loads((tmp_path / "spec.json").read_text())
    media = spec1["scenes"][1]["templateProps"]["media"]
    assert media["type"] == "video" and "footage_upload_" in media["src"]


def test_apply_upload_bad_extension_fails_loud(tmp_path, monkeypatch):
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    conn.close()
    _point_ctx_at_seed(tmp_path, monkeypatch)
    f = tmp_path / "notes.txt"
    f.write_bytes(b"x")
    import session_edit as se
    import pytest
    with pytest.raises(ValueError, match="unsupported upload extension"):
        se.apply_upload(sid, scene=1, file=str(f))
