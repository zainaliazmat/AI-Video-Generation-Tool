"""Channel-voice script preferences — the operator's reusable scriptwriting style.

The honest sibling of style_memory: where style_memory LEARNS preferences from past
edits, this module holds the preferences the operator DECLARES up front (tone,
audience, hook style, personality, niche…), collected once and reused on every
generation. Like style_memory it composes into the script prompt as an ADDITIVE
USER block (`to_prompt_block`) — never rewriting the frozen SYSTEM_PROMPT or the
grounding rules. Empty prefs render to '' so the prompt stays byte-identical to a
no-prefs run.

Two scopes compose via `merge()`:
  - GLOBAL default: one JSON doc at the repo/user level (STYLE_PREFS_PATH).
  - PER-VIDEO override: a partial doc persisted on the session row; non-empty fields
    win over the global default field-by-field.

Local-first JSON, never raises on a missing/corrupt file (it must not block a run).
NOTE: video length is NOT a pref here — it maps onto the existing target_length
preset (30/60/180/300s); duplicating it would fight that control.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

# The questionnaire (the pasted Script Writer skill), structured. Every field is
# OPTIONAL: an unset field emits no guidance line, so a partly-filled doc is valid.
EMPTY: Dict = {
    "tone": "",                # casual-friendly | professional | energetic | educational | inspirational | humorous
    "audience": {"age_range": "", "knowledge_level": "", "interests": []},
    "style": {
        "wording": "",          # simple-direct | descriptive | technical | storytelling
        "sentence_length": "",  # short-punchy | medium | long-flowing
        "use_questions": None,  # True | False | None(unset)
        "use_statistics": "",   # heavy | moderate | light | none
    },
    "hook_style": "",          # question | bold-statement | problem | promise | shock | story
    "personality": "",         # energetic | calm | witty | serious | passionate | relatable
    "use_humor": "",           # yes | sparingly | no
    "storytelling": "",        # heavy | moderate | light
    "cta_preference": "",      # direct | soft | minimal
    "channel_niche": "",
    "script_types": [],        # educational | listicle | story | review | commentary | how-to | explainer
}


def _empty() -> Dict:
    """A fresh deep copy of EMPTY (never hand out the shared module-level dict)."""
    return json.loads(json.dumps(EMPTY))


def load(path) -> Dict:
    """Load prefs, returning a fresh empty doc if the file is absent or unreadable
    (never raise on a missing/corrupt prefs file — it must not block a run)."""
    p = Path(path)
    if not p.exists():
        return _empty()
    try:
        data = json.loads(p.read_text())
    except (ValueError, OSError):
        return _empty()
    if not isinstance(data, dict):
        return _empty()
    # Backfill any missing top-level keys so callers can index freely.
    base = _empty()
    base.update({k: v for k, v in data.items() if k in base})
    # Nested dicts: backfill sub-keys too.
    for k in ("audience", "style"):
        if isinstance(data.get(k), dict):
            merged = _empty()[k]
            merged.update({kk: vv for kk, vv in data[k].items() if kk in merged})
            base[k] = merged
    return base


def save(path, prefs: Dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(prefs, indent=2))


def is_initialized(path) -> bool:
    """True once the operator has saved any non-empty preference (maps the skill's
    `is_initialized` check). A file of all-empty fields counts as uninitialized."""
    return _has_content(load(path))


def _has_content(prefs: Dict) -> bool:
    """Any field set to a non-empty / non-None value."""
    p = prefs
    a = p.get("audience", {}) or {}
    s = p.get("style", {}) or {}
    scalars = [
        p.get("tone"), p.get("hook_style"), p.get("personality"),
        p.get("use_humor"), p.get("storytelling"), p.get("cta_preference"),
        p.get("channel_niche"),
        a.get("age_range"), a.get("knowledge_level"),
        s.get("wording"), s.get("sentence_length"), s.get("use_statistics"),
    ]
    if any(bool(x) for x in scalars):
        return True
    if s.get("use_questions") is not None:
        return True
    if (a.get("interests") or []) or (p.get("script_types") or []):
        return True
    return False


def merge(global_prefs: Dict, override: Dict | None) -> Dict:
    """Field-by-field merge: a non-empty override value wins, else the global value.
    Nested `audience`/`style` merge per sub-key; lists/scalars replace when non-empty.
    `style.use_questions` is special: a non-None override (incl. False) wins."""
    base = _coerce(global_prefs or {})
    ov = _coerce(override or {})
    out = json.loads(json.dumps(base))
    for k in ("tone", "hook_style", "personality", "use_humor", "storytelling",
              "cta_preference", "channel_niche"):
        if ov.get(k):
            out[k] = ov[k]
    if ov.get("script_types"):
        out["script_types"] = ov["script_types"]
    for grp in ("audience", "style"):
        for kk, vv in (ov.get(grp) or {}).items():
            if kk == "use_questions":
                if vv is not None:
                    out[grp][kk] = vv
            elif vv:
                out[grp][kk] = vv
    return out


def _coerce(prefs: Dict) -> Dict:
    """Normalize an arbitrary dict into the full-shaped doc (backfilled keys)."""
    base = _empty()
    base.update({k: v for k, v in prefs.items() if k in base})
    for k in ("audience", "style"):
        if isinstance(prefs.get(k), dict):
            merged = _empty()[k]
            merged.update({kk: vv for kk, vv in prefs[k].items() if kk in merged})
            base[k] = merged
    return base


_TONE_PHRASE = {
    "casual-friendly": "casual and friendly",
    "professional": "professional and authoritative",
    "energetic": "energetic and enthusiastic",
    "educational": "educational and patient",
    "inspirational": "inspirational and motivating",
    "humorous": "humorous and entertaining",
}
_HOOK_PHRASE = {
    "question": "open with a direct question to the viewer",
    "bold-statement": "open with a bold statement",
    "problem": "open by naming a problem or pain point",
    "promise": "open with a clear promise or benefit",
    "shock": "open with a surprising, scroll-stopping fact",
    "story": "open with a short story beat",
}
_PERSONALITY_PHRASE = {
    "energetic": "energetic and animated",
    "calm": "calm and measured",
    "witty": "witty and humorous",
    "serious": "serious and thoughtful",
    "passionate": "passionate and intense",
    "relatable": "relatable and down-to-earth",
}
_WORDING_PHRASE = {
    "simple-direct": "simple and direct",
    "descriptive": "descriptive and vivid",
    "technical": "technical and precise",
    "storytelling": "storytelling-driven",
}
_SENTENCE_PHRASE = {
    "short-punchy": "short, punchy sentences",
    "medium": "medium-length sentences",
    "long-flowing": "longer, flowing sentences",
}


def to_prompt_block(prefs: Dict) -> str:
    """Compose an ADDITIVE channel-voice block for the script generation prompt.
    Returns '' when no field is set (so the prompt is byte-identical to a no-prefs
    run). Appended to the USER prompt, never the frozen SYSTEM_PROMPT, and every
    line is framed as a soft style guide that never overrides grounding."""
    p = _coerce(prefs)
    if not _has_content(p):
        return ""
    a = p["audience"]
    s = p["style"]
    lines = [
        "",
        "STYLE PREFERENCES (this channel's voice; few-shot style guides,",
        "NOT rules that override grounding or invent facts):",
    ]

    if p.get("tone"):
        lines.append(f"- Tone: {_TONE_PHRASE.get(p['tone'], p['tone'])}")

    aud_bits = []
    if a.get("knowledge_level"):
        aud_bits.append(a["knowledge_level"])
    if a.get("age_range"):
        aud_bits.append(a["age_range"])
    if a.get("interests"):
        aud_bits.append("into " + ", ".join(a["interests"]))
    if aud_bits:
        lines.append(f"- Audience: {', '.join(aud_bits)}")

    if p.get("hook_style"):
        lines.append(f"- Hook: {_HOOK_PHRASE.get(p['hook_style'], p['hook_style'])}")

    style_bits = []
    if s.get("wording"):
        style_bits.append(_WORDING_PHRASE.get(s["wording"], s["wording"]))
    if s.get("sentence_length"):
        style_bits.append(_SENTENCE_PHRASE.get(s["sentence_length"], s["sentence_length"]))
    if s.get("use_questions") is True:
        style_bits.append("use rhetorical questions")
    elif s.get("use_questions") is False:
        style_bits.append("avoid rhetorical questions")
    if style_bits:
        lines.append(f"- Wording: {'; '.join(style_bits)}")

    if s.get("use_statistics") and s["use_statistics"] != "none":
        lines.append(f"- Use statistics: {s['use_statistics']} "
                     "(only when a source supports them)")
    elif s.get("use_statistics") == "none":
        lines.append("- Use statistics: avoid leaning on numbers")

    persona_bits = []
    if p.get("personality"):
        persona_bits.append(_PERSONALITY_PHRASE.get(p["personality"], p["personality"]))
    if p.get("use_humor") == "yes":
        persona_bits.append("with humor")
    elif p.get("use_humor") == "sparingly":
        persona_bits.append("with light, sparing humor")
    elif p.get("use_humor") == "no":
        persona_bits.append("no jokes")
    if persona_bits:
        lines.append(f"- Personality: {'; '.join(persona_bits)}")

    if p.get("storytelling"):
        lines.append(f"- Storytelling: {p['storytelling']}")

    if p.get("cta_preference"):
        lines.append(f"- Call to action: {p['cta_preference']}")

    if p.get("channel_niche"):
        lines.append(f"- Channel niche: {p['channel_niche']}")

    if p.get("script_types"):
        lines.append(f"- Format leanings: {', '.join(p['script_types'])}")

    return "\n".join(lines)
