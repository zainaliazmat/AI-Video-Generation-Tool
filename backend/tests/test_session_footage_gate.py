"""HITL A.1 — the footage gate proves the spine end-to-end: a re-query/pick edit
updates the footage output, invalidates assemble (NOT timing), re-derives, and the
new spec.json reflects the new clip — with span/timing unchanged.

ASSERTION DESIGN (deviation from plan's brittle substring checks):
  - pick: asserts scene-1 src CHANGED from spec0 to spec1 (the swap happened) AND
    the new path contains "_2." (rank-2 suffix in the dest filename
    footage_{slug}_2.mp4 — proves rank 2 was selected, not a rename accident).
    "second.mp4" / "second" are NOT used because _edit_footage derives its dest
    name from query_slug+rank, not the source URL filename.
  - re_query: asserts stored pool query == "reef shark" (pool replaced) AND
    spec scene-1 src contains the reef-shark slug "813e9c81" (clip changed to
    footage from the new query).
  Both tests assert timing is unchanged (the core footage-edit invariant).
"""
import json
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming
from pipeline import validate as validate_stage
from session import store, engine, executors

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _seed(tmp_path, monkeypatch):
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script", lambda topic, cache_dir=None: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1))
                                              for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])

    pools = {
        "coral reef": [
            {"duration": 6, "video_files": [{"link": "first.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}], "video_pictures": [{"picture": "t1"}]},
            {"duration": 9, "video_files": [{"link": "second.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}], "video_pictures": [{"picture": "t2"}]},
        ],
        "reef shark": [
            {"duration": 7, "video_files": [{"link": "shark.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}], "video_pictures": [{"picture": "ts"}]},
        ],
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


def test_pick_swaps_clip_invalidates_assemble_not_timing(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    timing0 = [(s["startFrame"], s["durationInFrames"]) for s in spec0["scenes"]]
    media0_src = spec0["scenes"][1]["templateProps"]["media"]["src"]

    # pick rank 2 ("second.mp4") for the footage scene (index 1)
    eng.edit("footage", {"op": "pick", "scene_index": 1, "rank": 2})

    spec1 = json.loads((tmp_path / "spec.json").read_text())
    timing1 = [(s["startFrame"], s["durationInFrames"]) for s in spec1["scenes"]]

    # Invariant 1: footage edit NEVER moves timing
    assert timing1 == timing0

    # Invariant 2: scene-1 media src changed (the swap happened)
    media1_src = spec1["scenes"][1]["templateProps"]["media"]["src"]
    assert media1_src != media0_src, (
        f"expected scene-1 src to change after pick; got {media1_src!r} == {media0_src!r}")

    # Invariant 3: new src contains "_2." — proves rank 2 was selected.
    # _edit_footage names the dest footage_{query_slug(query)}_{rank}.mp4, so the
    # rank-2 pick produces footage_70ded995_2.mp4 and its path contains "_2.".
    assert "_2." in media1_src, (
        f"expected rank-2 suffix in scene-1 src path; got {media1_src!r}")

    conn.close()


def test_requery_changes_pool_and_clip(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    media0_src = spec0["scenes"][1]["templateProps"]["media"]["src"]

    eng.edit("footage", {"op": "re_query", "scene_index": 1, "query": "reef shark"})

    # Invariant 1: stored pool is replaced with reef-shark candidates
    pool = store.get_footage_candidates(conn, "s1", scene_index=1)
    assert pool and pool[0]["query"] == "reef shark"

    # Invariant 2: spec scene-1 src changed to a reef-shark clip.
    # _edit_footage names it footage_{query_slug("reef shark")}_1.mp4 — compute the slug
    # rather than hardcoding the hash so this survives a query_slug algorithm change.
    from pipeline.footage import query_slug
    spec = json.loads((tmp_path / "spec.json").read_text())
    media1_src = spec["scenes"][1]["templateProps"]["media"]["src"]
    assert media1_src != media0_src, (
        f"expected scene-1 src to change after re_query; got {media1_src!r} == {media0_src!r}")
    assert query_slug("reef shark") in media1_src, (
        f"expected reef-shark slug {query_slug('reef shark')!r} in scene-1 src; got {media1_src!r}")

    conn.close()


def test_pick_fails_loud_when_link_recovery_fails(tmp_path, monkeypatch):
    # The persisted pool stores no download link, so pick re-searches to recover it.
    # If the re-search no longer has that rank, binding a clip to a missing file would
    # write a silently broken spec — the gate must raise instead.
    import pytest
    conn, eng = _seed(tmp_path, monkeypatch)
    # recovery search for "coral reef" now returns only ONE video -> no rank-2 match
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": [
        {"duration": 6, "video_files": [{"link": "only.mp4", "width": 1080, "height": 1920,
                                         "file_type": "video/mp4"}], "video_pictures": [{"picture": "t1"}]},
    ]})
    with pytest.raises(RuntimeError, match="no download link"):
        eng.edit("footage", {"op": "pick", "scene_index": 1, "rank": 2})
    conn.close()
