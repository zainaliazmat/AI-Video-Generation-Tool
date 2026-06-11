"""Stage — claim verification (step 3.3). Default-on for client output.

The grounding spine guarantees a citation is a REAL retrieved URL; this pass adds
the harder guarantee: that a retrieved snippet actually SUPPORTS the spoken claim.
Per factual beat:

  * spoken claim unsupported   -> DROP the beat. The narration (TTS + captions) is
    what reaches the viewer, and it usually IS the claim — so demoting would only
    hide the on-screen number while a wrong fact is still spoken.
  * only the on-screen NUMBER unsupported, the narration stands without it
    -> DEMOTE: strip the stat `data` so the recipe renders a footage scene, not an
    unsourced number. (The edge case.)
  * supported -> keep, re-attaching the best supporting source.

Before any drop, a BOUNDED targeted Tavily lookup for the specific claim rescues a
true fact the broad topic search missed (≤ max_targeted; the per-claim half of the
≤4-Tavily/video budget). The LLM verifier is injected (`verify_fn`) so this runs
offline in tests; the default batches a single DeepSeek call.
"""
from __future__ import annotations

from typing import Callable, Dict, List, Optional

from pipeline.content import BeatsScript


def _is_stat(beat) -> bool:
    d = beat.data
    return bool(isinstance(d, dict) and d.get("value") and d.get("label"))


def _item(index: int, beat, snippets: List[Dict]) -> Dict:
    """One verification request: the claim, its on-screen number (if a stat), and
    the candidate snippets the verifier should check it against."""
    return {
        "index": index,
        "claim": beat.text,
        "value": (beat.data or {}).get("value") if _is_stat(beat) else None,
        "snippets": snippets,
    }


def verify_script(
    script: BeatsScript,
    ctx,
    *,
    verify_fn: Callable[[List[Dict]], List[Dict]],
    retrieve_fn=None,
    retrieval_key: Optional[str] = None,
    cache_dir=None,
    max_targeted: int = 3,
) -> BeatsScript:
    """Verify each factual beat's claim against the retrieved snippets and correct
    the script: drop unsupported claims, demote unsupported numbers, keep the rest.

    `verify_fn(items) -> verdicts` where a verdict is
    {index, claim_supported: bool, number_supported: bool|None, source: str|None}.
    `retrieve_fn` (optional) powers the bounded targeted rescue lookup."""
    factual = [(i, b) for i, b in enumerate(script.beats) if b.source or _is_stat(b)]
    if not factual:
        return script
    factual_idx = {i for i, _ in factual}
    beat_by_idx = {i: b for i, b in factual}

    snippets = [{"url": s.url, "content": s.content} for s in ctx.snippets]
    verdicts = {v["index"]: v for v in verify_fn([_item(i, b, snippets) for i, b in factual])}

    # Coverage guard: a factual beat the verifier returned NO verdict for must not
    # pass through as verified — default-deny so the rescue + drop path catches it.
    for i in factual_idx:
        verdicts.setdefault(i, {"index": i, "claim_supported": False, "number_supported": None, "source": None})

    # Targeted rescue (BATCHED): collect the unsupported claims (bounded), do their
    # per-claim Tavily lookups, then ONE re-verify call — ≤2 verify calls per video.
    to_rescue = [i for i in sorted(factual_idx) if not verdicts[i].get("claim_supported")][:max_targeted]
    if to_rescue and retrieve_fn is not None:
        rescue_items = []
        for i in to_rescue:
            tctx = retrieve_fn(beat_by_idx[i].text, key=retrieval_key, cache_dir=cache_dir)
            snips = [{"url": s.url, "content": s.content} for s in tctx.snippets]
            rescue_items.append(_item(i, beat_by_idx[i], snips))
        for v in verify_fn(rescue_items):
            verdicts[v["index"]] = v

    kept: List = []
    report: List[Dict] = []
    for i, b in enumerate(script.beats):
        if i not in factual_idx:
            kept.append(b)  # non-factual (e.g. outro CTA) — leave it
            continue
        v = verdicts[i]
        if not v.get("claim_supported"):
            report.append({"text": b.text, "verdict": "dropped"})
            continue  # DROP — a wrong fact must not reach the viewer
        if v.get("source"):
            b.source = v["source"]
        if _is_stat(b) and v.get("number_supported") is False:
            b.data = None  # DEMOTE -> recipe renders a footage scene, not an unsourced number
            report.append({"text": b.text, "verdict": "demoted"})
        else:
            report.append({"text": b.text, "verdict": "kept"})
        kept.append(b)

    script.beats = kept
    script.verify_report = report
    return script


def verify_edited_beats(
    script: BeatsScript,
    indices,
    *,
    verify_fn: Callable[[List[Dict]], List[Dict]],
    retrieve_fn=None,
    retrieval_key: Optional[str] = None,
    cache_dir=None,
) -> BeatsScript:
    """Studio v2 edit-time verify (PRD §6.1).

    DIFFERENT semantics from generation-time `verify_script`: a human's free edit is
    NEVER auto-dropped — an unsupported edited claim is FLAGGED amber so the operator
    decides (add a source / reword / warn-and-ship). Only the edited `indices` are
    re-checked (targeted Tavily recheck via `retrieve_fn`, then `verify_fn`).

    Writes `script.beat_flags` = [{index, status, reason}] where status is
    "supported" (source re-attached) or "unverified" (amber). Leaves `script.beats`
    untouched (text is the operator's). Idempotent for a given verdict set."""
    indices = sorted({i for i in indices if 0 <= i < len(script.beats)})
    items = []
    for i in indices:
        b = script.beats[i]
        snips: List[Dict] = []
        if retrieve_fn is not None:
            tctx = retrieve_fn(b.text, key=retrieval_key, cache_dir=cache_dir)
            snips = [{"url": s.url, "content": s.content} for s in tctx.snippets]
        items.append(_item(i, b, snips))
    verdicts = {v["index"]: v for v in verify_fn(items)} if items else {}

    flags = list(script.beat_flags or [])
    flags = [f for f in flags if f.get("index") not in indices]  # replace edited entries
    for i in indices:
        v = verdicts.get(i, {"claim_supported": False, "source": None})
        if v.get("claim_supported"):
            if v.get("source"):
                script.beats[i].source = v["source"]
            flags.append({"index": i, "status": "supported", "reason": None})
        else:
            flags.append({"index": i, "status": "unverified",
                          "reason": "verify could not support this edit — add a source or reword"})
    flags.sort(key=lambda f: f["index"])
    script.beat_flags = flags
    return script

