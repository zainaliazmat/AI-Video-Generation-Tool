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
        if stage == "assemble":
            # OV-4: inject both override tables into assemble inputs so they participate
            # in _input_hash (changing an override correctly invalidates the assemble cache;
            # a pin survives re-derives only while unchanged — existing caching contract).
            #
            # No-bust normalization: OMIT the "overrides" key when BOTH dicts are empty.
            # Pre-M5 sessions that resume with no override rows keep their assemble hash
            # exactly (zero one-time re-derive cost). Any session with actual overrides
            # gets the key → one-time bust is correct and expected.
            bg = store.get_background_overrides(self.conn, self.sid)
            tmpl = store.get_template_overrides(self.conn, self.sid)
            if bg or tmpl:
                # json.dumps(sort_keys=True) handles int→string key coercion for scene
                # indices; we normalize consciously: scene_index ints from the DB become
                # string keys in JSON, which is consistent across all serialize paths.
                inputs["overrides"] = {"template": tmpl, "background": bg}
        return inputs

    def _input_hash(self, stage, inputs):
        # Non-stage keys (e.g. "overrides" injected by _inputs_for for assemble) are
        # JSON-native already (decoded from DB); pass them through without a codec.
        payload = {"stage": stage, "topic": self.ctx.topic, "fps": self.ctx.fps,
                   "inputs": {d: CODECS[d][0](v) if d in CODECS else v
                               for d, v in inputs.items()}}
        # default-60 omits the key so every pre-M2 stage hash stays valid — no silent
        # re-derive cost on resumed sessions; non-default presets still bust the cache.
        if self.ctx.target_length != 60:
            payload["target_length"] = self.ctx.target_length
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
            self._auto_fill_hero_backgrounds(output)
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

    def _auto_fill_hero_backgrounds(self, footage_output):
        """v3-M5 T2 (PRD §6.3 / OV-4 / OV-5): auto-fill background_overrides for
        hero scenes according to HERO_BACKGROUND_POLICY.

        "auto" (hook/outro): pick rank-1 from the scene's pool VIA select_clip
        INCLUDING the K-floor (zero special-casing — the floor's longer-pick logic
        applies to backgrounds exactly as to footage), download the clip into
        ctx.assets_dir, write a background_overrides row (source="auto",
        picked_rank=<chosen rank>), and append a pick_log entry
        (kind="background", auto_rank=<chosen rank>, human_rank=None).

        "gradient" (stat): pool stays fetched for the gate UI; NO override row
        and NO download.  The renderer without backgroundClip == today's card.

        Idempotency contract:
          * A real re-derive (new inputs → cache miss) always calls this method,
            refreshing auto rows from the new pool.
          * A pinned row (source="pinned") is NEVER overwritten — it survives
            re-derives; only auto rows are refreshed.
          * Empty pool / pool_error → no row, no crash (gradient fallback implicit).

        ts (OV-9): engine._now() returns the fixed token "now"; genuine wall-clock
        time is stamped at CLI-boundary calls.  This hook runs INSIDE the engine
        process (same process as the CLI), so datetime.now(timezone.utc).isoformat()
        is honest real time here — used instead of _now() for pick_log.ts which is
        meant to provide ②b evidence of genuine time ordering."""
        from datetime import datetime, timezone
        from pipeline import footage as footage_stage
        from pipeline import assemble as assemble_stage

        policy = footage_stage.HERO_BACKGROUND_POLICY
        candidates = footage_output.get("candidates", {})

        # Role-per-scene: come from the script plan.  Load it from the script
        # stage output — the engine already has the stage output in the DB by
        # the time footage completes.  _load_output is the canonical accessor.
        script_bundle = self._load_output("script")
        if script_bundle is None:
            return  # guard: should never happen when footage completed
        plan = script_bundle.get("plan")
        if plan is None:
            return

        # Hoist span computation above the loop (voice is a guaranteed footage dep).
        offsets = self._load_output("voice")
        _, durations, _ = assemble_stage.scene_spans(offsets, self.ctx.fps)
        headroom = max(
            (m.durationFrames.max for m in self.ctx.catalog.values()
             if m.kind == "transition"),
            default=0,
        )

        # Hoist the pinned-row snapshot above the loop (one DB round-trip, not N).
        existing = store.get_background_overrides(self.conn, self.sid)

        for i, ps in enumerate(plan.scenes):
            role = ps.role
            action = policy.get(role)   # "auto" | "gradient" | None (non-hero middle scene)
            if action != "auto":
                continue  # gradient → no override; non-hero scenes → skip entirely

            # Check whether a pinned row already exists — never clobber it.
            row = existing.get(i)
            if row is not None and row.get("source") == "pinned":
                continue  # pinned survives re-derives (T5's hash story; here just skip)

            # Obtain the pool rows for this hero scene.
            pool_rows = candidates.get(i, [])
            if not pool_rows:
                continue  # empty pool / pool_error → no row, no crash

            # Reconstruct the "videos" list expected by select_clip from pool rows.
            # Pool rows carry: link, duration_frames, rank, pexels_id, pexels_url, query.
            # select_clip expects the raw Pexels video shape with "video_files" and
            # "duration" (seconds).  Reconstruct the minimal shape that pick_video_file
            # and _video_duration_frames need — then call select_clip INCLUDING the
            # K-floor (min_frames) so the background auto-fill uses the exact same
            # longer-pick logic as footage scene clip selection.
            fps = self.ctx.fps

            # Heroes floor on their narration span exactly like footage scenes (zero
            # special-casing): same formula as executors._footage_requests.
            min_frames = (durations[i] + headroom) // 2

            # Reconstruct minimal Pexels video shape from pool rows for select_clip.
            def _row_to_pexels_video(r):
                dur_frames = r.get("duration_frames")
                dur_s = (dur_frames / fps) if (dur_frames and fps) else None
                return {
                    "duration": dur_s,
                    "video_files": [{"link": r.get("link", ""), "width": 1080,
                                     "height": 1920, "file_type": "video/mp4"}],
                    "id": r.get("pexels_id"),
                    "url": r.get("pexels_url"),
                }

            videos = [_row_to_pexels_video(r) for r in pool_rows]
            sel = footage_stage.select_clip(videos, min_frames=min_frames, fps=fps)

            if sel.link is None:
                continue  # no usable clip in pool

            # find the pool row that matches the chosen rank so we have the full dict
            chosen_row = next((r for r in pool_rows if r.get("rank") == sel.rank), None)
            if chosen_row is None:
                continue  # shouldn't happen; defensive

            # Download the clip via the shared helper (fail-loud-safe: returns None on
            # missing link or download failure → no override row, no crash).
            slug = footage_stage.query_slug(chosen_row.get("query", ""))
            rank = sel.rank
            # _download_background_clip needs a "link" key; chosen_row already has it.
            dest_path = self._download_background_clip(
                {**chosen_row, "link": sel.link}, slug, rank)
            if dest_path is None:
                continue  # download failed or no link → no override row, no crash

            chosen_row["_dest_path"] = dest_path
            clip_value = self._clip_value_from_row(chosen_row, kind="video")

            # Write the background_overrides row (upsert — idempotent on re-fire).
            ts = datetime.now(timezone.utc).isoformat()  # OV-9: real time in-process hook
            store.upsert_background_override(
                self.conn, self.sid, i,
                value=clip_value, source="auto", picked_rank=rank, now=ts)

            # Append pick_log entry (kind="background").
            store.append_pick_log(
                self.conn, self.sid,
                scene_index=i, kind="background",
                query=chosen_row.get("query"),
                auto_rank=rank, human_rank=None, ts=ts)

    def invalidate(self, from_stage):
        for st in stages.downstream(from_stage):
            row = store.get_stage(self.conn, self.sid, st)
            if row is not None:
                store.set_stage_status(self.conn, self.sid, st, "stale", now=_now())

    def edit(self, stage, op, *, rederive=True):
        """Apply a stage-specific edit, persist the new stage output, invalidate
        downstream, and (by default) re-derive the stale stages. Studio v2 adds
        script + assemble edits on top of A.1's footage ops.

        The v3 gated reopen path passes rederive=False: edits accumulate, downstream
        stays stale, and Re-approve pays with ONE rederive_stale() (PRD §4.1). The
        default (rederive=True) is byte-identical to the pre-v3 behavior — all v2
        callers that omit the kwarg continue to work unchanged."""
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
        if not rederive:
            return
        for st in stages.downstream(stage):
            if st == "render":
                continue
            self.advance(st)
        self.materialize_spec()

    def rederive_stale(self, on_stage=None):
        """Re-derive every stale stage in DAG order, then re-materialize the spec.

        The §4.1 Re-approve payment: one pass, regardless of how many edits
        accumulated while the gate was reopened.

        on_stage(stage, state, elapsed) emits REAL stage events (design ruling 1:
        the Re-approve interstitial uses the same honest task-card contract as any
        segment — never a synthetic 'rederive'). Called with state='running' and
        elapsed=None before the stage runs, then state='done' and elapsed (seconds,
        rounded to 1 decimal) after."""
        import time as _time
        ran = []
        for st in stages.STAGE_ORDER:
            if st == "render":
                continue
            row = store.get_stage(self.conn, self.sid, st)
            if row is not None and row["status"] == "stale":
                t0 = _time.monotonic()
                if on_stage:
                    on_stage(st, "running", None)
                # STAGE_ORDER is topological, so upstream is always done before we
                # reach a downstream stale stage. If that invariant ever breaks,
                # advance() raises RuntimeError from _inputs_for — loud, not silent.
                self.advance(st)
                if on_stage:
                    on_stage(st, "done", round(_time.monotonic() - t0, 1))
                ran.append(st)
        if ran:
            self.materialize_spec()
        return ran

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
            # Reconcile every scene_index-keyed table BEFORE re-deriving the plan.
            # Runs here (inside _edit_script, before the handler returns) so BOTH
            # paths — rederive=True and rederive=False — hit this reconcile: edit()
            # calls handler(op) first, then branches on rederive, so the tables are
            # always consistent before any downstream re-derive or deferred payment.
            store.drop_scene_index(self.conn, self.sid, i)
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
        # Catalog validation BEFORE persisting — keeps the edit atomic. Without it a
        # template-id the catalog rejects (e.g. 'clip') is baked into the stage output
        # and the history log, then trips validate_spec at every later materialize,
        # leaving the session permanently stuck. Validate first; persist only if clean.
        from pipeline import validate as validate_stage
        validate_stage.validate_spec(patched, self.ctx.catalog)
        to_json, _ = CODECS["assemble"]
        store.upsert_stage(
            self.conn, self.sid, "assemble", status="done",
            input_hash=store.get_stage(self.conn, self.sid, "assemble")["input_hash"],
            output_json=json.dumps(to_json(patched), default=str), now=_now())
        store.append_spec_patch(self.conn, self.sid, kind=kind, patch=patch, diff=diff,
                                now=_now(), reverts_seq=reverts_seq)
        if reverts_seq is not None:
            store.mark_patch_reverted(self.conn, self.sid, seq=reverts_seq)

    # ── hero-role lookup helper ───────────────────────────────────────────────
    def _is_hero_scene(self, scene_index: int) -> bool:
        """True when scene_index belongs to a hero role (hook/stat/outro).
        Hero roles are those with a HERO_BACKGROUND_POLICY entry (T6 invariant:
        the policy table is the policy-known set — no separate hard list)."""
        from pipeline import footage as footage_stage
        script_bundle = self._load_output("script")
        if script_bundle is None:
            return False
        plan = script_bundle.get("plan")
        if plan is None or scene_index >= len(plan.scenes):
            return False
        role = plan.scenes[scene_index].role
        return role in footage_stage.HERO_BACKGROUND_POLICY

    def _edit_footage(self, op):
        from pipeline import footage as footage_stage
        from pipeline.contracts import Clip
        from datetime import datetime, timezone
        out = self._load_output("footage")
        scene = op["scene_index"]
        target = op.get("target", "footage")  # "footage" (default) | "background"

        # ── pick_template — template override for any scene ──────────────────────
        if op["op"] == "pick_template":
            self._pick_template(scene, op)
            return

        # ── HERO-PICK GUARD (T2-review hazard) ──────────────────────────────────
        # A plain footage-target op aimed at a hero index is rejected — heroes have
        # candidate rows since T1, so the old path would download + stamp bogus
        # provenance and bind nothing (the clip list has no hero entry).
        # Symmetrically, target:"background" on a non-hero is rejected.
        is_hero = self._is_hero_scene(scene)
        if target == "footage" and is_hero:
            raise ValueError(
                f"scene {scene} is a hero — use target:'background' for background pick/re_query/upload")
        if target == "background" and not is_hero:
            raise ValueError(
                f"scene {scene} is not a hero scene — target:'background' requires a hero scene "
                f"(hook/stat/outro)")

        # ── background target — ops write to background_overrides + pick_log ────
        if target == "background":
            self._edit_background(out, scene, op)
            return

        # ── footage target (default) — existing op vocabulary unchanged ──────────
        if op["op"] == "upload":
            self._upload_footage(out, scene, op)
            return

        if op["op"] == "re_query":
            from pipeline.footage_query import harden
            # broaden=True → use plan.title (the autopilot whiff-fallback idiom,
            # §5.3.3: ground-truth in executors._footage_requests, harden(plan.title, title=...)).
            # Use plan.title (LLM-generated) not ctx.topic (raw user input) to mirror autopilot.
            script_bundle = self._load_output("script")
            plan_title = (script_bundle["plan"].title
                          if script_bundle and script_bundle.get("plan") is not None
                          else self.ctx.topic)
            if op.get("broaden"):
                raw_q = plan_title
            else:
                raw_q = op["query"]
            q = harden(raw_q, title=plan_title)
            # NOTE: footage re_query does NOT use _requery_pool — the pool write for
            # the footage path is shared with the pick path in the unified tail below
            # (both converge on `rows` + `chosen` then do the single store write).
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

        # download the chosen candidate into the assets dir and bind it to the scene's Clip.
        # The merged pool mixes video and photo rows: an image candidate downloads to .jpg
        # and binds a kind="image" Clip (rendered via the scene template's <Img> branch);
        # video stays .mp4. _download streams raw bytes, so it serves either.
        kind = chosen.get("kind", "video")
        ext = "jpg" if kind == "image" else "mp4"
        dest = self.ctx.assets_dir / f"footage_{footage_stage.query_slug(chosen['query'])}_{chosen['rank']}.{ext}"
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
                        path=f"assets/{dest.name}", duration_frames=chosen.get("duration_frames"),
                        kind=kind)
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

    # ── shared pool-refresh helper (Fix 6) ───────────────────────────────────────

    def _requery_pool(self, q: str, scene: int, out: dict) -> list:
        """Search Pexels for `q`, replace the candidate pool for `scene` in `out` and
        in the DB, and persist the updated footage output.  Returns the new rows list.

        Both footage re_query and background re_query share this prologue; callers
        branch on the tail (footage rebinds a clip; background auto-follows per Fix 5)."""
        from pipeline import footage as footage_stage

        key = footage_stage.require_env("PEXELS_API_KEY")
        data = footage_stage.search_pexels(q, key)
        rows = footage_stage.candidate_rows(data.get("videos", []), query=q, fps=self.ctx.fps)
        for r in rows:
            r["selected"] = 0
            r.setdefault("clip_path", None)
        out["candidates"][scene] = rows
        store.replace_footage_candidates(self.conn, self.sid, scene_index=scene, candidates=rows)
        to_json, _ = CODECS["footage"]
        store.upsert_stage(self.conn, self.sid, "footage", status="done",
                           input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
                           output_json=json.dumps(to_json(out), default=str), now=_now())
        return rows

    # ── background clip helpers (Fix 4) ──────────────────────────────────────────

    @staticmethod
    def _clip_value_from_row(row: dict, *, kind: str = "video") -> dict:
        """Build the Media-shaped dict stored in background_overrides.value from a
        pool row.  `kind` is explicit so callers never silently inherit a wrong default:
        pass 'video' for Pexels results, the probed kind for uploads."""
        return {
            "path": row["_dest_path"],   # set by _download_background_clip
            "query": row.get("query"),
            "rank": row.get("rank"),
            "pexels_id": row.get("pexels_id"),
            "pexels_url": row.get("pexels_url"),
            "duration_frames": row.get("duration_frames"),
            "kind": kind,
        }

    def _download_background_clip(self, row: dict, slug: str, rank) -> "str | None":
        """Download a background clip to assets_dir and return the `assets/<name>` path,
        or None on missing link OR download failure (fail-loud-safe so callers can never
        write a background_override pointing at a file that was never downloaded).

        The dest filename follows the same `footage_bg_{slug}_{rank}.mp4` idiom used by
        the auto-fill hook and the pick path so all three share the same cache on disk."""
        from pipeline import footage as footage_stage

        dest = self.ctx.assets_dir / f"footage_bg_{slug}_{rank}.mp4"
        self.ctx.assets_dir.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            return f"assets/{dest.name}"
        link = row.get("link")
        if not link:
            return None
        try:
            footage_stage._download(link, dest)
        except Exception:
            return None
        return f"assets/{dest.name}"

    def _edit_background(self, out, scene, op):
        """Background overrides for hero scenes: pick/re_query/upload write to
        background_overrides + pick_log instead of clips/provenance.

        pick:     offline from the stored pool (rank r) — download + upsert background_overrides
                  {source:"pinned", picked_rank:r} + append pick_log (kind="background").
        re_query: re-fetch the pool for the hero; replace footage_candidates rows for the scene;
                  update the AUTO row to the new rank-1 ONLY if current override is source=auto
                  (never touch pinned). pick_log entry records the query change (human_rank=None).
        upload:   probe/stage the file (reuse _upload_footage's idiom), write background_overrides
                  {source:"pinned", picked_rank:None} + pick_log row.
        broaden:  if op.get("broaden") is True, query := plan.title (for re_query ops).
        """
        from pipeline import footage as footage_stage
        from pipeline.footage_query import harden
        from datetime import datetime, timezone

        ts = datetime.now(timezone.utc).isoformat()

        if op["op"] == "pick":
            rank = op["rank"]
            # Read pool from the footage output (same offline-deterministic idiom as footage pick)
            rows = [dict(r) for r in out["candidates"].get(scene, [])]
            chosen = next((r for r in rows if r.get("rank") == rank), None)
            if chosen is None:
                raise RuntimeError(f"no background candidate for scene {scene} rank {rank}")

            # Determine the prior auto_rank for the pick_log entry (may be None)
            existing_overrides = store.get_background_overrides(self.conn, self.sid)
            existing_row = existing_overrides.get(scene)
            prior_auto_rank = (existing_row.get("picked_rank")
                               if existing_row and existing_row.get("source") == "auto"
                               else None)

            # Download via shared helper; raise loud on missing link (pick is deterministic).
            slug = footage_stage.query_slug(chosen.get("query", ""))
            dest_path = self._download_background_clip(chosen, slug, rank)
            if dest_path is None:
                raise RuntimeError(
                    f"background pick: no download link for scene {scene} rank {rank}")
            chosen["_dest_path"] = dest_path
            clip_value = self._clip_value_from_row(chosen, kind="video")
            store.upsert_background_override(
                self.conn, self.sid, scene,
                value=clip_value, source="pinned", picked_rank=rank, now=ts)
            store.append_pick_log(
                self.conn, self.sid,
                scene_index=scene, kind="background",
                query=chosen.get("query"),
                auto_rank=prior_auto_rank, human_rank=rank, ts=ts)

        elif op["op"] == "re_query":
            # broaden=True → use plan.title (gate-op form of the autopilot whiff-fallback).
            # Use plan.title (LLM-generated) not ctx.topic (raw user input) to mirror autopilot.
            script_bundle = self._load_output("script")
            plan_title = (script_bundle["plan"].title
                          if script_bundle and script_bundle.get("plan") is not None
                          else self.ctx.topic)
            if op.get("broaden"):
                raw_q = plan_title
            else:
                raw_q = op["query"]
            q = harden(raw_q, title=plan_title)
            # Replace pool via shared helper (search+candidates+upsert_stage).
            rows = self._requery_pool(q, scene, out)

            # Update the AUTO row only if current row is source=auto
            # (never touch a pinned row — the policy contract for background re_query).
            # Fix 5: use select_clip with the same K-floor the auto-fill hook uses so
            # a pool whose rank-1 is too short doesn't auto-follow to a broken clip.
            existing_overrides = store.get_background_overrides(self.conn, self.sid)
            existing_row = existing_overrides.get(scene)
            if existing_row is None or existing_row.get("source") == "auto":
                if rows:
                    from pipeline import assemble as assemble_stage

                    # Reconstruct min_frames the same way _auto_fill_hero_backgrounds does.
                    offsets = self._load_output("voice")
                    _, durations, _ = assemble_stage.scene_spans(offsets, self.ctx.fps)
                    headroom = max(
                        (m.durationFrames.max for m in self.ctx.catalog.values()
                         if m.kind == "transition"),
                        default=0,
                    )
                    fps = self.ctx.fps
                    min_frames = (durations[scene] + headroom) // 2

                    # Reconstruct minimal Pexels video shape for select_clip.
                    def _row_to_pexels_video(r):
                        dur_frames = r.get("duration_frames")
                        dur_s = (dur_frames / fps) if (dur_frames and fps) else None
                        return {
                            "duration": dur_s,
                            "video_files": [{"link": r.get("link", ""), "width": 1080,
                                             "height": 1920, "file_type": "video/mp4"}],
                            "id": r.get("pexels_id"),
                            "url": r.get("pexels_url"),
                        }

                    videos = [_row_to_pexels_video(r) for r in rows]
                    sel = footage_stage.select_clip(videos, min_frames=min_frames, fps=fps)

                    if sel.link is not None:
                        # Bind the pool row whose rank matches the K-floor selection.
                        chosen_row = next(
                            (r for r in rows if r.get("rank") == sel.rank), None)
                        if chosen_row is not None:
                            slug = footage_stage.query_slug(chosen_row.get("query", ""))
                            rank = sel.rank
                            # Use shared download helper (fail-loud-safe).
                            dest_path = self._download_background_clip(
                                {**chosen_row, "link": sel.link}, slug, rank)
                            if dest_path is not None:
                                chosen_row["_dest_path"] = dest_path
                                clip_value = self._clip_value_from_row(
                                    chosen_row, kind="video")
                                store.upsert_background_override(
                                    self.conn, self.sid, scene,
                                    value=clip_value, source="auto", picked_rank=rank,
                                    now=ts)
                # else: empty pool or no usable clip → leave existing auto row in place

            # Record re_query in pick_log (human_rank=None — not a human pick, a pool refresh)
            store.append_pick_log(
                self.conn, self.sid,
                scene_index=scene, kind="background",
                query=q, auto_rank=None, human_rank=None, ts=ts)

        elif op["op"] == "upload":
            # Reuse the probe/stage idiom from _upload_footage
            from pathlib import Path
            from pipeline import media_probe

            file = Path(op["file"])
            if not file.exists():
                raise RuntimeError(f"background upload: file not found: {file}")
            kind = media_probe.kind_from_extension(file)  # ValueError on bad extension

            if kind == "video":
                dur_s = media_probe.ffprobe_duration_seconds(file)
                duration_frames = round(dur_s * self.ctx.fps)
            else:
                duration_frames = None

            basename = file.name
            data = file.read_bytes()
            hash8 = hashlib.sha256(data).hexdigest()[:8]
            ext = file.suffix.lower()
            name = f"footage_bg_upload_s{scene}_{media_probe.slug(file.stem)}_{hash8}{ext}"
            self.ctx.assets_dir.mkdir(parents=True, exist_ok=True)
            dest = self.ctx.assets_dir / name
            if not dest.exists():
                dest.write_bytes(data)

            # Build clip_value via shared helper; upload carries the probed kind
            # so assemble.py renders images via <Img>, not OffthreadVideo.
            upload_row = {
                "_dest_path": f"assets/{name}",
                "query": basename,
                "rank": None,
                "pexels_id": None,
                "pexels_url": None,
                "duration_frames": duration_frames,
            }
            clip_value = self._clip_value_from_row(upload_row, kind=kind)
            store.upsert_background_override(
                self.conn, self.sid, scene,
                value=clip_value, source="pinned", picked_rank=None, now=ts)
            store.append_pick_log(
                self.conn, self.sid,
                scene_index=scene, kind="background",
                query=basename, auto_rank=None, human_rank=None, ts=ts)
        else:
            raise ValueError(f"unknown background op {op['op']!r}")

    def _pick_template(self, scene, op):
        """pick_template op: write template_overrides {source:'pinned', value: template_id}.

        Eligibility:
          1. Catalog presence (precise error: "unknown template id").
          2. Scene-kind (precise error: "kind ... only scene-kind templates").
          3. Scene index bounds: checked against the script plan to give a clear
             error ("no scene at index N") before any eligibility work.
          4. Beat data + position: delegates to the shared eligible_templates()
             helper so the routing signal is never duplicated.
          5. Position gate: hook is only eligible at position 0; outro is only
             eligible at the last position.

        Note on pick_log: the pick_log table CHECK constrains kind IN ('footage','background').
        Template picks are NOT in the log's vocabulary. template_overrides.updated_at is the
        audit record for template picks — do NOT attempt to append pick_log for template ops.
        """
        from pipeline import validate as validate_stage
        from pipeline.eligibility import eligible_templates

        template_id = op.get("template")
        if not template_id:
            raise ValueError("pick_template requires a 'template' field")

        # 1. Catalog presence check (precise error message preserved for existing tests)
        manifest = self.ctx.catalog.get(template_id)
        if manifest is None:
            raise ValueError(
                f"pick_template: unknown template id {template_id!r} (not in catalog)")

        # 2. Kind check: only scene-kind templates are eligible for scene position override
        #    (precise error message preserved for existing tests — cases 8/9)
        if manifest.kind not in validate_stage.SCENE_KINDS:
            raise ValueError(
                f"pick_template: template {template_id!r} has kind {manifest.kind!r}; "
                f"only scene-kind templates ({sorted(validate_stage.SCENE_KINDS)}) are eligible")

        # 3. Scene index bounds guard: load plan to know how many scenes exist.
        script_bundle = self._load_output("script")
        if script_bundle is not None:
            plan = script_bundle.get("plan")
            if plan is not None:
                n = len(plan.scenes)
                if scene >= n or scene < 0:
                    raise ValueError(
                        f"pick_template: no scene at index {scene} "
                        f"(session has {n} scenes)")

        # 4. Beat data + position eligibility via the shared helper.
        #    Load beat data from the script bundle (same source as session_state.py).
        beat_data = None
        scene_count = 0
        if script_bundle is not None:
            script_obj = script_bundle.get("script")
            plan = script_bundle.get("plan")
            if script_obj is not None and hasattr(script_obj, "beats"):
                beats = script_obj.beats
                scene_count = len(beats)
                if 0 <= scene < len(beats):
                    beat_data = beats[scene].data if beats[scene].data else None

        eligible = eligible_templates(beat_data, scene, scene_count, self.ctx.catalog)
        if template_id not in eligible:
            # Build a human-readable reason for the rejection
            if template_id == "hook" and scene != 0:
                reason = f"'hook' is only eligible at position 0 (scene {scene} is not the first)"
            elif template_id == "outro" and scene_count > 0 and scene != scene_count - 1:
                reason = f"'outro' is only eligible at the last position (scene {scene} is not the last)"
            else:
                reason = (
                    f"template {template_id!r} requires data the beat at scene {scene} "
                    f"does not carry (eligible: {eligible})"
                )
            raise ValueError(f"pick_template: {reason}")

        # 5. Pre-write renderability guard — mirrors build_spec's own check (assemble.py
        #    ~230-243) so the rejection happens BEFORE any DB write.
        #
        #    Unrenderable case: a non-footage (hero) scene is being switched to the
        #    plain footage 'scene' template, but that scene has no downloaded clip.
        #    Reproduces exactly the `elif override_applied and not needs_rederive and not
        #    ps.needs_footage` branch in build_spec that checks `clips_by_index.get(i)`.
        #
        #    Detection logic (mirrors assemble._is_data_driven):
        #      - "needs footage media" == kind=='scene' AND consumes != 'enumeration'
        #        (enumeration has kind='scene' but is data-driven, not footage-driven)
        #      - "current scene is hero" == plan.scenes[scene].needs_footage is False
        #      - "has a clip" == footage output has a Clip with .index == scene
        _target_needs_footage = (
            manifest.kind == "scene" and manifest.consumes != "enumeration"
        )
        if _target_needs_footage and script_bundle is not None:
            _plan = script_bundle.get("plan")
            if _plan is not None and 0 <= scene < len(_plan.scenes):
                _current_needs_footage = _plan.scenes[scene].needs_footage
                if not _current_needs_footage:
                    # Current scene is a hero (hook/stat/outro) — check whether a
                    # footage clip has been downloaded for this scene index.
                    _footage_out = self._load_output("footage")
                    _has_clip = (
                        _footage_out is not None
                        and any(c.index == scene for c in _footage_out.get("clips", []))
                    )
                    if not _has_clip:
                        # Promote a background clip into this scene's footage so a hero
                        # (stat/hook/outro) can become a footage 'scene'. Source order:
                        #   1. a pinned/auto background_override (already downloaded), or
                        #   2. the top-ranked background POOL candidate (download it now,
                        #      mirroring _edit_background pick) — parity with hook/outro,
                        #      which auto-fill a background so their 'scene' card is enabled.
                        from pipeline.contracts import Clip
                        overrides = store.get_background_overrides(self.conn, self.sid)
                        bg = overrides.get(scene)
                        promoted = None
                        if bg and (bg.get("value") or {}).get("path"):
                            v = bg["value"]
                            promoted = Clip(
                                index=scene, query=v.get("query") or "", path=v["path"],
                                duration_frames=v.get("duration_frames"),
                                kind=v.get("kind", "video"), rank=v.get("rank"),
                                pexels_id=v.get("pexels_id"), pexels_url=v.get("pexels_url"))
                        else:
                            cands = (_footage_out or {}).get("candidates", {}).get(scene) or []
                            chosen = min(cands, key=lambda r: r.get("rank") or 1_000_000,
                                         default=None)
                            if chosen is not None:
                                from pipeline import footage as footage_stage
                                slug = footage_stage.query_slug(chosen.get("query", ""))
                                dest_path = self._download_background_clip(
                                    chosen, slug, chosen.get("rank"))
                                if dest_path is None:
                                    raise ValueError(
                                        f"assemble: template_override scene {scene}: could not "
                                        f"download a background clip to use as footage")
                                promoted = Clip(
                                    index=scene, query=chosen.get("query") or "",
                                    path=dest_path,
                                    duration_frames=chosen.get("duration_frames"),
                                    kind="video", rank=chosen.get("rank"),
                                    pexels_id=chosen.get("pexels_id"),
                                    pexels_url=chosen.get("pexels_url"))
                        if promoted is None:
                            raise ValueError(
                                f"assemble: template_override scene {scene}: pick a background "
                                f"clip first, then switch to a scene template")
                        bundle = _footage_out or {"clips": [], "candidates": {}}
                        bundle["clips"] = [
                            c for c in bundle.get("clips", []) if c.index != scene
                        ] + [promoted]
                        to_json, _ = CODECS["footage"]
                        store.upsert_stage(
                            self.conn, self.sid, "footage", status="done",
                            input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
                            output_json=json.dumps(to_json(bundle), default=str), now=_now())

        # All checks passed — write the override
        from datetime import datetime, timezone
        ts = datetime.now(timezone.utc).isoformat()
        store.upsert_template_override(
            self.conn, self.sid, scene,
            value=template_id, source="pinned", picked_rank=None, now=ts)

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
