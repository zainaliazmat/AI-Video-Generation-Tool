"""Studio v2 Voice gate CLI — list / preview / apply (PRD §6.2).

Kokoro ships multiple voices and runs locally; ALL are free (no paid tier). This
gate is a picker + per-voice preview + apply.

  list    — the curated voice cards + the session's current selection.
  preview — synthesize ONE sample sentence in a voice locally (cached per voice+text+speed),
            return the wav path for in-browser playback.
            When --sid is given the sample text is beat 1's first ≤12 words; otherwise
            the canned SAMPLE_LINE is used (backward-compatible, zero LLM calls).
  apply   — persist the voice/speed choice and re-synthesize the narration (and
            re-time captions: voice → timing → footage loop math → assemble → spec).

Usage:
  python backend/session_voice.py --op list [--sid <id>]
  python backend/session_voice.py --op preview --voice af_bella [--sid <id>] [--speed 1.0]
  python backend/session_voice.py --op apply --sid <id> --voice af_bella [--speed 1.1]
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import hashlib
import json
from session import api, store, job_ctx
from pipeline import tts as tts_stage
from pipeline import projects as projects_mod

SAMPLE_LINE = "Here is how this voice sounds reading your script."


def _beat1_text(sid: str) -> str | None:
    """Return beat 1's first ≤12 whitespace-delimited words for the given session.

    Returns None if the session has no completed script stage yet (caller falls
    back to the canned SAMPLE_LINE).  Never calls an LLM or the network.
    """
    from session import codecs
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_stage(conn, sid, "script")
        if row is None or row["output_json"] is None:
            return None
        bundle = codecs.script_bundle_from_json(json.loads(row["output_json"]))
        beats = bundle["script"].beats
        if not beats:
            return None
        words = beats[0].text.split()
        return " ".join(words[:12])
    except Exception as e:
        # degraded mode is canned-line fallback by design, but say why on
        # stderr (codec drift would otherwise silently downgrade every
        # preview; _spawn.ts keeps stderr off the stdout JSON protocol)
        print(f"voice preview: beat-1 lookup failed for {sid!r}: {e}", file=sys.stderr)
        return None
    finally:
        conn.close()


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


def _row_for(sid: str) -> tuple[str, int]:
    """Return (topic, target_length) from the stored session row."""
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"], row["target_length"]
    finally:
        conn.close()


def list_voices(sid: str | None = None) -> dict:
    current = None
    if sid:
        current = projects_mod.read_voice(job_ctx.REPO_ROOT, sid)
    return {"ok": True, "voices": tts_stage.VOICES, "current": current}


def preview(voice: str, *, speed: float = 1.0, sid: str | None = None) -> dict:
    if not tts_stage.is_valid_voice(voice):
        raise ValueError(f"unknown voice {voice!r}")
    # M3: use beat 1's first ≤12 words when sid is given and a script exists;
    # fall back to canned line silently (no crash, zero LLM calls).
    text = ((_beat1_text(sid) if sid else None) or SAMPLE_LINE)
    text_hash = hashlib.sha1(text.encode()).hexdigest()[:12]
    name = f"voice_preview_{voice}_{text_hash}_{str(speed).replace('.', '_')}.wav"
    dest = job_ctx.ASSETS_DIR / name
    if not dest.exists():  # cache per (voice, text, speed)
        job_ctx.ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        tts_stage.synthesize([text], dest, voice=voice, speed=speed)
    return {"ok": True, "voice": voice, "speed": speed, "path": f"assets/{name}"}


def apply(sid: str, *, voice: str, speed: float = 1.0) -> dict:
    if not tts_stage.is_valid_voice(voice):
        raise ValueError(f"unknown voice {voice!r}")
    topic, target_length = _row_for(sid)
    ctx = job_ctx.build_ctx(topic=topic, sid=sid, voice=voice, speed=speed,
                            target_length=target_length)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        from session import store as _store, gatekeeper as _gatekeeper
        if _store.get_gate_states(sess.conn, sess.id):
            # Gated session (v3): defer via gatekeeper — gatekeeper.set_voice
            # writes the voice sidecar and reopens the gate (no re-synthesis).
            _gatekeeper.set_voice(sess, voice=voice, speed=speed)
            return {"ok": True, "sid": sid, "voice": voice, "speed": speed}
        # Ungated session (v2/autopilot): byte-identical original path.
        projects_mod.write_voice(job_ctx.REPO_ROOT, sid, voice=voice, speed=speed)
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
            res = preview(args.voice, speed=args.speed, sid=args.sid)
        else:  # apply
            if not args.sid or not args.voice:
                raise ValueError("--sid and --voice are required for apply")
            res = apply(args.sid, voice=args.voice, speed=args.speed)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
