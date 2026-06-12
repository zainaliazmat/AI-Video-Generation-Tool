"""Studio v2 — Script gate backend: style memory, verify-on-edit, engine script edit,
and the additive-prompt / frozen-rule guards (PRD §6.1)."""
from types import SimpleNamespace


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


def test_style_memory_manager_ops(tmp_path, monkeypatch):
    """F-6: the PRD's 'caps + manager UI (pin/delete)' finally gets a surface —
    list/pin/delete CLI ops over the repo-level style memory, persisted to disk."""
    import pytest
    import session_script as scli
    sm_path = tmp_path / "style_memory.json"
    monkeypatch.setattr("session.job_ctx.STYLE_MEMORY_PATH", sm_path)
    mem = {"examples": [], "guidance": []}
    style_memory.record_edit(mem, before="b0", after="a0")
    style_memory.record_guidance(mem, "punchier verbs")
    style_memory.save(sm_path, mem)

    out = scli.style_memory_read("s1")
    assert out["ok"]
    assert out["styleMemory"]["examples"][0] == {
        "index": 0, "before": "b0", "after": "a0", "pinned": False}
    assert out["styleMemory"]["guidance"][0] == {
        "index": 0, "text": "punchier verbs", "pinned": False}
    assert out["styleMemory"]["caps"] == {
        "examples": style_memory.MAX_EXAMPLES, "guidance": style_memory.MAX_GUIDANCE}

    out = scli.style_memory_pin("s1", kind="guidance", index=0, value=True)
    assert out["styleMemory"]["guidance"][0]["pinned"] is True
    assert style_memory.load(sm_path)["guidance"][0]["pinned"]   # persisted

    out = scli.style_memory_delete("s1", kind="example", index=0)
    assert out["styleMemory"]["examples"] == []
    assert style_memory.load(sm_path)["examples"] == []          # persisted

    # fail-loud (house style): the silent no-op of the underlying helpers must not
    # leak through the CLI — a bad kind/index is an error, not a quiet success.
    with pytest.raises(ValueError):
        scli.style_memory_pin("s1", kind="nope", index=0)
    with pytest.raises(IndexError):
        scli.style_memory_delete("s1", kind="guidance", index=5)


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


# ---------------------------------------------------------------------------
# D1-B: system_prompt_for() surgery + LENGTH_PRESETS (Studio v3 M2)
# ---------------------------------------------------------------------------

# Golden bytes captured from the original frozen SYSTEM_PROMPT before the M2
# refactor.  system_prompt_for(60) MUST reproduce this string byte-for-byte.
_GOLDEN_SYSTEM_PROMPT_60 = (
    "You are a scriptwriter for short-form faceless videos (vertical, ~60-90s). "
    "Respond ONLY with a JSON object of the form "
    '{"title": string, "beats": Beat[], "hook_candidates"?: Hook[]} where a Beat is '
    '{"text": string, "data"?: object, "keywords"?: string, "source"?: string} '
    'and a Hook is {"text": string, "pattern": string, "source"?: string}. '
    "Each beat's `text` is ONE spoken narration sentence (8-18 words). Produce 5-8 beats. "
    "Pace for retention: open tight, deliver a clear payoff, no filler or dead air. "
    "The FIRST beat must be a punchy hook that opens the video; the LAST beat must be a "
    "closing call to action (e.g. follow for more). "
    "The title must NOT promise a fixed count (avoid 'N facts ...') — unverifiable facts may be dropped. "
    'For any beat whose point is a single striking number or statistic, include '
    '"data": {"value": "<the number, e.g. 90%>", "label": "<short context, 2-5 words>"}. '
    'For any beat that NAMES a small enumerable SET of things (2-6 items, e.g. '
    '"the sun, the moon, the planets"), instead include '
    '"data": {"items": ["<item1>", "<item2>", ...]} with the bare item nouns in the SAME '
    "ORDER the narration speaks them, and make the beat `text` actually name each item in "
    "that order. Use `items` for an enumerable set, NOT for a single statistic (that is "
    "`value`/`label`); never put both on one beat. "
    'For EVERY beat, add "keywords": "<2-4 words>" for stock-footage search. GUIDING PRINCIPLE: '
    'pick words whose DOMINANT stock-footage meaning IS your subject — a stock library returns '
    'the COMMON sense of a phrase, not the one you intended. Apply it: '
    '(a) name a CONCRETE, FILMABLE thing on screen, never an abstract concept ("melting glacier", '
    'not "economic growth" or "freedom"); '
    '(b) LEAD WITH THE CONCRETE NOUN, never a process word — a process-led phrase drifts to the '
    'wrong scene ("ocean evaporation steam" returns a geothermal vent; use "sea spray over waves"); '
    '(c) never use a compound whose everyday meaning is a DIFFERENT object than you mean — it '
    'returns that other object ("hand crank" returns a coffee grinder; name the visible part: '
    '"brass clockwork gears"); '
    '(d) for a subject too specific for stock — a named place, person, event, branded object, or '
    'niche instrument — use an ANONYMOUS filmable category or mood that evokes it, NEVER a named '
    'landmark a viewer would recognize ("celestial globe" or "the Antikythera mechanism" -> '
    '"antique astronomical instrument", not a famous astronomical clock; "Challenger Deep" -> '
    '"dark ocean abyss"; "Nobel medal" -> "physics laboratory"). '
    "When grounding SOURCES are provided in the user message, state ONLY facts those "
    'sources support and set each factual beat\'s "source" to the exact URL of the '
    "specific source that backs it; never invent a URL or an unsupported fact. "
    "No emojis, no markdown, no numbering."
)


def test_system_prompt_golden_60():
    """D1-B: system_prompt_for(60) must be byte-identical to the original frozen prompt."""
    from pipeline import script as script_stage
    assert script_stage.system_prompt_for(60) == _GOLDEN_SYSTEM_PROMPT_60


def test_system_prompt_module_constant_equals_60():
    """SYSTEM_PROMPT module constant equals system_prompt_for(60) — existing importers safe."""
    from pipeline import script as script_stage
    assert script_stage.SYSTEM_PROMPT == script_stage.system_prompt_for(60)
    assert script_stage.SYSTEM_PROMPT == _GOLDEN_SYSTEM_PROMPT_60


def test_system_prompt_segments_present_in_all_presets():
    """KEYWORD_RULE_SEGMENT and GROUNDING_SEGMENT appear byte-identical in every preset prompt."""
    from pipeline import script as script_stage
    for length in script_stage.LENGTH_PRESETS:
        prompt = script_stage.system_prompt_for(length)
        assert script_stage.KEYWORD_RULE_SEGMENT in prompt, \
            f"KEYWORD_RULE_SEGMENT missing from system_prompt_for({length})"
        assert script_stage.GROUNDING_SEGMENT in prompt, \
            f"GROUNDING_SEGMENT missing from system_prompt_for({length})"


def test_system_prompt_segments_byte_identical_across_presets():
    """The keyword and grounding segment text is the exact same object / bytes for all presets."""
    from pipeline import script as script_stage
    from pipeline.script import KEYWORD_RULE_SEGMENT, GROUNDING_SEGMENT
    for length in script_stage.LENGTH_PRESETS:
        prompt = script_stage.system_prompt_for(length)
        # find() returns -1 if not present; the segment content test above covers that
        kw_idx = prompt.find(KEYWORD_RULE_SEGMENT)
        gr_idx = prompt.find(GROUNDING_SEGMENT)
        assert kw_idx >= 0
        assert gr_idx >= 0
        # The segment text embedded in the prompt equals the module constant exactly
        assert prompt[kw_idx:kw_idx + len(KEYWORD_RULE_SEGMENT)] == KEYWORD_RULE_SEGMENT
        assert prompt[gr_idx:gr_idx + len(GROUNDING_SEGMENT)] == GROUNDING_SEGMENT


def test_system_prompt_beat_bands_per_preset():
    """Each preset prompt names its own beat band; 60s and 30s do NOT appear in 180/300 prompts."""
    from pipeline import script as script_stage
    p30 = script_stage.system_prompt_for(30)
    p60 = script_stage.system_prompt_for(60)
    p180 = script_stage.system_prompt_for(180)
    p300 = script_stage.system_prompt_for(300)

    # 30s: 5-6 beats, 60s: 5-8 beats
    assert "Produce 5-6 beats" in p30
    assert "Produce 5-8 beats" in p60
    assert "Produce 22-30 beats" in p180
    assert "Produce 38-48 beats" in p300

    # Beat bands are preset-exclusive (cross-contamination check)
    assert "Produce 5-6 beats" not in p60
    assert "Produce 5-6 beats" not in p180
    assert "Produce 5-8 beats" not in p30
    assert "Produce 5-8 beats" not in p180
    assert "Produce 22-30 beats" not in p30
    assert "Produce 22-30 beats" not in p60
    assert "Produce 38-48 beats" not in p30
    assert "Produce 38-48 beats" not in p60


def test_system_prompt_for_unknown_length_raises():
    """system_prompt_for with an unknown length raises KeyError (codebase idiom)."""
    import pytest
    from pipeline import script as script_stage
    with pytest.raises(KeyError):
        script_stage.system_prompt_for(999)
    with pytest.raises(KeyError):
        script_stage.system_prompt_for(0)


def test_additive_seam_does_not_alter_system_prompt():
    """PRD risk mitigation: the additive seam must never touch the frozen SYSTEM_PROMPT."""
    from pipeline import script as script_stage
    assert script_stage.SYSTEM_PROMPT.startswith("You are a scriptwriter")
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
