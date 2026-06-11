# backend/tests/test_job_ctx.py
from session import job_ctx


def test_build_ctx_default_is_global_paths():
    ctx = job_ctx.build_ctx(topic="t")
    assert ctx.spec_out == job_ctx.SPEC_OUT
    assert ctx.voiceover_path.name == "voiceover.wav"


def test_build_ctx_sid_uses_per_session_paths():
    ctx = job_ctx.build_ctx(topic="t", sid="auto-abc")
    assert ctx.spec_out == job_ctx.REPO_ROOT / "projects" / "auto-abc" / "spec.json"
    assert ctx.sources_out == job_ctx.REPO_ROOT / "projects" / "auto-abc" / "sources.json"
    assert ctx.voiceover_path.name == "voiceover_auto-abc.wav"
    assert ctx.voiceover_path.parent == job_ctx.ASSETS_DIR
