"""Studio v2 Voice gate CLI — list / preview / apply (PRD §6.2).

Kokoro ships multiple voices and runs locally; ALL are free (no paid tier). This
gate is a picker + per-voice preview + apply.

  list    — the curated voice cards + the session's current selection.
  preview — synthesize ONE sample sentence in a voice locally (cached per voice),
            return the wav path for in-browser playback.
  apply   — persist the voice/speed choice and re-synthesize the narration (and
            re-time captions: voice → timing → footage loop math → assemble → spec).

Usage:
  python backend/session_voice.py --op list [--sid <id>]
  python backend/session_voice.py --op preview --voice af_bella [--speed 1.0]
  python backend/session_voice.py --op apply --sid <id> --voice af_bella [--speed 1.1]
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import api, store, job_ctx
from pipeline import tts as tts_stage
from pipeline import projects as projects_mod

SAMPLE_LINE = "Here is how this voice sounds reading your script."


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


def list_voices(sid: str | None = None) -> dict:
    current = None
    if sid:
        current = projects_mod.read_voice(job_ctx.REPO_ROOT, sid)
    return {"ok": True, "voices": tts_stage.VOICES, "current": current}


def preview(voice: str, *, speed: float = 1.0) -> dict:
    if not tts_stage.is_valid_voice(voice):
        raise ValueError(f"unknown voice {voice!r}")
    name = f"voice_preview_{voice}_{str(speed).replace('.', '_')}.wav"
    dest = job_ctx.ASSETS_DIR / name
    if not dest.exists():  # cache per voice+speed
        tts_stage.synthesize([SAMPLE_LINE], dest, voice=voice, speed=speed)
    return {"ok": True, "voice": voice, "speed": speed, "path": f"assets/{name}"}


def apply(sid: str, *, voice: str, speed: float = 1.0) -> dict:
    if not tts_stage.is_valid_voice(voice):
        raise ValueError(f"unknown voice {voice!r}")
    projects_mod.write_voice(job_ctx.REPO_ROOT, sid, voice=voice, speed=speed)
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid, voice=voice, speed=speed)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        api.regenerate(sess, "voice")  # re-synth + re-time + re-derive spec
        offsets = sess.engine._load_output("voice")
        return {"ok": True, "sid": sid, "voice": voice, "speed": speed,
                "lines": len(offsets)}
    finally:
        api.close(sess)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--op", required=True, choices=["list", "preview", "apply"])
    ap.add_argument("--sid")
    ap.add_argument("--voice")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()
    try:
        if args.op == "list":
            res = list_voices(args.sid)
        elif args.op == "preview":
            if not args.voice:
                raise ValueError("--voice is required for preview")
            res = preview(args.voice, speed=args.speed)
        else:  # apply
            if not args.sid or not args.voice:
                raise ValueError("--sid and --voice are required for apply")
            res = apply(args.sid, voice=args.voice, speed=args.speed)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
