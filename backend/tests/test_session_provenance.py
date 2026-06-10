"""HITL A.2a — per-scene media provenance is stamped to the session DB (source/query/
rank/pexels id+url): `auto` on a footage advance, `pick`/`re_query` on a gate edit.
spec.json is unaffected (proven separately in test_session_autopilot_golden.py)."""
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import store, engine, executors

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _seed(tmp_path, monkeypatch):
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

    def _vid(link, dur, pid, purl):
        return {"id": pid, "url": purl, "duration": dur,
                "video_files": [{"link": link, "width": 1080, "height": 1920,
                                 "file_type": "video/mp4"}],
                "video_pictures": [{"picture": f"thumb-{pid}"}]}

    pools = {
        "coral reef": [_vid("first.mp4", 6, 101, "https://pexels.com/v/101"),
                       _vid("second.mp4", 9, 102, "https://pexels.com/v/102")],
        "reef shark": [_vid("shark.mp4", 7, 201, "https://pexels.com/v/201")],
    }
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": pools.get(q, [])})
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


def test_autopilot_stamps_auto_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "auto", "query": "coral reef", "rank": 1,
                       "pexels_id": 101, "pexels_url": "https://pexels.com/v/101"}
    conn.close()


def test_stamp_auto_records_unknown_origin_for_legacy_clip(tmp_path, monkeypatch):
    # A clip with no surfaced provenance (legacy pre-sidecar cache) is recorded as
    # "auto, origin unknown" (rank/pexels None) rather than leaving no row — the
    # deliberate §4 choice, not a guard side effect.
    conn, eng = _seed(tmp_path, monkeypatch)
    eng._stamp_auto_provenance({"clips": [
        Clip(index=1, query="q", path="assets/x.mp4", duration_frames=180)]})
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1]["source"] == "auto" and prov[1]["rank"] is None and prov[1]["pexels_id"] is None
    conn.close()


def test_pick_stamps_pick_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    eng.edit("footage", {"op": "pick", "scene_index": 1, "rank": 2})
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "pick", "query": "coral reef", "rank": 2,
                       "pexels_id": 102, "pexels_url": "https://pexels.com/v/102"}
    conn.close()


def test_requery_stamps_requery_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    eng.edit("footage", {"op": "re_query", "scene_index": 1, "query": "reef shark"})
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "re_query", "query": "reef shark", "rank": 1,
                       "pexels_id": 201, "pexels_url": "https://pexels.com/v/201"}
    conn.close()


def test_api_media_provenance_getter(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    from session import api
    sess = api.Session(conn=conn, engine=eng, id="s1")
    prov = api.media_provenance(sess)
    assert prov[1]["source"] == "auto" and prov[1]["rank"] == 1 and prov[1]["pexels_id"] == 101
    conn.close()
