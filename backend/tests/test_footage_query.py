"""Item 1 — deterministic footage-query hardening. Layer B proved prompt-only
steering can't predict Pexels collisions; this frozen lexicon remaps known
colliding keywords to a filmable replacement, and a conservative named-entity
guard degrades an UNKNOWN capitalized-proper-noun query to the title fallback.
Pure + deterministic — no provider calls. Seeded from the Layer-A map in
memory/phase4-footage-relevance.md.
"""
from pipeline.footage_query import harden, COLLISION_LEXICON


def test_lexicon_remaps_a_known_collision_whole_phrase():
    assert harden("hand crank", title="Antique Clocks") == "antique brass gears turning"


def test_lexicon_remaps_when_the_phrase_is_contained_in_a_longer_query():
    assert harden("old celestial globe closeup", title="Astronomy") == "ancient astronomical instrument"


def test_lexicon_is_case_and_whitespace_insensitive():
    assert harden("  Hand   Crank ", title="X") == "antique brass gears turning"


def test_clean_keyword_passes_through_unchanged():
    assert harden("brass clockwork gears", title="Antique Clocks") == "brass clockwork gears"


def test_named_subjects_from_layer_a_are_all_seeded():
    for key in ["hand crank", "celestial globe", "ocean evaporation steam",
                "wooden box", "antikythera mechanism", "challenger deep", "nobel medal"]:
        assert key in COLLISION_LEXICON, f"missing lexicon seed: {key!r}"
