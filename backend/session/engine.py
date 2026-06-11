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
        downstream, and re-derive the stale stages. Studio v2 adds script + assemble
        edits on top of A.1's footage ops."""
        handlers = {
            "footage": self._edit_footage,
            "script": self._edit_script,
            "timing": self._edit_timing,
            "assemble": self._edit_assemble,
        }
        handler = handlers.get(stage)
        if handler is None:
            raise NotImplementedError(f"edit not implemented for stage {stage!r}")
        handler(op)
        self.invalidate(stage)
        for st in stages.downstream(stage):
            if st == "render":
                continue
            self.advance(st)
        self.materialize_spec()

    def _edit_script(self, op):
        """Studio v2 Script gate edit. Mutate the beats (text / data) or drop a beat,
        run verify-on-edit (FLAG amber, never auto-drop a human's words), re-derive the
        recipe plan from the edited beats, and persist. edit() then re-runs the whole
        downstream pipeline (voice → timing → footage → assemble) per the §7 matrix.

        verify_fn / retrieve_fn ride IN the op dict (in-process callables the CLI/API
        builds) so verify-on-edit stays offline-injectable for tests."""
        from pipeline import recipe as recipe_stage
        from pipeline import verify as verify_stage

        bundle = self._load_output("script")
        if bundle is None:
            raise RuntimeError("cannot edit script: script stage has not completed")
        script = bundle["script"]
        kind = op["op"]
        edited = []

        if kind == "edit_beat":
            i = op["index"]
            if not (0 <= i < len(script.beats)):
                raise IndexError(f"beat index {i} out of range (0..{len(script.beats)-1})")
            if op.get("text") is not None:
                script.beats[i].text = str(op["text"]).strip()
            if "data" in op:                       # may set OR clear (None demotes a stat)
                script.beats[i].data = op["data"]
            edited = [i]
        elif kind == "drop_beat":
            i = op["index"]
            if not (0 <= i < len(script.beats)):
                raise IndexError(f"beat index {i} out of range (0..{len(script.beats)-1})")
            if len(script.beats) <= 1:
                raise ValueError("cannot drop the last remaining beat")
            script.beats.pop(i)
            new_flags = []
            for f in (script.beat_flags or []):
                if f["index"] == i:
                    continue
                new_flags.append({**f, "index": f["index"] - 1} if f["index"] > i else f)
            script.beat_flags = new_flags
        else:
            raise ValueError(f"unknown script op {kind!r}")

        vfn = op.get("verify_fn")
        if edited and vfn is not None:
            verify_stage.verify_edited_beats(
                script, edited, verify_fn=vfn, retrieve_fn=op.get("retrieve_fn"),
                retrieval_key=op.get("retrieval_key"), cache_dir=self.ctx.cache_dir)

        # the slot/template of a beat depends on its data, so re-derive the plan
        plan = recipe_stage.plan(script, theme=self.ctx.theme, manifests=self.ctx.catalog)
        new_bundle = {"script": script, "plan": plan}
        to_json, _ = CODECS["script"]
        store.upsert_stage(
            self.conn, self.sid, "script", status="done",
            input_hash=store.get_stage(self.conn, self.sid, "script")["input_hash"],
            output_json=json.dumps(to_json(new_bundle), default=str), now=_now())

    def _edit_timing(self, op):
        """Studio v2 Timing 'fix a word' (PRD §6.3) — correct a mis-transcribed caption
        TOKEN only. Edits the WordTiming.text at `index`; start/end frames are NEVER
        shifted (timing stays pinned to the audio). edit() then re-derives assemble,
        which rebuilds captions from the patched words (same frames, new text)."""
        if op["op"] != "fix_word":
            raise ValueError(f"unknown timing op {op['op']!r}")
        words = self._load_output("timing")
        if words is None:
            raise RuntimeError("cannot edit timing: timing stage has not completed")
        i = op["index"]
        if not (0 <= i < len(words)):
            raise IndexError(f"word index {i} out of range (0..{len(words)-1})")
        new_text = str(op["text"]).strip()
        if not new_text:
            raise ValueError("fix_word text must be non-empty")
        words[i].text = new_text                         # text only; frames untouched
        to_json, _ = CODECS["timing"]
        store.upsert_stage(
            self.conn, self.sid, "timing", status="done",
            input_hash=store.get_stage(self.conn, self.sid, "timing")["input_hash"],
            output_json=json.dumps(to_json(words), default=str), now=_now())

    def _edit_assemble(self, op):
        """Studio v2 Assemble gate edit — apply a whitelist-validated spec.json patch
        to the persisted assemble output (theme / template / templateProps /
        transition only; never timing / captions / beat count). edit() then
        materializes spec.json. See pipeline.spec_patch for the validator.

        F-5: every applied patch is appended to the spec_patches event log (with its
        diff at apply time), and {"revert": seq} undoes the NEWEST un-reverted patch
        by applying the inverse ops built from that stored diff — through the same
        whitelist + invariant machinery, so a revert can never do what a patch
        couldn't. The spec version shown in the rail is derived from this log."""
        from pipeline import spec_patch
        spec = self._load_output("assemble")
        if spec is None:
            raise RuntimeError("cannot edit assemble: assemble stage has not completed")

        if "revert" in op:
            target_seq = int(op["revert"])
            rows = [r for r in store.get_spec_patches(self.conn, self.sid)
                    if r["kind"] == "patch" and not r["reverted"]]
            if not rows:
                raise ValueError("nothing to revert: no un-reverted patches in history")
            newest = rows[-1]
            if newest["seq"] != target_seq:
                raise ValueError(
                    f"only the newest un-reverted patch (seq {newest['seq']}) can be "
                    f"reverted; walk the stack back one step at a time")
            # Inverse ops: the RAW pointer paths from the stored patch (lossless —
            # diff paths are dotted for display) zipped with the diff's before-values
            # (diff_lines iterates ops in order, so index i lines up with op i).
            applied = json.loads(newest["patch_json"])
            befores = json.loads(newest["diff_json"])
            inverse = [{"op": "replace", "path": o["path"], "value": d["before"]}
                       for o, d in zip(applied, befores)]
            patch, kind, reverts_seq = inverse, "revert", target_seq
        else:
            patch, kind, reverts_seq = op["patch"], "patch", None

        diff = spec_patch.diff_lines(spec, patch)
        patched = spec_patch.apply_patch(spec, patch)  # raises on whitelist violation
        to_json, _ = CODECS["assemble"]
        store.upsert_stage(
            self.conn, self.sid, "assemble", status="done",
            input_hash=store.get_stage(self.conn, self.sid, "assemble")["input_hash"],
            output_json=json.dumps(to_json(patched), default=str), now=_now())
        store.append_spec_patch(self.conn, self.sid, kind=kind, patch=patch, diff=diff,
                                now=_now(), reverts_seq=reverts_seq)
        if reverts_seq is not None:
            store.mark_patch_reverted(self.conn, self.sid, seq=reverts_seq)

    def _edit_footage(self, op):
        from pipeline import footage as footage_stage
        from pipeline.contracts import Clip
        out = self._load_output("footage")
        scene = op["scene_index"]

        if op["op"] == "upload":
            self._upload_footage(out, scene, op)
            return

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

    def _upload_footage(self, out, scene, op):
        """A.2b — bind a user-supplied video OR image file to a footage scene.

        Self-contained: classifies by extension, measures a video's duration
        (fail-loud), stages the file under a content-hashed name so distinct
        content can't silently overwrite, binds a Clip (kind=video/image), persists
        the footage output, and stamps source='uploaded'. The Pexels candidate pool
        is left untouched (an upload is not a pool member). Returns to edit(), which
        invalidates {assemble, render} and re-derives the spec."""
        from pathlib import Path
        from pipeline import media_probe
        from pipeline.contracts import Clip

        file = Path(op["file"])
        if not file.exists():
            raise RuntimeError(f"upload: file not found: {file}")
        kind = media_probe.kind_from_extension(file)  # ValueError on bad extension

        if kind == "video":
            dur_s = media_probe.ffprobe_duration_seconds(file)  # RuntimeError if unmeasurable
            duration_frames = round(dur_s * self.ctx.fps)
        else:
            duration_frames = None  # images carry no duration; never loop

        basename = file.name                       # provenance label keeps the extension
        data = file.read_bytes()
        hash8 = hashlib.sha256(data).hexdigest()[:8]
        ext = file.suffix.lower()
        name = f"footage_upload_s{scene}_{media_probe.slug(file.stem)}_{hash8}{ext}"
        self.ctx.assets_dir.mkdir(parents=True, exist_ok=True)
        dest = self.ctx.assets_dir / name
        if not dest.exists():                      # same content (hash) → idempotent
            dest.write_bytes(data)

        new_clip = Clip(index=scene, query=basename, path=f"assets/{name}",
                        duration_frames=duration_frames, kind=kind,
                        rank=None, pexels_id=None, pexels_url=None)
        if not any(c.index == scene for c in out["clips"]):
            raise RuntimeError(f"upload: no footage clip at scene {scene} to replace")
        out["clips"] = [new_clip if c.index == scene else c for c in out["clips"]]

        to_json, _ = CODECS["footage"]
        store.upsert_stage(self.conn, self.sid, "footage", status="done",
                           input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
                           output_json=json.dumps(to_json(out), default=str), now=_now())
        # Provenance: source='uploaded', query=basename (inert display label — never
        # re-run as a search). rank/pexels are None (not a Pexels result).
        store.upsert_provenance(self.conn, self.sid, scene, source="uploaded",
                                query=basename, rank=None, pexels_id=None, pexels_url=None)

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
