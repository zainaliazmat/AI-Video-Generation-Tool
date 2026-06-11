"""Studio v2 — Assemble gate: spec.json patch whitelist + invariant guard + engine edit."""
import json

import pytest

from schema import (Spec, Meta, Audio, Scene, Caption, Theme)
from pipeline import spec_patch
from session import store, engine, executors, codecs


def _spec():
    return Spec(
        meta=Meta(title="T", durationInFrames=300),
        audio=Audio(voiceover="assets/vo.wav"),
        scenes=[
            Scene(id="scene-0", startFrame=0, durationInFrames=150, template="hook",
                  templateProps={"title": "Hi", "subtitle": "sub"}),
            Scene(id="scene-1", startFrame=150, durationInFrames=150, template="scene",
                  templateProps={"media": {"type": "video", "src": "assets/a.mp4",
                                           "fit": "cover", "loop": True}}),
        ],
        captions=[Caption(text="hi", startFrame=0, endFrame=30)],
        theme=Theme(),
    )


def test_patch_allows_theme_change():
    spec = _spec()
    out = spec_patch.apply_patch(spec, [
        {"op": "replace", "path": "/theme/caption/fontWeight", "value": 900}])
    assert out.theme.caption.fontWeight == 900
    # everything else untouched
    assert out.captions == spec.captions
    assert out.audio == spec.audio


def test_patch_allows_template_and_clip_swap():
    spec = _spec()
    out = spec_patch.apply_patch(spec, [
        {"op": "replace", "path": "/scenes/1/templateProps/media/src", "value": "assets/new.mp4"}])
    assert out.scenes[1].templateProps["media"]["src"] == "assets/new.mp4"
    assert out.scenes[1].startFrame == 150          # timing pinned


def test_patch_rejects_caption_text_change():
    spec = _spec()
    with pytest.raises(spec_patch.PatchError):
        spec_patch.apply_patch(spec, [
            {"op": "replace", "path": "/captions/0/text", "value": "HACKED"}])


def test_patch_rejects_duration_and_startframe():
    spec = _spec()
    for path in ("/scenes/0/durationInFrames", "/scenes/0/startFrame", "/scenes/0/id"):
        with pytest.raises(spec_patch.PatchError):
            spec_patch.apply_patch(spec, [{"op": "replace", "path": path, "value": 999}])


def test_patch_rejects_audio_and_meta():
    spec = _spec()
    for path in ("/audio/voiceover", "/meta/durationInFrames"):
        with pytest.raises(spec_patch.PatchError):
            spec_patch.apply_patch(spec, [{"op": "replace", "path": path, "value": "x"}])


def test_patch_rejects_scene_add_remove():
    spec = _spec()
    with pytest.raises(spec_patch.PatchError):
        spec_patch.apply_patch(spec, [{"op": "replace", "path": "/scenes", "value": []}])


def test_patch_rejects_negative_scene_index():
    spec = _spec()
    with pytest.raises(spec_patch.PatchError):
        spec_patch.apply_patch(spec, [
            {"op": "replace", "path": "/scenes/-1/template", "value": "x"}])


def test_patch_rejects_non_replace_op():
    ok, err = spec_patch.validate_patch([{"op": "remove", "path": "/theme/transition"}])
    assert not ok and "replace" in err


def test_patch_rejects_unknown_theme_key_loudly():
    """The honesty hole (review F-3): an unknown theme leaf (or any misspelled key)
    used to be accepted, diffed, and silently DISCARDED by pydantic's default
    extra='ignore' — a green patch card and an unchanged render. It must fail
    loudly instead. (caption.size graduated to a real field — see the migration
    test below — so the unknown examples here are misspellings.)"""
    spec = _spec()
    for path in ("/theme/caption/sizes",         # near-miss of the now-real size
                 "/theme/caption/colour",        # misspelling of an existing key
                 "/theme/pallete/background"):   # misspelled container
        with pytest.raises(spec_patch.PatchError):
            spec_patch.apply_patch(spec, [{"op": "replace", "path": path, "value": 56}])


def test_spec_model_rejects_unknown_fields():
    """extra='forbid' on every spec model: an unknown key anywhere in a spec dict
    must raise, not silently vanish (the contract mirror in schema.ts is types-only,
    so Python is the only runtime guard)."""
    data = _spec().model_dump(by_alias=True)
    data["theme"]["caption"]["sizes"] = 56
    with pytest.raises(Exception):
        Spec.model_validate(data)


def test_caption_size_migration_round_trip():
    """CaptionStyle.size — the deferred ruling, closed. Optional[int] (None default
    -> the renderer keeps its legacy height*0.045 derivation, byte-identical legacy
    rendering; mirrored in remotion/src/caption-size.ts). A size patch now survives
    the validate -> apply -> dump round trip — the F-3 'make captions bigger' hole
    closed FOR REAL, not just loudly."""
    spec = _spec()
    assert spec.theme.caption.size is None              # default: absent
    out = spec_patch.apply_patch(spec, [
        {"op": "replace", "path": "/theme/caption/size", "value": 56}])
    assert out.theme.caption.size == 56
    assert out.model_dump(by_alias=True)["theme"]["caption"]["size"] == 56

    # contract guard: a non-positive size is rejected loudly (mirrors the TS
    # resolver's >0 fail-safe — but Python fails the patch, never a silent 0px).
    with pytest.raises(spec_patch.PatchError):
        spec_patch.apply_patch(spec, [
            {"op": "replace", "path": "/theme/caption/size", "value": 0}])


def test_diff_lines():
    spec = _spec()
    d = spec_patch.diff_lines(spec, [
        {"op": "replace", "path": "/theme/caption/fontWeight", "value": 900}])
    assert d == [{"path": "theme.caption.fontWeight", "before": 800, "after": 900}]


def test_parse_chat_response_extracts_ops_and_reply():
    ops, reply = spec_patch.parse_chat_response(
        json.dumps({"ops": [{"op": "replace", "path": "/theme/transition", "value": "slide"}],
                    "reply": "Switched to slide transitions."}))
    assert ops[0]["value"] == "slide"
    assert "slide" in reply


# ---- engine assemble edit ----

def _ctx(tmp_path):
    return executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path, voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")


def test_engine_assemble_edit_applies_patch_and_materializes(tmp_path, monkeypatch):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    store.upsert_stage(conn, "s1", "assemble", status="done", input_hash="h",
                       output_json=json.dumps(codecs.spec_to_json(_spec())), now="t0")
    # avoid validate_spec needing a real catalog
    monkeypatch.setattr("pipeline.validate.validate_spec", lambda spec, catalog: None)

    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    eng.edit("assemble", {"patch": [
        {"op": "replace", "path": "/theme/palette/background", "value": "#1d1009"}]})

    out = eng._load_output("assemble")
    assert out.theme.palette.background == "#1d1009"
    assert (tmp_path / "spec.json").exists()          # materialized
    conn.close()


# ---- F-5: patch history + derived spec version + revert ----

def _session_with_assemble(tmp_path, monkeypatch):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    store.upsert_stage(conn, "s1", "assemble", status="done", input_hash="h",
                       output_json=json.dumps(codecs.spec_to_json(_spec())), now="t0")
    monkeypatch.setattr("pipeline.validate.validate_spec", lambda spec, catalog: None)
    return conn, engine.Engine(conn, _ctx(tmp_path), session_id="s1")


def test_store_spec_patch_history_roundtrip(tmp_path):
    """spec_patches is an append-only event log; version is DERIVED (1 + row count),
    so no sessions-table migration and the rail chip can never drift from history."""
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    assert store.spec_version(conn, "s1") == 1            # fresh session = v1
    store.append_spec_patch(
        conn, "s1", kind="patch",
        patch=[{"op": "replace", "path": "/theme/transition", "value": "slide"}],
        diff=[{"path": "theme.transition", "before": "fade", "after": "slide"}],
        now="t1")
    rows = store.get_spec_patches(conn, "s1")
    assert len(rows) == 1
    assert rows[0]["seq"] == 1 and rows[0]["kind"] == "patch" and not rows[0]["reverted"]
    assert json.loads(rows[0]["diff_json"])[0]["before"] == "fade"
    assert store.spec_version(conn, "s1") == 2
    conn.close()


def test_engine_assemble_edit_records_history(tmp_path, monkeypatch):
    conn, eng = _session_with_assemble(tmp_path, monkeypatch)
    eng.edit("assemble", {"patch": [
        {"op": "replace", "path": "/theme/palette/background", "value": "#1d1009"}]})
    rows = store.get_spec_patches(conn, "s1")
    assert len(rows) == 1 and rows[0]["kind"] == "patch"
    diff = json.loads(rows[0]["diff_json"])
    assert diff == [{"path": "theme.palette.background",
                     "before": "#000000", "after": "#1d1009"}]
    assert store.spec_version(conn, "s1") == 2
    conn.close()


def test_engine_assemble_revert_restores_and_logs(tmp_path, monkeypatch):
    """Revert = LIFO undo: inverse ops built from the stored diff's before-values,
    applied through the SAME whitelist + invariant machinery as any patch."""
    conn, eng = _session_with_assemble(tmp_path, monkeypatch)
    eng.edit("assemble", {"patch": [
        {"op": "replace", "path": "/theme/palette/background", "value": "#1d1009"}]})
    eng.edit("assemble", {"revert": 1})

    out = eng._load_output("assemble")
    assert out.theme.palette.background == "#000000"      # restored to the before value
    rows = store.get_spec_patches(conn, "s1")
    assert len(rows) == 2
    assert rows[0]["reverted"] == 1                       # the undone patch is marked
    assert rows[1]["kind"] == "revert" and rows[1]["reverts_seq"] == 1
    assert store.spec_version(conn, "s1") == 3            # a revert is itself an edit
    assert (tmp_path / "spec.json").exists()              # re-materialized
    conn.close()


def test_engine_assemble_revert_rejects_non_latest(tmp_path, monkeypatch):
    """Only the NEWEST un-reverted patch can be undone (a mid-stack revert could
    produce a spec state that never existed). Walk the stack back instead."""
    conn, eng = _session_with_assemble(tmp_path, monkeypatch)
    eng.edit("assemble", {"patch": [
        {"op": "replace", "path": "/theme/palette/background", "value": "#1d1009"}]})
    eng.edit("assemble", {"patch": [
        {"op": "replace", "path": "/theme/transition", "value": "slide"}]})
    with pytest.raises(Exception, match="newest"):
        eng.edit("assemble", {"revert": 1})
    conn.close()
