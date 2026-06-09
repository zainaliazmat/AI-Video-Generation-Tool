"""HITL A.1 — executors wrap the existing stage fns behind run(ctx, inputs)->output.
Tested with fakes so no provider/network is hit (mirrors the existing E2E fakes)."""
from pathlib import Path

from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import Beat, BeatsScript
from pipeline.recipe import plan as recipe_plan
from schema import Theme
from session import executors
from session.executors import EngineContext


def _ctx(tmp_path, **over):
    base = dict(topic="Coral Reefs", fps=30, theme=Theme(), catalog={},
                assets_dir=tmp_path, cache_dir=tmp_path / "cache",
                voiceover_path=tmp_path / "voiceover.wav",
                spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")
    base.update(over)
    return EngineContext(**base)


def test_voice_executor_calls_synth_with_plan_lines(tmp_path, monkeypatch):
    script = BeatsScript(title="T", beats=[Beat(text="hook"), Beat(text="mid"), Beat(text="out")])
    p = recipe_plan(script, theme=Theme())
    captured = {}

    def fake_synth(lines, path):
        captured["lines"] = lines
        return [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)]

    monkeypatch.setattr("pipeline.tts.synthesize", fake_synth)
    out = executors.run_voice(_ctx(tmp_path), {"script": {"script": script, "plan": p}})
    assert captured["lines"] == ["hook", "mid", "out"]      # narration in beat order
    assert [o.index for o in out] == [0, 1, 2]
