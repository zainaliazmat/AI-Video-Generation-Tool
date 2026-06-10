"""Step 6.4 — main orchestrates: script → recipe.plan → tts → timing →
footage(by plan) → assemble(plan) → validate → write."""
import json
import main as m
from pipeline.content import BeatsScript, Beat, Source, HookCandidate
from pipeline.contracts import LineOffset, WordTiming, Clip, FootageRequest


# --- Phase 3 (3.1): the sources.json sidecar (client-facing citation list) ---


def test_build_sources_sidecar_lists_cited_facts_and_sources():
    script = BeatsScript(
        title="Deep Sea",
        beats=[
            Beat(text="Intro hook"),                                    # no source → not a cited fact
            Beat(text="90% is unmapped", source="https://noaa.gov/x"),
            Beat(text="Follow for more"),                               # no source
        ],
        sources=[Source(url="https://noaa.gov/x", title="NOAA")],
        hook_candidates=[
            HookCandidate(text="90% unmapped — why?", pattern="surprising stat", score=5.0, chosen=True),
            HookCandidate(text="The ocean is vast.", pattern="bold claim", score=1.0),
        ],
        verify_report=[{"text": "90% is unmapped", "verdict": "kept"}],
    )
    out = m.build_sources_sidecar(script)
    assert out["title"] == "Deep Sea"
    assert out["facts"] == [{"text": "90% is unmapped", "source": "https://noaa.gov/x"}]
    assert out["sources"] == [{"url": "https://noaa.gov/x", "title": "NOAA"}]
    assert out["hooks"] == [
        {"text": "90% unmapped — why?", "pattern": "surprising stat", "score": 5.0, "chosen": True},
        {"text": "The ocean is vast.", "pattern": "bold claim", "score": 1.0, "chosen": False},
    ]
    assert out["verification"] == [{"text": "90% is unmapped", "verdict": "kept"}]


def test_build_sources_sidecar_handles_ungrounded_script():
    out = m.build_sources_sidecar(BeatsScript(title="T", beats=[Beat(text="a")]))
    assert out["facts"] == []
    assert out["sources"] == []
    assert out["hooks"] == []
    assert out["verification"] == []


def test_run_builds_multi_template_spec_from_a_plan(monkeypatch, tmp_path):
    seen = {}

    # hook / stat(numeric) / scene(plain, footage) / outro
    beats = [
        {"text": "the hook"},
        {"text": "a big stat", "data": {"value": "90%", "label": "unmapped"}},
        {"text": "a plain scene", "keywords": "ocean"},
        {"text": "follow for more"},
    ]
    captured = {}

    def fake_grounded(topic, **kwargs):
        captured.update(topic=topic, **kwargs)
        return BeatsScript(title="T", beats=beats)

    monkeypatch.setattr(m.script_stage, "generate_script", lambda topic: BeatsScript(title="T", beats=beats))
    monkeypatch.setattr(m.script_stage, "generate_grounded_script", fake_grounded)
    monkeypatch.setattr(
        m.tts_stage, "synthesize",
        lambda lines, out: seen.update(tts_lines=lines) or [
            LineOffset(0, "a", 0.0, 1.0), LineOffset(1, "b", 1.2, 2.0),
            LineOffset(2, "c", 2.2, 3.0), LineOffset(3, "d", 3.2, 4.0),
        ],
    )
    monkeypatch.setattr(m.timing_stage, "transcribe_words", lambda wav, fps: [WordTiming("a", 0, 15)])

    def fake_footage(reqs, out, *, fps):
        seen["footage_reqs"] = list(reqs)
        return [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4", duration_frames=300) for r in reqs]

    monkeypatch.setattr(m.footage_stage, "fetch_footage", fake_footage)
    monkeypatch.setattr(m, "ASSETS_DIR", tmp_path / "assets")
    monkeypatch.setattr(m, "SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr(m, "SOURCES_OUT", tmp_path / "sources.json")
    monkeypatch.setattr(m, "SESSIONS_DB", tmp_path / "s.db")

    events = []
    spec = m.run("anything", on_stage=lambda key, state: events.append((key, state)))

    # A.6.1: session id is emitted first, before any stage events
    session_events = [(k, v) for (k, v) in events if k == "session"]
    assert len(session_events) == 1
    assert session_events[0][1].startswith("auto-")
    stage_events = [(k, v) for (k, v) in events if k != "session"]
    assert stage_events == [
        ("script", "running"), ("script", "done"),
        ("voice", "running"), ("voice", "done"),
        ("timing", "running"), ("timing", "done"),
        ("footage", "running"), ("footage", "done"),
        ("assemble", "running"), ("assemble", "done"),
    ]
    # every beat narrated, in order
    assert seen["tts_lines"] == ["the hook", "a big stat", "a plain scene", "follow for more"]
    # footage requested ONLY for the scene beat (index 2), as FootageRequests
    assert [r.index for r in seen["footage_reqs"]] == [2]
    assert all(isinstance(r, FootageRequest) for r in seen["footage_reqs"])
    assert seen["footage_reqs"][0].query == "ocean"
    assert seen["footage_reqs"][0].min_frames > 0          # biased by scene duration

    # the written spec is multi-template and valid (validate ran without raising)
    written = json.loads((tmp_path / "spec.json").read_text())
    assert [s["template"] for s in written["scenes"]] == ["hook", "stat", "scene", "outro"]
    assert written["meta"]["title"] == "T"
    assert spec.meta.durationInFrames == 120               # round(4.0 * 30)

    # the sources sidecar is written next to the spec on the grounded path
    sidecar = json.loads((tmp_path / "sources.json").read_text())
    assert sidecar["title"] == "T"
    assert sidecar["facts"] == [] and sidecar["sources"] == []  # these beats carry no source
    assert captured["cache_dir"] is not None                    # retrieval is cached (cost bound)
