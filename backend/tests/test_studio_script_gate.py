"""Studio v2 — Script gate backend: style memory, verify-on-edit, engine script edit,
and the additive-prompt / frozen-rule guards (PRD §6.1)."""
from types import SimpleNamespace

import pytest

from schema import Theme
from session import store, engine, executors
from pipeline import style_memory, verify as verify_stage
from pipeline.content import BeatsScript, Beat


# ---------------- style memory ----------------

def test_style_memory_empty_block_is_blank():
    assert style_memory.to_prompt_block({"examples": [], "guidance": []}) == ""


def test_style_memory_records_edit_and_caps_fifo():
    mem = {"examples": [], "guidance": []}
    for n in range(20):
        style_memory.record_edit(mem, before=f"b{n}", after=f"a{n}")
    assert len(mem["examples"]) == style_memory.MAX_EXAMPLES
    # FIFO: the oldest were evicted, the newest kept
    afters = [e["after"] for e in mem["examples"]]
    assert "a19" in afters and "a0" not in afters


def test_style_memory_pin_survives_fifo():
    mem = {"examples": [], "guidance": []}
    style_memory.record_edit(mem, before="keep-before", after="keep-after")
    style_memory.pin(mem, kind="example", index=0, value=True)
    for n in range(20):
        style_memory.record_edit(mem, before=f"b{n}", after=f"a{n}")
    afters = [e["after"] for e in mem["examples"]]
    assert "keep-after" in afters                    # pinned, never evicted
    assert len(mem["examples"]) <= style_memory.MAX_EXAMPLES + 1


def test_style_memory_block_alters_a_prompt():
    from pipeline import script as script_stage
    mem = {"examples": [{"before": "Magma is hot.", "after": "Magma burns at 1250C."}],
           "guidance": [{"text": "prefer beats under 14 words"}]}
    block = style_memory.to_prompt_block(mem)
    plain = script_stage.build_user_prompt("Volcanoes", evidence_block="S")
    seeded = script_stage.build_user_prompt("Volcanoes", evidence_block="S", extra_user_block=block)
    assert seeded != plain
    assert "prefer beats under 14 words" in seeded
    assert "1250C" in seeded


def test_frozen_system_prompt_byte_identical_after_seam():
    """PRD risk mitigation: the additive seam must never touch the frozen SYSTEM_PROMPT."""
    from pipeline import script as script_stage
    expected_head = "You are a faceless"  # sanity that we are reading the real prompt
    assert script_stage.SYSTEM_PROMPT  # non-empty
    # Build a prompt with a big style block; SYSTEM_PROMPT object is unchanged.
    before = script_stage.SYSTEM_PROMPT
    script_stage.build_user_prompt("T", evidence_block="E", extra_user_block="X" * 500)
    assert script_stage.SYSTEM_PROMPT == before


# ---------------- verify-on-edit ----------------

def _retrieved(snips):
    return SimpleNamespace(snippets=[SimpleNamespace(url=u, content=c) for u, c in snips])


def test_verify_edited_beats_flags_unverified_without_dropping():
    s = BeatsScript(title="T", beats=[Beat(text="Original"), Beat(text="Edited claim")])
    # verifier says the edited beat is NOT supported
    def vfn(items):
        return [{"index": it["index"], "claim_supported": False, "number_supported": None,
                 "source": None} for it in items]
    out = verify_stage.verify_edited_beats(
        s, [1], verify_fn=vfn, retrieve_fn=lambda q, key=None, cache_dir=None: _retrieved([]))
    assert len(out.beats) == 2                                  # NEVER dropped
    flags = {f["index"]: f for f in out.beat_flags}
    assert flags[1]["status"] == "unverified"
    assert "reword" in flags[1]["reason"]


def test_verify_edited_beats_supported_reattaches_source():
    s = BeatsScript(title="T", beats=[Beat(text="Edited claim")])
    def vfn(items):
        return [{"index": 0, "claim_supported": True, "number_supported": True,
                 "source": "https://noaa.gov/x"}]
    out = verify_stage.verify_edited_beats(
        s, [0], verify_fn=vfn,
        retrieve_fn=lambda q, key=None, cache_dir=None: _retrieved([("https://noaa.gov/x", "c")]))
    assert out.beats[0].source == "https://noaa.gov/x"
    assert out.beat_flags[0]["status"] == "supported"


# ---------------- engine script edit ----------------

def _ctx(tmp_path):
    return executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")


def _seed_script_session(tmp_path, beats):
    """Persist a script-stage bundle + stub all downstream executors so edit()'s
    re-derive runs fully offline."""
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    script = BeatsScript(title="T", beats=beats)
    from pipeline import recipe as recipe_stage
    plan = recipe_stage.plan(script, theme=Theme(), manifests={})
    from session import codecs
    import json
    store.upsert_stage(conn, "s1", "script", status="done", input_hash="h",
                       output_json=json.dumps(codecs.script_bundle_to_json({"script": script, "plan": plan})),
                       now="t0")
    return conn


def test_engine_edit_beat_persists_text_and_reruns_downstream(tmp_path, monkeypatch):
    conn = _seed_script_session(tmp_path, [Beat(text="hook"), Beat(text="middle"), Beat(text="outro")])
    ran = []
    for st in ["voice", "timing", "footage", "assemble"]:
        monkeypatch.setitem(engine.EXECUTORS, st, (lambda s: lambda ctx, inp: ran.append(s) or {})(st))
        monkeypatch.setitem(engine.CODECS, st, (lambda o: o, lambda d: d))
    # assemble output must be loadable for materialize_spec; make it None-safe
    monkeypatch.setattr(engine.Engine, "materialize_spec", lambda self: None)

    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    eng.edit("script", {"op": "edit_beat", "index": 1, "text": "EDITED MIDDLE"})

    bundle = eng._load_output("script")
    assert bundle["script"].beats[1].text == "EDITED MIDDLE"
    assert ran == ["voice", "timing", "footage", "assemble"]      # full downstream re-derive
    conn.close()


def test_engine_drop_beat_shifts_flags(tmp_path, monkeypatch):
    conn = _seed_script_session(tmp_path, [Beat(text="a"), Beat(text="b"), Beat(text="c")])
    for st in ["voice", "timing", "footage", "assemble"]:
        monkeypatch.setitem(engine.EXECUTORS, st, lambda ctx, inp: {})
        monkeypatch.setitem(engine.CODECS, st, (lambda o: o, lambda d: d))
    monkeypatch.setattr(engine.Engine, "materialize_spec", lambda self: None)

    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    # seed a flag on beat 2, then drop beat 1 -> flag should shift to index 1
    bundle = eng._load_output("script")
    bundle["script"].beat_flags = [{"index": 2, "status": "unverified", "reason": "x"}]
    import json
    from session import codecs
    store.upsert_stage(conn, "s1", "script", status="done", input_hash="h",
                       output_json=json.dumps(codecs.script_bundle_to_json(bundle)), now="t1")

    eng.edit("script", {"op": "drop_beat", "index": 1})
    out = eng._load_output("script")
    assert [b.text for b in out["script"].beats] == ["a", "c"]
    assert out["script"].beat_flags == [{"index": 1, "status": "unverified", "reason": "x"}]
    conn.close()
