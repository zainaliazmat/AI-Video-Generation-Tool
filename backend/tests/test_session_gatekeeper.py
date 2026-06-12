"""Studio v3 gatekeeper — Task 4 tests.

Imports helpers from test_session_engine (same process, not a subprocess) so the
fake-pipeline wiring stays in one place. Adapter names match the REAL helpers
in that file (_fakes_with_counts, _mk_session(tmp_path, monkeypatch)).
"""
from __future__ import annotations

import pytest

from session import gatekeeper, store

# Re-use the helpers that Task 3 added to test_session_engine. The import is
# explicit — if a rename breaks this, the compiler tells us immediately.
from tests.test_session_engine import _fakes_with_counts, _mk_session


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
