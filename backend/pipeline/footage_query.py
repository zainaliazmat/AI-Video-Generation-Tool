"""Deterministic footage-query hardening (Phase-4 Item 1).

Layer-B testing proved a prompt rule can't make the model predict which keywords
collide with a dominant unrelated Pexels meaning (memory/phase4-footage-relevance.md).
So this is the ruled next lever: a FROZEN lexicon remapping known colliding keywords
to a filmable replacement, plus a conservative named-entity guard that degrades an
UNKNOWN capitalized-proper-noun query to the title fallback rather than ship a
known-bad named search. Pure + deterministic — no provider calls. LLM query
re-derivation is the A.2 footage gate's job, not this.
"""
from __future__ import annotations

import re

# colliding phrase (normalized) -> filmable replacement. Seeded from the Layer-A map
# (confirmed eyes-on wins) + the banked Antikythera-render bugs. Auditable like CREDITS.
COLLISION_LEXICON: dict[str, str] = {
    "hand crank": "antique brass gears turning",        # → coffee grinder
    "celestial globe": "ancient astronomical instrument",  # → celestial body / exoplanet
    "ocean evaporation steam": "sea mist over waves",   # → geothermal vent
    "wooden box": "antique astronomical instrument",    # the Antikythera "drawer" miss
    "antikythera mechanism": "antique astronomical instrument",  # → typewriter/drawer
    "antikythera": "antique astronomical instrument",
    "challenger deep": "dark ocean abyss",              # → aquarium
    "nobel medal": "physics laboratory",
}

_STOPWORDS = {"the", "a", "an", "of", "and", "in", "on", "at", "to", "for", "with"}
_WORD = re.compile(r"[A-Za-z][A-Za-z'\-]*")


def _normalize(q: str) -> str:
    return re.sub(r"\s+", " ", q.strip().lower())


def _propers(text: str) -> set[str]:
    """Lowercased set of CAPITALIZED, length>=4, non-stopword tokens in `text`
    (original case). A conservative proper-noun signal: a lowercase token never
    qualifies, so a clean lowercase keyword cannot trip the guard."""
    out: set[str] = set()
    for tok in _WORD.findall(text):
        if len(tok) >= 4 and tok[0].isupper() and tok.lower() not in _STOPWORDS:
            out.add(tok.lower())
    return out


def harden(query: str, *, title: str) -> str:
    norm = _normalize(query)
    if not norm:
        return query
    # Layer A — frozen lexicon: exact phrase, then substring containment.
    if norm in COLLISION_LEXICON:
        return COLLISION_LEXICON[norm]
    for phrase, repl in COLLISION_LEXICON.items():
        if phrase in norm:
            return repl
    # Layer B — named-entity guard (biased to FALSE-NEGATIVE): fire only when a token
    # the model CAPITALIZED in the query is ALSO a capitalized proper noun in the
    # title (the named subject). Both signals required, so a clean lowercase keyword
    # is never degraded. Degrade to the title (the existing broaden fallback).
    if _propers(query) & _propers(title):
        return title
    return query
