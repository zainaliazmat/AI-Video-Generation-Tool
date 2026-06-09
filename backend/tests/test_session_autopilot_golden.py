"""HITL A.1 — invariant #7: the engine's autopilot run_all() produces a valid,
correctly-shaped spec.json from faked providers. Task 10 adds the byte-identical
cross-check against the refactored main.run(); the pre-existing E2E suite is the
end-to-end parity guard."""
import json
from pathlib import Path

from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import Beat, BeatsScript
from schema import Theme, Spec
from pipeline import validate as validate_stage

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _install_fakes(monkeypatch):
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="Coral reefs cover under one percent of the ocean floor."),
        Beat(text="Yet they shelter a quarter of all marine species.", keywords="coral reef fish"),
        Beat(text="Protect them — follow for more."),
    ])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None: script)

    def fake_synth(lines, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(b"WAV")
        return [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)]
    monkeypatch.setattr("pipeline.tts.synthesize", fake_synth)

    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])

    def fake_fetch(reqs, out_dir, *, fps=30, **kw):
        return [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4",
                     duration_frames=300) for r in reqs]
    monkeypatch.setattr("pipeline.footage.fetch_footage", fake_fetch)


def test_engine_autopilot_produces_valid_spec(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    from session import store, engine, executors
    catalog = validate_stage.load_catalog(_TEMPLATES)

    ctx = executors.EngineContext(
        topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
        assets_dir=tmp_path / "assets", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "assets" / "voiceover.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
    engine.Engine(conn, ctx, session_id="s1").run_all()
    conn.close()

    engine_spec = json.loads((tmp_path / "spec.json").read_text())
    assert engine_spec["meta"]["title"] == "Coral Reefs"
    assert len(engine_spec["scenes"]) == 3
    assert engine_spec["scenes"][1]["template"] == "scene"   # middle beat -> footage scene
    assert engine_spec["audio"]["voiceover"] == "assets/voiceover.wav"
    validate_stage.validate_spec(Spec.model_validate(engine_spec), catalog)  # fail-closed parity


def test_refactored_main_run_matches_engine_spec(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    import main
    # point main's outputs at tmp so the test is hermetic
    monkeypatch.setattr(main, "SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr(main, "SOURCES_OUT", tmp_path / "sources.json")
    monkeypatch.setattr(main, "ASSETS_DIR", tmp_path / "assets")
    monkeypatch.setattr(main, "SESSIONS_DB", tmp_path / "s.db")
    main.run("Coral Reefs")
    spec = json.loads((tmp_path / "spec.json").read_text())
    assert spec["meta"]["title"] == "Coral Reefs"
    assert len(spec["scenes"]) == 3
    assert spec["scenes"][1]["template"] == "scene"
