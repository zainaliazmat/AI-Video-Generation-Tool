"""The session state-machine engine: advance (with input-hash cache), invalidate
(per the §3.3 matrix), edit, regenerate, and spec materialization. Owns stage
TRANSITIONS + STATUS; the actual work is the executors over the existing stage fns.
"""
from __future__ import annotations

import hashlib
import json

from session import store, stages, executors, codecs


# stage -> executor callable
EXECUTORS = {
    "script": executors.run_script,
    "voice": executors.run_voice,
    "timing": executors.run_timing,
    "footage": executors.run_footage,
    "assemble": executors.run_assemble,
    "render": lambda ctx, inputs: None,   # terminal no-op in A.1
}

# stage -> (to_json, from_json)
CODECS = {
    "script": (codecs.script_bundle_to_json, codecs.script_bundle_from_json),
    "voice": (codecs.offsets_to_json, codecs.offsets_from_json),
    "timing": (codecs.words_to_json, codecs.words_from_json),
    "footage": (codecs.footage_to_json, codecs.footage_from_json),
    "assemble": (codecs.spec_to_json, codecs.spec_from_json),
    "render": (lambda o: o, lambda d: d),
}


def _now():
    # Monotonic-enough wall clock string; the engine never parses it back. Avoids a
    # datetime import surprise in sandboxes that forbid argless now() — callers pass
    # a counter in tests via store directly, but the engine stamps with a fixed token
    # since ordering isn't load-bearing here.
    return "now"


class Engine:
    def __init__(self, conn, ctx, *, session_id):
        self.conn = conn
        self.ctx = ctx
        self.sid = session_id

    # ---- output (de)serialization ----
    def _load_output(self, stage):
        row = store.get_stage(self.conn, self.sid, stage)
        if row is None or row["output_json"] is None:
            return None
        _, from_json = CODECS[stage]
        return from_json(json.loads(row["output_json"]))

    def _inputs_for(self, stage):
        inputs = {}
        for d in stages.deps(stage):
            out = self._load_output(d)
            if out is None:
                # out-of-order advance (e.g. advance("voice") before script ran) —
                # fail with a clear message rather than a cryptic codec TypeError on None.
                raise RuntimeError(
                    f"cannot advance {stage!r}: upstream stage {d!r} has not completed")
            inputs[d] = out
        return inputs

    def _input_hash(self, stage, inputs):
        payload = {"stage": stage, "topic": self.ctx.topic, "fps": self.ctx.fps,
                   "inputs": {d: CODECS[d][0](v) for d, v in inputs.items()}}
        # No default=str: codec outputs are JSON-native by contract, so json.dumps
        # raises loudly if a codec ever returns a non-serializable object. That guard
        # is deliberate — a str()-of-object fallback could embed a memory address and
        # silently destabilize the hash (the cache would then never hit across runs).
        blob = json.dumps(payload, sort_keys=True)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    # ---- transitions ----
    def advance(self, stage):
        inputs = self._inputs_for(stage)
        h = self._input_hash(stage, inputs)
        row = store.get_stage(self.conn, self.sid, stage)
        if row is not None and row["status"] == "done" and row["input_hash"] == h:
            return self._load_output(stage)   # cache hit -> no-op
        output = EXECUTORS[stage](self.ctx, inputs)
        to_json, _ = CODECS[stage]
        store.upsert_stage(self.conn, self.sid, stage, status="done", input_hash=h,
                           output_json=json.dumps(to_json(output), default=str), now=_now())
        store.update_session(self.conn, self.sid, now=_now(), current_stage=stage)
        if stage == "footage":
            self._sync_footage_candidates_to_db(output)
            self._stamp_auto_provenance(output)
        return output

    def _sync_footage_candidates_to_db(self, footage_output):
        """Write the in-memory candidate pool to the footage_candidates table so
        that _edit_footage/pick can read it via store.get_footage_candidates.
        Called once per footage advance (initial run + any re-advance)."""
        candidates = footage_output.get("candidates", {})
        for scene_index, rows in candidates.items():
            store.replace_footage_candidates(
                self.conn, self.sid, scene_index=int(scene_index), candidates=rows)

    def _stamp_auto_provenance(self, footage_output):
        """Record source='auto' provenance for each clip from its surfaced origin.
        Runs on any REAL execution of advance('footage') (never on the input-hash
        cache-hit early return); a gate pick/re_query goes through _edit_footage, which
        stamps its own source and does NOT re-advance footage. The one path that stamps
        'auto' over a prior pick/re_query is regenerate('footage') — that forces a
        non-cache-hit re-derive of the clips, so resetting to 'auto' is correct. rank/
        pexels are None for a legacy pre-sidecar cached clip ('auto, origin unknown')."""
        for clip in footage_output.get("clips", []):
            store.upsert_provenance(
                self.conn, self.sid, clip.index, source="auto", query=clip.query,
                rank=clip.rank, pexels_id=clip.pexels_id, pexels_url=clip.pexels_url)

    def invalidate(self, from_stage):
        for st in stages.downstream(from_stage):
            row = store.get_stage(self.conn, self.sid, st)
            if row is not None:
                store.set_stage_status(self.conn, self.sid, st, "stale", now=_now())

    def edit(self, stage, op):
        """Apply a stage-specific edit, persist the new stage output, invalidate
        downstream, and re-derive the stale stages. A.1 implements the footage ops."""
        if stage != "footage":
            raise NotImplementedError(f"edit not implemented for stage {stage!r} (A.1 = footage)")
        self._edit_footage(op)
        self.invalidate("footage")
        for st in stages.downstream("footage"):
            if st == "render":
                continue
            self.advance(st)
        self.materialize_spec()

    def _edit_footage(self, op):
        from pipeline import footage as footage_stage
        from pipeline.contracts import Clip
        out = self._load_output("footage")
        scene = op["scene_index"]

        if op["op"] == "re_query":
            from pipeline.footage_query import harden
            q = harden(op["query"], title=self.ctx.topic)
            key = footage_stage.require_env("PEXELS_API_KEY")
            data = footage_stage.search_pexels(q, key)
            rows = footage_stage.candidate_rows(data.get("videos", []), query=q, fps=self.ctx.fps)
            chosen = rows[0] if rows else None
        elif op["op"] == "pick":
            # Read the pool the user was actually shown — the footage OUTPUT retains each
            # row's link, so pick binds EXACTLY that clip: offline + deterministic, with no
            # re-search that could return a different video at that rank (Pexels order drifts).
            rows = [dict(r) for r in out["candidates"].get(scene, [])]
            chosen = next((r for r in rows if r["rank"] == op["rank"]), None)
        else:
            raise ValueError(f"unknown footage op {op['op']!r}")

        if chosen is None:
            raise RuntimeError(f"no candidate for scene {scene} ({op})")

        # download the chosen clip into the assets dir and bind it to the scene's Clip
        dest = self.ctx.assets_dir / f"footage_{footage_stage.query_slug(chosen['query'])}_{chosen['rank']}.mp4"
        if not dest.exists():
            link = chosen.get("link")
            if not link:
                # pick-link recovery failed (the re-search no longer has this rank). Fail
                # loud — binding a Clip to a missing file would write a silently broken spec.
                raise RuntimeError(
                    f"footage gate: no download link for scene {scene} rank {chosen['rank']} "
                    f"({op['op']}) — pool row carries no link and re-search recovery found none")
            footage_stage._download(link, dest)
        new_clip = Clip(index=scene, query=chosen["query"],
                        path=f"assets/{dest.name}", duration_frames=chosen.get("duration_frames"))
        out["clips"] = [new_clip if c.index == scene else c for c in out["clips"]]
        # re-mark selection; KEEP `link` in the output pool so a later pick stays offline
        # and deterministic. The footage_candidates TABLE is the display surface (no link
        # column) — replace_footage_candidates ignores link, so the two stay consistent.
        for r in rows:
            r["selected"] = 1 if r.get("rank") == chosen["rank"] else 0
            r.setdefault("clip_path", None)
        out["candidates"][scene] = rows
        store.replace_footage_candidates(self.conn, self.sid, scene_index=scene, candidates=rows)

        to_json, _ = CODECS["footage"]
        store.upsert_stage(self.conn, self.sid, "footage", status="done",
                           input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
                           output_json=json.dumps(to_json(out), default=str), now=_now())
        # Non-atomic with the stage upsert above (two commits): a crash between them
        # leaves the new clip persisted but the provenance row stale until the next
        # edit. Acceptable for current-state, single-user, local-first — resume still
        # re-derives correctly; the row is informational, never a render input.
        store.upsert_provenance(
            self.conn, self.sid, scene,
            source="re_query" if op["op"] == "re_query" else "pick",
            query=chosen["query"], rank=chosen["rank"],
            pexels_id=chosen.get("pexels_id"), pexels_url=chosen.get("pexels_url"))

    def run_all(self):
        """Autopilot: advance every stage in order, then materialize spec.json."""
        out = None
        for st in stages.STAGE_ORDER:
            if st == "render":
                continue   # render runs separately (remotion CLI), not in the engine
            out = self.advance(st)
        self.materialize_spec()
        return out

    def materialize_spec(self):
        """Write the current assemble output to spec.json (the render contract).
        Idempotent. NOTE: the sources.json sidecar is NOT written here — the caller
        (main.run) writes it from the script output; spec.json is the only render
        contract the engine owns."""
        from pipeline import validate as validate_stage
        from pipeline import assemble as assemble_stage
        spec = self._load_output("assemble")
        if spec is None:
            return
        validate_stage.validate_spec(spec, self.ctx.catalog)
        assemble_stage.write_spec(spec, self.ctx.spec_out)
        store.update_session(self.conn, self.sid, now=_now(), spec_path=str(self.ctx.spec_out))
