"""HITL A.1 — the declarative stage table: order, deps, and the §3.3 downstream
invalidation matrix (encoded once so the routing signal can't drift)."""
import pytest

from session import stages


def test_stage_order():
    assert stages.STAGE_ORDER == ["script", "voice", "timing", "footage", "assemble", "render"]


def test_downstream_matrix_matches_spec():
    assert stages.downstream("script") == ["voice", "timing", "footage", "assemble", "render"]
    assert stages.downstream("voice") == ["timing", "footage", "assemble", "render"]
    assert stages.downstream("timing") == ["assemble", "render"]
    assert stages.downstream("footage") == ["assemble", "render"]   # footage never feeds span/timing
    assert stages.downstream("assemble") == ["render"]
    assert stages.downstream("render") == []


def test_deps():
    assert stages.deps("script") == []
    assert stages.deps("voice") == ["script"]
    assert stages.deps("timing") == ["voice"]
    assert sorted(stages.deps("footage")) == ["script", "voice"]
    assert sorted(stages.deps("assemble")) == ["footage", "script", "timing", "voice"]


def test_unknown_stage_fails_loud():
    # both routing functions must reject a misspelled stage rather than silently
    # returning [] (which would invalidate nothing — a dangerous no-op).
    with pytest.raises(KeyError):
        stages.deps("typo")
    with pytest.raises(KeyError):
        stages.downstream("typo")
