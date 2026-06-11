"""HITL A.1 — invariant #7: the engine's autopilot run_all() produces a valid,
correctly-shaped spec.json from faked providers, and the refactored main.run()
produces the SAME spec content as the direct engine (the content-identity
cross-check). The pre-existing E2E suite is the end-to-end parity guard."""
import json
from pathlib import Path

from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import Beat, BeatsScript
from schema import Theme, Spec
from pipeline import validate as validate_stage

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _install_fakes(monkeypatch):
    """Install pipeline fakes; returns a call-counter (script invocations)."""
    calls = {"script": 0}
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="Coral reefs cover under one percent of the ocean floor."),
        Beat(text="Yet they shelter a quarter of all marine species.", keywords="coral reef fish"),
        Beat(text="Protect them — follow for more."),
    ])

    def fake_script(topic, cache_dir=None):
        calls["script"] += 1
        return script
    monkeypatch.setattr("pipeline.script.generate_grounded_script", fake_script)

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
    return calls


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


def _run_main(tmp_path, monkeypatch):
    """Drive the refactored main.run() hermetically (outputs + sessions DB in tmp)."""
    import main
    monkeypatch.setattr(main, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(main, "ASSETS_DIR", tmp_path / "assets")
    monkeypatch.setattr(main, "SESSIONS_DB", tmp_path / "s.db")
    sid_box = {}
    main.run("Coral Reefs",
             on_stage=lambda k, v: sid_box.update(sid=v) if k == "session" else None)
    return json.loads((tmp_path / "projects" / sid_box["sid"] / "spec.json").read_text())


def test_refactored_main_run_produces_valid_spec(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    spec = _run_main(tmp_path, monkeypatch)
    assert spec["meta"]["title"] == "Coral Reefs"
    assert len(spec["scenes"]) == 3
    assert spec["scenes"][1]["template"] == "scene"


def test_autopilot_regenerates_fresh_each_run(tmp_path, monkeypatch):
    """Issue-1 fix: autopilot mints a fresh session id per run, so re-generating the
    SAME topic is a real cold run (not a cache no-op that would re-stage a stale spec
    pointing at possibly-deleted clips). The script executor must run on every call."""
    import main
    calls = _install_fakes(monkeypatch)
    monkeypatch.setattr(main, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(main, "ASSETS_DIR", tmp_path / "assets")
    monkeypatch.setattr(main, "SESSIONS_DB", tmp_path / "s.db")

    main.run("Coral Reefs")
    main.run("Coral Reefs")          # same topic again
    assert calls["script"] == 2      # fresh generation each run, NOT a cache hit


def test_autopilot_spec_identical_regardless_of_clip_provenance(tmp_path, monkeypatch):
    """Invariant #1: provenance fields on Clip NEVER change spec.json. Run the engine
    with clips carrying provenance vs. clips without, and assert byte-equal spec.json —
    pinning the render contract for both the default path and the captured-provenance path."""
    from session import store, engine, executors
    catalog = validate_stage.load_catalog(_TEMPLATES)

    def run_with(fetch_fake, sub):
        _install_fakes(monkeypatch)
        monkeypatch.setattr("pipeline.footage.fetch_footage", fetch_fake)
        d = tmp_path / sub
        ctx = executors.EngineContext(
            topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
            assets_dir=d / "assets", cache_dir=d / "c",
            voiceover_path=d / "assets" / "voiceover.wav",
            spec_out=d / "spec.json", sources_out=d / "sources.json")
        conn = store.connect(d / "s.db")
        store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
        engine.Engine(conn, ctx, session_id="s1").run_all()
        conn.close()
        return (d / "spec.json").read_text()

    def plain(reqs, out_dir, *, fps=30, **kw):
        return [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4",
                     duration_frames=300) for r in reqs]

    def with_prov(reqs, out_dir, *, fps=30, **kw):
        return [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4",
                     duration_frames=300, rank=3, pexels_id=999,
                     pexels_url="https://pexels.com/v/999") for r in reqs]

    assert run_with(plain, "plain") == run_with(with_prov, "prov")


def test_refactored_main_run_content_identical_to_direct_engine(tmp_path, monkeypatch):
    """The strongest parity proof: main.run() and the direct engine, on identical
    faked inputs, must emit byte-equal spec.json content. If the refactor ever drifts
    (a codec drop, a different call), this is the test that catches it."""
    _install_fakes(monkeypatch)

    # (a) direct engine -> engine/spec.json
    from session import store, engine, executors
    edir = tmp_path / "engine"
    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = executors.EngineContext(
        topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
        assets_dir=edir / "assets", cache_dir=edir / "c",
        voiceover_path=edir / "assets" / "voiceover.wav",
        spec_out=edir / "spec.json", sources_out=edir / "sources.json")
    conn = store.connect(edir / "s.db")
    store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
    engine.Engine(conn, ctx, session_id="s1").run_all()
    conn.close()
    engine_spec = json.loads((edir / "spec.json").read_text())

    # (b) refactored main.run() -> main/spec.json
    main_spec = _run_main(tmp_path / "main", monkeypatch)

    # The one intentional divergence under the project library: main.run() namespaces the
    # voiceover per session (voiceover_<sid>.wav) while the direct-engine ctx above uses the
    # global voiceover.wav. Normalize that single field; everything else must be byte-equal.
    main_spec["audio"]["voiceover"] = "assets/voiceover.wav"
    assert main_spec == engine_spec   # structural parity: same spec from both code paths
