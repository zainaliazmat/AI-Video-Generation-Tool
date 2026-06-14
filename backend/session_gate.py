"""Studio v3 gate CLI — start / approve / state / preview_reopen / set_auto_run (PRD §6.1).

Emits PROGRESS lines (one JSON object per stage transition, with elapsed_s on done)
for the SSE interstitial, then ONE final JSON result line on stdout.
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from uuid import uuid4

from session import api, store, job_ctx
from session import prefs as prefs_mod
from pipeline import projects as projects_mod


# ── progress emitters ────────────────────────────────────────────────────────

def _on_stage(stage: str, state: str, elapsed: float | None) -> None:
    payload: dict = {"type": "stage", "stage": stage, "state": state}
    if elapsed is not None:
        payload["elapsed_s"] = elapsed
    print(f"PROGRESS {json.dumps(payload)}", flush=True)


# ── internal helpers ─────────────────────────────────────────────────────────


def _resume(sid: str) -> "api.Session":
    """Look up the session, thread any persisted voice/speed/target_length, and resume.

    Ruling 3A: projects.read_voice() loads the persisted voice choice so that
    approving the voice gate with a new voice carries the right synthesis params.
    target_length is read back from the session row so a re-derive after resume
    uses the STORED preset (not the default 60) — mirrors the ruling-3A voice pattern.
    """
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        topic = row["topic"]
        target_length = row["target_length"]
    finally:
        conn.close()
    saved = projects_mod.read_voice(job_ctx.REPO_ROOT, sid)
    ctx = job_ctx.build_ctx(
        topic=topic,
        sid=sid,
        voice=saved["voice"],
        speed=saved["speed"],
        target_length=target_length,
    )
    return api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)


# ── gate operations ──────────────────────────────────────────────────────────

def start(topic: str, *, auto_run: bool = False, target_length: int = 60,
          prefs_override: dict | None = None) -> dict:
    """Start a new gated session.

    Design ruling 2: the sid line is printed FIRST, before any stage runs,
    so the SSE interstitial can open its EventSource immediately.
    target_length is stored on the session row so _resume can re-thread it.
    prefs_override (per-video script-style tweaks) is persisted on the row and
    composed — with the global script_prefs and style memory — into the additive
    USER block; absent → byte-identical to a no-prefs run.
    """
    sid = f"v3-{uuid4().hex}"
    # ruling 2: emit sid event BEFORE building ctx or running any stage
    print(f"PROGRESS {json.dumps({'type': 'sid', 'sid': sid})}", flush=True)

    last_running: list[str] = []  # tracked for failed-event emission

    def on_stage(stage: str, state: str, elapsed: float | None) -> None:
        if state == "running":
            last_running.clear()
            last_running.append(stage)
        elif state == "done":
            last_running.clear()
        _on_stage(stage, state, elapsed)

    extra = prefs_mod.compose_extra_block(sid, override=prefs_override)
    ctx = job_ctx.build_ctx(topic=topic, sid=sid, target_length=target_length,
                            extra_user_block=extra)
    sess = api.create(job_ctx.SESSIONS_DB, ctx, session_id=sid, topic=topic,
                      target_length=target_length,
                      prefs_override=json.dumps(prefs_override) if prefs_override else None)
    try:
        projects_mod.bootstrap(job_ctx.REPO_ROOT, sid, topic=topic)
        try:
            view = api.gate_start(sess, auto_run=auto_run, on_stage=on_stage)
        except Exception as exc:
            if last_running:
                stage = last_running[0]
                payload: dict = {"type": "stage", "stage": stage, "state": "failed",
                                 "error": str(exc)}
                print(f"PROGRESS {json.dumps(payload)}", flush=True)
            raise
        script_bundle = sess.engine._load_output("script")
        projects_mod.write_sources(job_ctx.REPO_ROOT, sid, script_bundle["script"])
        return {"ok": True, "sid": sid, **view}
    finally:
        api.close(sess)


def approve(sid: str, gate: str, *, voice: str | None = None, speed: float = 1.0) -> dict:
    """Approve a gate and run the next segment.

    Ruling 3A: if gate=='voice' and voice is not None, persist the voice choice
    BEFORE resuming (the approval carries the operator's selection).
    """
    # ruling 3A: write voice sidecar BEFORE the resume so build_ctx loads it
    if gate == "voice" and voice is not None:
        projects_mod.write_voice(job_ctx.REPO_ROOT, sid, voice=voice, speed=speed)

    last_running: list[str] = []

    def on_stage(stage: str, state: str, elapsed: float | None) -> None:
        if state == "running":
            last_running.clear()
            last_running.append(stage)
        elif state == "done":
            last_running.clear()
        _on_stage(stage, state, elapsed)

    sess = _resume(sid)
    try:
        try:
            view = api.gate_approve(sess, gate, on_stage=on_stage)
        except Exception as exc:
            if last_running:
                stage = last_running[0]
                payload: dict = {"type": "stage", "stage": stage, "state": "failed",
                                 "error": str(exc)}
                print(f"PROGRESS {json.dumps(payload)}", flush=True)
            raise
        return {"ok": True, "sid": sid, **view}
    finally:
        api.close(sess)


def state(sid: str) -> dict:
    """Return the current gate view for a session."""
    sess = _resume(sid)
    try:
        view = api.gate_view(sess)
        return {"ok": True, "sid": sid, **view}
    finally:
        api.close(sess)


def preview_reopen(sid: str, gate: str) -> dict:
    """Return the blast-radius preview for a gate (read-only)."""
    sess = _resume(sid)
    try:
        result = api.gate_preview_reopen(sess, gate)
        return {"ok": True, "sid": sid, **result}
    finally:
        api.close(sess)


def set_auto_run(sid: str, flag: bool) -> dict:
    """Toggle auto-run mode for a session."""
    sess = _resume(sid)
    try:
        api.gate_set_auto_run(sess, flag)
        view = api.gate_view(sess)
        return {"ok": True, "sid": sid, **view}
    finally:
        api.close(sess)


def set_voice(sid: str, *, voice: str, speed: float = 1.0) -> dict:
    """§4.1 voice reopen: defer a voice/speed change at an APPROVED voice gate.
    gatekeeper.set_voice writes the sidecar, marks the voice stage stale, and
    reopens the voice gate — the amber Re-approve then pays once (M6-T9)."""
    sess = _resume(sid)
    try:
        view = api.gate_set_voice(sess, voice=voice, speed=speed)
        return {"ok": True, "sid": sid, **view}
    finally:
        api.close(sess)


# ── __main__ ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="Studio v3 gate CLI (PRD §6.1)")
    ap.add_argument("--op", required=True,
                    choices=["start", "approve", "state", "preview_reopen", "set_auto_run", "set_voice"])
    ap.add_argument("--topic")
    ap.add_argument("--sid")
    ap.add_argument("--gate")
    ap.add_argument("--auto-run", action="store_true", default=False)
    ap.add_argument("--voice")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--flag", choices=["true", "false"],
                    help="Boolean flag for set_auto_run (pass 'true' or 'false')")
    ap.add_argument("--target-length", type=int, default=60,
                    choices=[30, 60, 180, 300],
                    help="Target video length in seconds (30/60/180/300; default 60)")
    ap.add_argument("--prefs-override-json",
                    help="Per-video script-style override (JSON object) for start")
    args = ap.parse_args()

    try:
        if args.op == "start":
            if not args.topic:
                raise ValueError("--topic is required for start")
            prefs_override = (json.loads(args.prefs_override_json)
                              if args.prefs_override_json else None)
            result = start(args.topic, auto_run=args.auto_run,
                           target_length=args.target_length,
                           prefs_override=prefs_override)
        elif args.op == "approve":
            if not args.sid or not args.gate:
                raise ValueError("--sid and --gate are required for approve")
            result = approve(args.sid, args.gate, voice=args.voice, speed=args.speed)
        elif args.op == "state":
            if not args.sid:
                raise ValueError("--sid is required for state")
            result = state(args.sid)
        elif args.op == "preview_reopen":
            if not args.sid or not args.gate:
                raise ValueError("--sid and --gate are required for preview_reopen")
            result = preview_reopen(args.sid, args.gate)
        elif args.op == "set_voice":
            if not args.sid or not args.voice:
                raise ValueError("--sid and --voice are required for set_voice")
            result = set_voice(args.sid, voice=args.voice, speed=args.speed)
        else:  # set_auto_run
            if not args.sid:
                raise ValueError("--sid is required for set_auto_run")
            if args.flag not in ("true", "false"):
                raise ValueError("--flag must be 'true' or 'false'")
            result = set_auto_run(args.sid, args.flag == "true")
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
