"""A.6.1 — read-only session state for the preview footage gate.

Resolves the persisted session's per-scene candidate pool + provenance. Pure read:
opens the DB, reads the materialized spec.json for the scene list, joins the footage
candidate pool + media provenance. Prints one JSON line; never mutates.

Usage: python backend/session_state.py --sid <id>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import store, job_ctx
from pipeline import projects as projects_mod


def _beat_text_by_index(conn, sid: str) -> dict:
    """{scene_index: beat_text} from the persisted script stage (1 beat = 1 scene).
    Best-effort: returns {} if the script stage / JSON is missing."""
    row = store.get_stage(conn, sid, "script")
    if row is None or row["output_json"] is None:
        return {}
    try:
        beats = json.loads(row["output_json"])["script"]["beats"]
        return {i: b.get("text") for i, b in enumerate(beats)}
    except (ValueError, KeyError, TypeError):
        return {}


def _beat_data_by_index(conn, sid: str) -> dict:
    """{scene_index: beat.data} from the persisted script stage.
    Best-effort: returns {} if the script stage / JSON is missing.
    beat.data is the structured payload ({value, label} / {items} / None) used
    by eligibility to determine which templates a scene can switch to."""
    row = store.get_stage(conn, sid, "script")
    if row is None or row["output_json"] is None:
        return {}
    try:
        beats = json.loads(row["output_json"])["script"]["beats"]
        return {i: b.get("data") for i, b in enumerate(beats)}
    except (ValueError, KeyError, TypeError):
        return {}


def _pool_errors_by_index(conn, sid: str) -> dict:
    """{scene_index: error_str} from the persisted footage stage output.
    Best-effort: returns {} when the footage stage / JSON is missing.
    These are rate-limit / exhaustion markers that the M6 UI strip needs."""
    row = store.get_stage(conn, sid, "footage")
    if row is None or row["output_json"] is None:
        return {}
    try:
        d = json.loads(row["output_json"])
        return {int(k): v for k, v in d.get("pool_errors", {}).items()}
    except (ValueError, KeyError, TypeError):
        return {}


def build_state(sid: str) -> dict:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        if store.get_session(conn, sid) is None:
            raise KeyError(f"no session {sid!r}")
        # Read THIS session's own materialized spec (projects/<sid>/spec.json), not a
        # global slot — that is what makes re-opening an old project's gate work.
        spec_path = projects_mod.project_spec_path(job_ctx.REPO_ROOT, sid)
        gate_states = store.get_gate_states(conn, sid)
        session_row = store.get_session(conn, sid)
        if not spec_path.exists():
            # Pre-spec: gated session at the script/voice gate — spec materialises
            # only when the scenes segment runs (ruling 1A). Return a partial-but-honest
            # payload: gates + autoRun are available, spec-dependent keys are empty/null.
            return {"sid": sid, "scenes": [],
                    "gates": gate_states,
                    "autoRun": bool(session_row["auto_run"])}
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        prov = store.get_media_provenance(conn, sid)
        beat_text = _beat_text_by_index(conn, sid)   # Studio v2: show the beat beside each clip

        # v3-M5 T7: load the tables that drive the five new per-scene keys.
        from pipeline import validate as validate_stage
        from pipeline.eligibility import eligible_templates
        catalog = validate_stage.load_catalog(job_ctx.TEMPLATES_DIR)
        template_overrides = store.get_template_overrides(conn, sid)
        background_overrides = store.get_background_overrides(conn, sid)
        pool_errors = _pool_errors_by_index(conn, sid)
        # Beat data indexed by scene position — the eligibility signal (beat data +
        # position), NOT the rendered templateProps (which was the M5-exit bug).
        beat_data_map = _beat_data_by_index(conn, sid)
        all_scenes = spec.get("scenes", [])
        scene_count = len(all_scenes)

        scenes = []
        for i, sc in enumerate(all_scenes):
            media = (sc.get("templateProps") or {}).get("media")
            needs_footage = media is not None
            candidates = []
            if needs_footage:
                for r in store.get_footage_candidates(conn, sid, scene_index=i):
                    candidates.append({
                        "rank": r["rank"], "thumbUrl": r["thumb_url"], "query": r["query"],
                        "durationFrames": r["duration_frames"], "selected": bool(r["selected"])})
            p = prov.get(i)

            # ── v3-M5 T7: five new keys ──────────────────────────────────────
            # 1. eligibleTemplates: beat data + position, not rendered props.
            #    Mirrors recipe._derive_role so routing signal stays in lockstep.
            beat_data = beat_data_map.get(i)
            eligible = eligible_templates(beat_data, i, scene_count, catalog)

            # 2. templateOverride: {value, source, pickedRank} or null.
            tov = template_overrides.get(i)
            template_override = (None if tov is None else {
                "value": tov["value"],
                "source": tov["source"],
                "pickedRank": tov["picked_rank"],
            })

            # 3. backgroundPool: footage_candidates for hero scenes (those that
            #    are not footage scenes but still have a pool). Always present
            #    (may be empty list); includes poolError marker when applicable.
            bg_pool_rows = store.get_footage_candidates(conn, sid, scene_index=i)
            background_pool = []
            for r in bg_pool_rows:
                background_pool.append({
                    "rank": r["rank"], "thumbUrl": r["thumb_url"],
                    "query": r["query"], "durationFrames": r["duration_frames"],
                    "selected": bool(r["selected"]),
                })
            pool_error = pool_errors.get(i)
            if pool_error is not None:
                background_pool_out = {"rows": background_pool, "poolError": pool_error}
            else:
                background_pool_out = {"rows": background_pool, "poolError": None}

            # 4. backgroundProvenance: from background_overrides row (T2 ruling).
            #    Shape: {source, pickedRank, query?, pexelsId?, pexelsUrl?, updatedAt}
            bov = background_overrides.get(i)
            if bov is None:
                background_provenance = None
            else:
                val = bov.get("value") or {}
                background_provenance = {
                    "source": bov["source"],
                    "pickedRank": bov["picked_rank"],
                    "query": val.get("query"),
                    "pexelsId": val.get("pexels_id"),
                    "pexelsUrl": val.get("pexels_url"),
                    "updatedAt": bov["updated_at"],
                }

            # 5. pickLogCount + lastPick: scene-level pick evidence for M6 popover.
            pick_rows = store.get_pick_log(conn, sid, scene_index=i)
            pick_log_count = len(pick_rows)
            if pick_rows:
                last = pick_rows[-1]
                last_pick = {"autoRank": last["auto_rank"], "humanRank": last["human_rank"]}
            else:
                last_pick = None

            scenes.append({
                "index": i, "template": sc.get("template"), "needsFootage": needs_footage,
                "beatText": beat_text.get(i),
                # F-10: the scene span lets the gate surface "loops ×N" on a bound
                # clip shorter than the scene (pool rows already carry duration).
                "durationInFrames": sc.get("durationInFrames"),
                "candidates": candidates,
                "provenance": (None if p is None else {
                    "source": p["source"], "query": p["query"], "rank": p["rank"],
                    "pexelsId": p["pexels_id"], "pexelsUrl": p["pexels_url"]}),
                # v3-M5 T7 keys:
                "eligibleTemplates": eligible,
                "templateOverride": template_override,
                "backgroundPool": background_pool_out,
                "backgroundProvenance": background_provenance,
                "pickLogCount": pick_log_count,
                "lastPick": last_pick,
            })
        return {"sid": sid, "scenes": scenes,
                "gates": gate_states,
                "autoRun": bool(session_row["auto_run"])}
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(build_state(args.sid)))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
