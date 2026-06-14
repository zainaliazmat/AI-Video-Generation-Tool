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

# Leading count ("3 ", "top 5 ") — mirrors script._COUNT_PREFIX so topic anchoring
# strips the same framing the title cleaner does.
_COUNT_PREFIX = re.compile(r"^\s*(?:top\s+)?\d+\s+", re.IGNORECASE)
# Leading list framing ("facts about ", "ways to ", "types of ") that wraps the real
# subject in listicle phrasing: optional leading adjectives, a list noun, then a
# connective — stripped so only the subject remains to anchor on.
_LIST_FRAME = re.compile(
    r"^(?:[a-z]+\s+)*?"
    r"(?:facts?|things?|ways?|reasons?|tips?|secrets?|types?|kinds?|examples?|"
    r"myths?|mistakes?|lessons?|rules?|signs?|steps?)\s+"
    r"(?:about|of|on|in|for|to|regarding)\s+",
    re.IGNORECASE,
)


def _normalize(q: str) -> str:
    return re.sub(r"\s+", " ", q.strip().lower())


def _propers(text: str) -> set[str]:
    """Return the lowercased set of uppercase-initial, length>=4, non-stopword tokens
    found in `text`. `text` must be the ORIGINAL (non-normalized) string so that
    capitalization signals proper-noun status. A lowercase-initial token never
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
    # First-match-wins: a more-specific phrase MUST be inserted before its substring
    # in COLLISION_LEXICON (e.g. "antikythera mechanism" before "antikythera") so the
    # specific entry isn't shadowed.
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


def _depluralize(token: str) -> str:
    """Naive trailing-'s' strip so an overlap check is singular/plural-insensitive
    ('reefs' ~ 'reef'). Only for comparison, never for the emitted query. Skips short
    words and '-ss' endings ('glass', 'bus') to avoid mangling non-plurals."""
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def _content_roots(text: str) -> set[str]:
    """Lowercased, depluralized word tokens minus stopwords — the subject roots used
    to tell whether a keyword already names the topic (so anchoring is a no-op)."""
    return {_depluralize(t.lower()) for t in _WORD.findall(text) if t.lower() not in _STOPWORDS}


def topic_anchor(topic: str) -> str:
    """Raw user topic → a short, Pexels-safe subject anchor for footage queries.

    Strips leading count + list framing ("3 facts about octopuses" → "octopuses";
    "top 5 ways to save money" → "save money"), then routes the result through
    harden() so a colliding/proper-noun subject degrades to a filmable category
    ("the Antikythera mechanism" → "antique astronomical instrument") instead of a
    zero-result named search. Returns "" for an empty/degenerate topic, so the caller
    anchors nothing and falls back to today's behavior."""
    stripped = _COUNT_PREFIX.sub("", topic, count=1)
    stripped = _LIST_FRAME.sub("", stripped, count=1).strip()
    if not stripped:
        return ""
    return harden(stripped, title=stripped)


def anchor_query(query: str, anchor: str) -> str:
    """Prepend `anchor` (a subject from topic_anchor) to a per-scene footage query so
    the video's domain survives Pexels' literal matching ("color changing skin" →
    "octopuses color changing skin").

    No-op when either side is empty, or when the query already names the subject (a
    shared content token): an on-subject keyword stays byte-identical, so the anchor
    fires only when the keyword has drifted off the subject."""
    if not anchor or not query.strip():
        return query
    if _content_roots(anchor) & _content_roots(query):
        return query
    return f"{anchor} {query}"
