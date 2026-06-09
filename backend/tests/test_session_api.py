"""HITL A.1 — the programmatic Session API + resume. A session created then dropped
mid-flow resumes: the remaining stages advance, the done ones are cache hits."""
import json
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import api, store, executors

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _fakes(monkeypatch):
    script = BeatsScript(title="Reefs", beats=[Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script", lambda topic, cache_dir=None: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4", duration_frames=300) for r in reqs])
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": []})
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "K")


def _ctx(tmp_path):
    return executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=validate_stage.load_catalog(_TEMPLATES),
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")


def test_create_run_resume(tmp_path, monkeypatch):
    _fakes(monkeypatch)
    db = tmp_path / "s.db"
    sess = api.create(db, _ctx(tmp_path), session_id="s1", topic="Reefs")
    api.advance(sess, "script")
    api.advance(sess, "voice")
    api.close(sess)

    # resume: a fresh handle over the same DB; script+voice are cache hits, rest advance
    sess2 = api.resume(db, _ctx(tmp_path), session_id="s1")
    api.run_all(sess2)
    spec = json.loads((tmp_path / "spec.json").read_text())
    assert spec["meta"]["title"] == "Reefs"
    assert store.get_stage(sess2.conn, "s1", "assemble")["status"] == "done"
    api.close(sess2)
