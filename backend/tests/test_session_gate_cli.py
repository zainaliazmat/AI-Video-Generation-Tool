"""Studio v3 gate CLI (session_gate.py) — Task 10a Part 2 tests.

All tests are function-level invocations of the CLI helpers (not subprocess).
Filesystem hygiene: every test targets a tmp_path repo_root via monkeypatched
job_ctx constants; git status --porcelain confirms no real-repo writes.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import store as st, executors, engine as eng_mod, api as session_api, gatekeeper
from pipeline import projects as projects_mod


# ---------------------------------------------------------------------------
# Shared fake pipeline setup (offline, no network, no TTS model)
# ---------------------------------------------------------------------------

def _install_fakes(monkeypatch, *, script=None):
    """Install offline pipeline fakes; returns the script being used."""
    if script is None:
        script = BeatsScript(
            title="Reefs",
            beats=[Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")],
        )
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path, **kw: (
                            Path(path).parent.mkdir(parents=True, exist_ok=True),
                            Path(path).write_bytes(b"W"),
                            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)],
                        )[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs])
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": []})
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "K")
    return script


def _point_at(tmp_path, monkeypatch):
    """Aim job_ctx constants at tmp_path so NO writes hit the real repo."""
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.REPO_ROOT", tmp_path)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")


# ---------------------------------------------------------------------------
# Test 1: start returns ok/sid (v3- prefix) / gates; sid PROGRESS line is FIRST
# ---------------------------------------------------------------------------

def test_start_returns_ok_sid_and_gates(tmp_path, monkeypatch, capsys):
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    result = sg.start("Coral reefs", auto_run=False)

    assert result["ok"] is True
    sid = result["sid"]
    assert sid.startswith("v3-")
    assert "gates" in result
    assert result["gates"]["script"]["state"] == "awaiting_approval"

    # capsys: FIRST PROGRESS line must be the sid event
    out = capsys.readouterr().out
    lines = [l for l in out.splitlines() if l.startswith("PROGRESS ")]
    assert lines, "no PROGRESS lines emitted"
    first = json.loads(lines[0].removeprefix("PROGRESS "))
    assert first["type"] == "sid"
    assert first["sid"] == sid

    # subsequent lines contain the script running/done stage events
    stage_events = [json.loads(l.removeprefix("PROGRESS ")) for l in lines[1:]]
    types = [(e.get("stage"), e.get("state")) for e in stage_events if e.get("type") == "stage"]
    assert ("script", "running") in types
    assert ("script", "done") in types


# ---------------------------------------------------------------------------
# Test 2: approve advances gate; voice-gate approve with voice calls write_voice BEFORE segment
# ---------------------------------------------------------------------------

def test_approve_advances_script_to_voice(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    r0 = sg.start("Coral reefs", auto_run=False)
    sid = r0["sid"]

    r1 = sg.approve(sid, "script")
    assert r1["ok"] is True and r1["sid"] == sid
    assert r1["gates"]["script"]["state"] == "approved"
    assert r1["gates"]["voice"]["state"] == "awaiting_approval"


def test_approve_voice_gate_with_voice_writes_sidecar_first(tmp_path, monkeypatch):
    """Ruling 3A: write_voice is called BEFORE the gate segment executes."""
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    r0 = sg.start("Coral reefs", auto_run=False)
    sid = r0["sid"]
    sg.approve(sid, "script")  # open voice gate

    write_calls: list = []
    call_order: list = []

    orig_write_voice = projects_mod.write_voice

    def recording_write_voice(root, s, *, voice, speed):
        write_calls.append((voice, speed))
        call_order.append("write_voice")
        return orig_write_voice(root, s, voice=voice, speed=speed)

    monkeypatch.setattr("pipeline.projects.write_voice", recording_write_voice)
    monkeypatch.setattr("session_gate.projects_mod.write_voice", recording_write_voice)

    # Patch gatekeeper.approve to record its call order relative to write_voice
    orig_approve = gatekeeper.approve

    def recording_approve(sess, gate, *, on_stage=None):
        call_order.append("gatekeeper.approve")
        return orig_approve(sess, gate, on_stage=on_stage)

    monkeypatch.setattr("session.gatekeeper.approve", recording_approve)

    r1 = sg.approve(sid, "voice", voice="af_bella", speed=1.1)
    assert r1["ok"] is True

    # write_voice must have been called
    assert len(write_calls) == 1
    assert write_calls[0] == ("af_bella", 1.1)
    # write_voice must appear BEFORE gatekeeper.approve in the call order
    assert call_order.index("write_voice") < call_order.index("gatekeeper.approve")


# ---------------------------------------------------------------------------
# Test 3: state, preview_reopen, set_auto_run pass through correctly
# ---------------------------------------------------------------------------

def test_state_returns_gate_view(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    r0 = sg.start("Coral reefs", auto_run=False)
    sid = r0["sid"]

    s = sg.state(sid)
    assert s["ok"] is True and s["sid"] == sid
    assert "gates" in s and "autoRun" in s
    assert s["gates"]["script"]["state"] == "awaiting_approval"


def test_preview_reopen_returns_blast_radius(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    r0 = sg.start("Coral reefs", auto_run=False)
    sid = r0["sid"]
    sg.approve(sid, "script")
    sg.approve(sid, "voice")   # heavy segment → scenes gate open
    sg.approve(sid, "scenes")  # → assemble gate open

    pr = sg.preview_reopen(sid, "script")
    assert pr["ok"] is True and pr["sid"] == sid
    assert "reruns" in pr and "staleGates" in pr
    assert "voice" in pr["reruns"]


def test_set_auto_run_persists_flag(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    r0 = sg.start("Coral reefs", auto_run=False)
    sid = r0["sid"]

    r1 = sg.set_auto_run(sid, True)
    assert r1["ok"] is True and r1["autoRun"] is True

    # verify persisted in DB
    conn = st.connect(tmp_path / "s.db")
    row = st.get_session(conn, sid)
    conn.close()
    assert row["auto_run"] == 1

    r2 = sg.set_auto_run(sid, False)
    assert r2["autoRun"] is False


# ---------------------------------------------------------------------------
# Test 4: unknown sid → KeyError ("no session")
# ---------------------------------------------------------------------------

def test_unknown_sid_raises_key_error(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    with pytest.raises(KeyError, match="no session"):
        sg.state("v3-doesnotexist")

    with pytest.raises(KeyError, match="no session"):
        sg.approve("v3-doesnotexist", "script")


# ---------------------------------------------------------------------------
# Test 5: failed-stage → emits "failed" PROGRESS event with error, then re-raises
# ---------------------------------------------------------------------------

def test_failed_stage_emits_failed_progress_event(tmp_path, monkeypatch, capsys):
    """If the script executor raises, start() must emit a stage failed event
    (design ruling 5) and then propagate the exception."""
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    boom = RuntimeError("script exploded")
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda *a, **kw: (_ for _ in ()).throw(boom))

    import session_gate as sg
    with pytest.raises(RuntimeError, match="script exploded"):
        sg.start("Kaboom topic")

    out = capsys.readouterr().out
    lines = [l for l in out.splitlines() if l.startswith("PROGRESS ")]
    stage_events = [json.loads(l.removeprefix("PROGRESS ")) for l in lines
                    if json.loads(l.removeprefix("PROGRESS ")).get("type") == "stage"]
    failed = [e for e in stage_events if e.get("state") == "failed"]
    assert failed, "no failed event emitted"
    assert failed[0]["stage"] == "script"
    assert "error" in failed[0]
    assert "script exploded" in failed[0]["error"]


# ---------------------------------------------------------------------------
# Test 6: filesystem hygiene — no writes to the real repo
# ---------------------------------------------------------------------------

def test_no_writes_to_real_repo(tmp_path, monkeypatch):
    """bootstrap/write_sources must target tmp_path, not the real repo.
    Verified by checking git status --porcelain after a full start() call."""
    import subprocess
    _install_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg
    sg.start("Hygiene test")

    result = subprocess.run(
        ["git", "status", "--porcelain"],
        capture_output=True, text=True,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    # Only the files staged/committed by THIS test session should appear
    # (session_gate.py and test file themselves). No projects/ or .sessions/ writes.
    dirty = [l for l in result.stdout.splitlines()
             if "projects/" in l or ".sessions/" in l]
    assert dirty == [], f"real repo was dirtied: {dirty}"
