"""Step 6.2 — the recipe/director DERIVATION TABLE (the reliability core).

These truth-tests are the contract for deterministic composition:
  * the model never names a `kind`; the recipe derives slot/template from
    beat POSITION + DATA SHAPE only (constraint #1),
  * positional hook/outro (locked #1), with graceful N=1 / N=2,
  * stat-wins on value-shaped data, middle beats only (locked #4),
  * SELECTIVE transitions by default — emphasis only, into stat / into outro
    (locked #3); `every` and `none` are knobs,
  * transitions are INTENT only (no durations here — assemble resolves Tᵢ).

`plan()` is pure: no I/O, no audio, no frames.
"""
import pytest

from pipeline.content import BeatsScript
from pipeline.recipe import plan, PlannedScene, ScenePlan
from schema import Theme


def _script(*beats, title="My Title"):
    return BeatsScript(title=title, beats=list(beats))


def _beat(text, **kw):
    return {"text": text, **kw}


def _roles(p):
    return [s.role for s in p.scenes]


def _templates(p):
    return [s.template for s in p.scenes]


# ── positional slotting ────────────────────────────────────────────────────

def test_first_is_hook_last_is_outro_middle_is_scene():
    p = plan(_script(_beat("open"), _beat("middle"), _beat("close")), theme=Theme())
    assert _roles(p) == ["hook", "scene", "outro"]
    assert _templates(p) == ["hook", "scene", "outro"]


def test_single_beat_is_hook_not_outro():
    p = plan(_script(_beat("only")), theme=Theme())
    assert _roles(p) == ["hook"]


def test_two_beats_are_hook_then_outro_no_middle():
    p = plan(_script(_beat("open"), _beat("close")), theme=Theme())
    assert _roles(p) == ["hook", "outro"]


def test_position_wins_over_data_on_first_and_last():
    # numeric data on the first/last beat must NOT turn them into stats
    p = plan(
        _script(
            _beat("open", data={"value": "1", "label": "first"}),
            _beat("mid"),
            _beat("close", data={"value": "9", "label": "last"}),
        ),
        theme=Theme(),
    )
    assert _roles(p) == ["hook", "scene", "outro"]


# ── stat derivation (middle beats only) ────────────────────────────────────

def test_middle_value_labeled_data_becomes_stat_no_footage():
    p = plan(
        _script(_beat("open"), _beat("fact", data={"value": "90%", "label": "unmapped"}), _beat("close")),
        theme=Theme(),
    )
    assert _roles(p) == ["hook", "stat", "outro"]
    stat = p.scenes[1]
    assert stat.needs_footage is False
    assert stat.query is None


def test_value_without_label_is_not_a_stat_falls_back_to_scene():
    p = plan(
        _script(_beat("open"), _beat("fact", data={"value": "90%"}), _beat("close")),
        theme=Theme(),
    )
    assert p.scenes[1].role == "scene"
    assert p.scenes[1].needs_footage is True


def test_data_without_value_is_not_a_stat():
    p = plan(
        _script(_beat("open"), _beat("fact", data={"label": "no number"}), _beat("close")),
        theme=Theme(),
    )
    assert p.scenes[1].role == "scene"


# ── footage queries ────────────────────────────────────────────────────────

def test_scene_query_prefers_keywords():
    p = plan(_script(_beat("open"), _beat("a jellyfish drifts", keywords="jellyfish"), _beat("close")), theme=Theme())
    assert p.scenes[1].query == "jellyfish"


def test_scene_query_falls_back_to_text():
    p = plan(_script(_beat("open"), _beat("a jellyfish drifts"), _beat("close")), theme=Theme())
    assert p.scenes[1].query == "a jellyfish drifts"


def test_hook_stat_outro_carry_no_footage():
    p = plan(
        _script(_beat("open"), _beat("f", data={"value": "5", "label": "x"}), _beat("close")),
        theme=Theme(),
    )
    for s in p.scenes:
        assert s.needs_footage is False
        assert s.query is None


# ── prop filling (policy — flagged for review) ─────────────────────────────

def test_hook_props_headline_from_first_beat_kicker_from_title():
    # 3.2: the SPOKEN hook is the dominant line; the (generic) topic rides as a
    # small kicker. The hook component sizes `title` for a full sentence.
    p = plan(_script(_beat("the spoken hook"), _beat("m"), _beat("c"), title="Three Facts"), theme=Theme())
    assert p.scenes[0].props == {"title": "the spoken hook", "subtitle": "Three Facts"}


def test_stat_props_from_data_including_optional_icon():
    p = plan(
        _script(_beat("open"), _beat("f", data={"value": "90%", "label": "unmapped", "icon": "🌊"}), _beat("close")),
        theme=Theme(),
    )
    assert p.scenes[1].props == {"value": "90%", "label": "unmapped", "icon": "🌊"}


def test_stat_props_omit_icon_when_absent():
    p = plan(
        _script(_beat("open"), _beat("f", data={"value": "3", "label": "hearts"}), _beat("close")),
        theme=Theme(),
    )
    assert p.scenes[1].props == {"value": "3", "label": "hearts"}


def test_outro_props_title_from_last_beat():
    p = plan(_script(_beat("o"), _beat("m"), _beat("follow for more")), theme=Theme())
    assert p.scenes[-1].props == {"title": "follow for more"}


def test_scene_props_empty_media_filled_at_assemble():
    p = plan(_script(_beat("o"), _beat("middle scene"), _beat("c")), theme=Theme())
    assert p.scenes[1].props == {}


# ── transitions: SELECTIVE default (emphasis only) ─────────────────────────

def test_selective_transition_only_into_stat_and_outro():
    # roles: hook, scene, stat, scene, outro
    p = plan(
        _script(
            _beat("hook"),
            _beat("plain scene a"),
            _beat("stat", data={"value": "1", "label": "x"}),
            _beat("plain scene b"),
            _beat("outro"),
        ),
        theme=Theme(),  # default policy = selective
    )
    # transition lives on the scene BEFORE the emphasised one
    t = [s.transition is not None for s in p.scenes]
    #     hook   sceneA  stat   sceneB  outro
    # into: -    stat    -      outro   (last never)
    assert t == [False, True, False, True, False]


def test_selective_default_no_transitions_when_all_plain_scenes():
    p = plan(_script(_beat("h"), _beat("a"), _beat("b"), _beat("o")), theme=Theme())
    # hook, scene, scene, outro — only the scene before outro gets one
    assert [s.transition is not None for s in p.scenes] == [False, False, True, False]


def test_selective_no_fade_from_a_text_card_source():
    # hook(text) -> stat -> outro: both boundaries are text-card -> text-card.
    # A crossfade between two centered text cards double-exposes (verified on the
    # render), so selective fades fire ONLY from a footage scene → all hard cuts.
    p = plan(
        _script(_beat("h"), _beat("f", data={"value": "5", "label": "x"}), _beat("o")),
        theme=Theme(),
    )
    assert [s.transition is not None for s in p.scenes] == [False, False, False]


def test_selective_fade_only_from_footage_source():
    # hook, scene(footage), stat, outro: scene->stat fades (footage source, clean);
    # stat->outro hard-cuts (text source would double-expose).
    p = plan(
        _script(_beat("h"), _beat("plain scene"), _beat("f", data={"value": "5", "label": "x"}), _beat("o")),
        theme=Theme(),
    )
    assert [s.transition is not None for s in p.scenes] == [False, True, False, False]


def test_policy_every_puts_transition_on_all_but_last():
    p = plan(_script(_beat("h"), _beat("a"), _beat("o")), theme=Theme(), transition_policy="every")
    assert [s.transition is not None for s in p.scenes] == [True, True, False]


def test_policy_none_emits_no_transitions():
    p = plan(_script(_beat("h"), _beat("a"), _beat("o")), theme=Theme(), transition_policy="none")
    assert all(s.transition is None for s in p.scenes)


def test_unknown_transition_policy_raises_loudly():
    with pytest.raises(ValueError):
        plan(_script(_beat("h"), _beat("a"), _beat("o")), theme=Theme(), transition_policy="slelective")


def test_final_scene_never_has_outgoing_transition():
    p = plan(_script(_beat("h"), _beat("a"), _beat("o")), theme=Theme(), transition_policy="every")
    assert p.scenes[-1].transition is None


def test_transition_template_comes_from_theme():
    p = plan(_script(_beat("h"), _beat("a"), _beat("o")), theme=Theme(transition="slide"), transition_policy="every")
    assert p.scenes[0].transition.template == "slide"


# ── catalog indirection (slot -> template id) ──────────────────────────────

def test_custom_template_catalog_maps_slots():
    p = plan(
        _script(_beat("h"), _beat("m"), _beat("o")),
        theme=Theme(),
        templates={"hook": "hook-v2", "scene": "scene", "stat": "stat", "outro": "outro-fancy"},
    )
    assert _templates(p) == ["hook-v2", "scene", "outro-fancy"]
    # role stays the slot; template is the resolved id
    assert _roles(p) == ["hook", "scene", "outro"]
