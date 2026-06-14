"""Compose the additive USER-prompt block from the operator's preferences.

Single source of truth for what goes into `extra_user_block`, used at BOTH script
entry points so the channel voice applies on the first generation AND on regenerate:

    extra_user_block = STYLE PREFERENCES   (global prefs ⊕ per-video override)
                     + STYLE MEMORY        (learned from past edits)
                     + OPERATOR FEEDBACK   (this regeneration only)

Each part is additive and grounding-safe; an empty result is '' so the generation
prompt stays byte-identical to a no-prefs / no-memory run.
"""
from __future__ import annotations

import json

from session import store, job_ctx
from pipeline import script_prefs, style_memory


def _override_for(sid: str | None) -> dict:
    """Load the session's per-video prefs override (JSON column), or {}."""
    if not sid:
        return {}
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        raw = store.get_prefs_override(conn, sid)
    finally:
        conn.close()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def prefs_block(sid: str | None, *, override: dict | None = None) -> str:
    """Render the merged (global ⊕ per-video) channel-voice block, or ''.
    `override` wins when given (the start path, where the session row isn't written
    yet); otherwise the per-video override is read back from the session row."""
    glob = script_prefs.load(job_ctx.STYLE_PREFS_PATH)
    ov = override if override is not None else _override_for(sid)
    merged = script_prefs.merge(glob, ov)
    return script_prefs.to_prompt_block(merged)


def compose_extra_block(sid: str | None, *, feedback: str = "",
                        override: dict | None = None) -> str:
    """Assemble the full additive USER block (prefs + style memory + feedback).
    Returns '' when every part is empty (byte-identical to a plain run)."""
    parts: list[str] = []
    pb = prefs_block(sid, override=override)
    if pb:
        parts.append(pb)
    mem_block = style_memory.to_prompt_block(style_memory.load(job_ctx.STYLE_MEMORY_PATH))
    if mem_block:
        parts.append(mem_block)
    if feedback.strip():
        parts.append(f"OPERATOR FEEDBACK for this regeneration: {feedback.strip()}")
    return "\n\n".join(parts)
