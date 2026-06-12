"""Studio v3 gatekeeper — Task 4 tests."""
from __future__ import annotations

import pytest

from session import gatekeeper, store
from tests.session_helpers import fakes_with_counts as _fakes_with_counts, mk_session as _mk_session


# ---------------------------------------------------------------------------
# Task 4: gatekeeper.start halts at the script gate
# ---------------------------------------------------------------------------

def test_start_halts_at_script_gate(tmp_path, monkeypatch):
    calls = _fakes_with_counts(monkeypatch)
    sess = _mk_session(tmp_path, monkeypatch)

    events = []
    gatekeeper.start(sess, on_stage=lambda s, st, el: events.append((s, st)))

    # script executor ran exactly once
    assert calls["script"] == 1

    # downstream stages were NOT executed
    for st in ("voice", "timing", "footage", "assemble"):
        assert store.get_stage(sess.conn, sess.id, st) is None, \
            f"stage {st!r} ran but should not have"

    # script gate is awaiting approval
    gate_states = store.get_gate_states(sess.conn, sess.id)
    assert gate_states["script"]["state"] == "awaiting_approval"

    # on_stage received exactly the running + done events for script
    assert events == [("script", "running"), ("script", "done")]
