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


def test_guard_degrades_unknown_capitalized_proper_noun_to_title():
    assert harden("Voynich script", title="The Voynich Manuscript") == "The Voynich Manuscript"


def test_guard_does_not_fire_on_lowercase_keyword_false_negative_bias():
    assert harden("voynich script", title="The Voynich Manuscript") == "voynich script"


def test_guard_does_not_fire_when_no_title_overlap():
    assert harden("Sahara dunes", title="Deep Ocean Trenches") == "Sahara dunes"


def test_clean_lowercase_keyword_with_titlecased_common_title_is_untouched():
    assert harden("ocean trench", title="Deep Ocean") == "ocean trench"


def test_harden_is_idempotent():
    t = "The Antikythera Mechanism"
    once = harden("antikythera mechanism", title=t)
    assert harden(once, title=t) == once
    t2 = "The Voynich Manuscript"
    once2 = harden("Voynich script", title=t2)
    assert harden(once2, title=t2) == once2
