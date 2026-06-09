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
        return output

    def invalidate(self, from_stage):
        for st in stages.downstream(from_stage):
            row = store.get_stage(self.conn, self.sid, st)
            if row is not None:
                store.set_stage_status(self.conn, self.sid, st, "stale", now=_now())

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
