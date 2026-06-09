"""The declarative pipeline shape for the session engine: stage ORDER, each
stage's upstream DEPS (whose outputs feed it), and the DOWNSTREAM invalidation set
(the HITL spec §3.3 matrix). Encoded in ONE place so the deps and the matrix can
never drift apart. Executors live in executors.py (kept separate so this stays a
pure data module)."""
from __future__ import annotations

STAGE_ORDER = ["script", "voice", "timing", "footage", "assemble", "render"]

# stage -> upstream stages whose outputs it consumes.
_DEPS = {
    "script": [],
    "voice": ["script"],
    "timing": ["voice"],
    "footage": ["script", "voice"],
    "assemble": ["script", "voice", "timing", "footage"],
    "render": ["assemble"],
}


def deps(stage: str) -> list[str]:
    return list(_DEPS[stage])


def downstream(stage: str) -> list[str]:
    """Stages that must be marked stale when `stage` changes — all stages that
    transitively depend on `stage` (via the _DEPS graph), returned in STAGE_ORDER.
    This is the §3.3 invalidation matrix: only stages that actually consume `stage`
    (directly or indirectly) are invalidated. Crucially, `timing` does NOT invalidate
    `footage` because footage does not depend on timing — they are parallel branches
    that both feed into assemble."""
    invalidated = set()
    worklist = [stage]
    while worklist:
        current = worklist.pop()
        for s, d in _DEPS.items():
            if current in d and s not in invalidated:
                invalidated.add(s)
                worklist.append(s)
    return [s for s in STAGE_ORDER if s in invalidated]
