import json
import main as m
from pipeline.contracts import LineOffset, WordTiming, Clip


def test_run_emits_stage_progress_in_order(monkeypatch, tmp_path):
    monkeypatch.setattr(m.script_stage, "generate_script", lambda topic: {"title": "T", "lines": ["a", "b"]})
    monkeypatch.setattr(m.tts_stage, "synthesize", lambda lines, out: [LineOffset(0, "a", 0.0, 1.0), LineOffset(1, "b", 1.0, 2.0)])
    monkeypatch.setattr(m.timing_stage, "transcribe_words", lambda wav, fps: [WordTiming("a", 0, 15)])
    monkeypatch.setattr(m.footage_stage, "fetch_footage", lambda lines, out: [Clip(0, "a", "assets/f0.mp4"), Clip(1, "b", "assets/f1.mp4")])
    monkeypatch.setattr(m, "ASSETS_DIR", tmp_path / "assets")
    monkeypatch.setattr(m, "SPEC_OUT", tmp_path / "spec.json")

    events = []
    spec = m.run("anything", on_stage=lambda key, state: events.append((key, state)))

    assert events == [
        ("script", "running"), ("script", "done"),
        ("voice", "running"), ("voice", "done"),
        ("timing", "running"), ("timing", "done"),
        ("footage", "running"), ("footage", "done"),
        ("assemble", "running"), ("assemble", "done"),
    ]
    assert (tmp_path / "spec.json").exists()
    written = json.loads((tmp_path / "spec.json").read_text())
    assert written["meta"]["title"] == "T"
    assert len(written["scenes"]) == 2
    assert spec.meta.title == "T"
