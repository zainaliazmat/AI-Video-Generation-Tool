"""HITL A.1 — executors wrap the existing stage fns behind run(ctx, inputs)->output.
Tested with fakes so no provider/network is hit (mirrors the existing E2E fakes)."""
from types import SimpleNamespace

from pipeline.contracts import LineOffset
from pipeline.content import Beat, BeatsScript
from pipeline.recipe import plan as recipe_plan, ScenePlan, PlannedScene
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


def test_footage_requests_min_frames_formula_and_needs_footage_filter(tmp_path, monkeypatch):
    # Only `scene` beats need footage; min_frames = (scene_duration + transition_headroom) // 2.
    # Fake scene_spans so the durations are known exactly (isolates the K-bias arithmetic).
    monkeypatch.setattr("pipeline.assemble.scene_spans", lambda offsets, fps: (None, [120, 200], None))
    plan = ScenePlan(title="Reefs", scenes=[
        PlannedScene(role="hook", template="hook", props={}, needs_footage=False),
        PlannedScene(role="scene", template="scene", props={}, needs_footage=True, query="coral reef"),
    ])
    # one transition manifest (headroom=18) + one non-transition (must be ignored)
    catalog = {
        "fade": SimpleNamespace(kind="transition", durationFrames=SimpleNamespace(max=18)),
        "scene": SimpleNamespace(kind="scene", durationFrames=SimpleNamespace(max=999)),
    }
    reqs = executors._footage_requests(_ctx(tmp_path, catalog=catalog), plan, offsets=[])

    assert [r.index for r in reqs] == [1]              # only the needs_footage scene
    assert reqs[0].query == "coral reef"                # keyword already on-subject → un-anchored
    assert reqs[0].min_frames == (200 + 18) // 2       # 109 — headroom from the transition only
    assert reqs[0].broad_query is not None             # subject anchor for the whiff broaden


def test_footage_requests_anchor_a_drifted_query_to_the_topic_subject(tmp_path, monkeypatch):
    # A keyword that has drifted off the subject gets the topic anchor prepended, and
    # the whiff fallback broadens to the clean subject (not the keyword, not the title).
    monkeypatch.setattr("pipeline.assemble.scene_spans", lambda offsets, fps: (None, [120], None))
    plan = ScenePlan(title="Octopuses Are Aliens", scenes=[
        PlannedScene(role="scene", template="scene", props={}, needs_footage=True,
                     query="color changing skin"),
    ])
    ctx = _ctx(tmp_path, topic="3 facts about octopuses", catalog={})
    reqs = executors._footage_requests(ctx, plan, offsets=[])

    assert reqs[0].query == "octopuses color changing skin"   # subject anchored onto the drift
    assert reqs[0].broad_query == "octopuses"                 # broaden to the subject, not the title


def test_footage_requests_harden_a_colliding_subject_into_the_broaden_fallback(tmp_path, monkeypatch):
    # A colliding/proper-noun topic is hardened to a filmable category before it
    # becomes the whiff-broaden fallback — never shipped as a zero-result named search.
    monkeypatch.setattr("pipeline.assemble.scene_spans", lambda offsets, fps: (None, [120], None))
    plan = ScenePlan(title="The Antikythera Mechanism", scenes=[
        PlannedScene(role="scene", template="scene", props={}, needs_footage=True, query="ancient gears"),
    ])
    ctx = _ctx(tmp_path, topic="The Antikythera Mechanism", catalog={})
    reqs = executors._footage_requests(ctx, plan, offsets=[])

    assert reqs[0].broad_query == "antique astronomical instrument"   # hardened, not the colliding name
