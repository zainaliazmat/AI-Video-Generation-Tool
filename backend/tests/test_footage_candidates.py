"""HITL A.1 — the footage executor records a ranked candidate pool per scene (for
the pick-from-pool gate), not just the selected clip."""
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.recipe import plan as recipe_plan
from pipeline.contracts import LineOffset
from session import executors
from session.executors import EngineContext


def test_run_footage_records_ranked_candidates(tmp_path, monkeypatch):
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    plan = recipe_plan(script, theme=Theme())
    offsets = [LineOffset(0, "hook", 0, 1), LineOffset(1, "mid", 1, 3), LineOffset(2, "out", 3, 4)]

    def fake_search(query, key):
        return {"videos": [
            {"duration": 6, "video_files": [{"link": "a.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}],
             "video_pictures": [{"picture": "thumbA"}]},
            {"duration": 10, "video_files": [{"link": "b.mp4", "width": 1080, "height": 1920,
                                              "file_type": "video/mp4"}],
             "video_pictures": [{"picture": "thumbB"}]},
        ]}

    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels", fake_search)
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))

    ctx = EngineContext(topic="Reefs", fps=30, theme=Theme(), catalog={},
                        assets_dir=tmp_path, cache_dir=tmp_path, voiceover_path=tmp_path / "v.wav",
                        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    out = executors.run_footage(ctx, {"script": {"script": script, "plan": plan}, "voice": offsets})

    assert "candidates" in out and 1 in out["candidates"]   # scene index 1 is the footage beat
    pool = out["candidates"][1]
    assert [c["rank"] for c in pool] == [1, 2]
    assert pool[0]["thumb_url"] == "thumbA"
    assert any(c["selected"] for c in pool)                 # the chosen clip is marked
