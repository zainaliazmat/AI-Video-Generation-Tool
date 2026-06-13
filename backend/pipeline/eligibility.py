"""Per-scene template eligibility: which templates can a scene switch to?

Eligibility is a function of the BEAT's DATA + its POSITION, NOT the rendered
templateProps. This mirrors `recipe._derive_role` + `recipe._is_stat` /
`recipe._is_enumeration` exactly, so the routing signal is never duplicated.

Rules (PRD §5.3.1, plan M5-T7):
  - 'scene'       : ALWAYS eligible (any beat can be a footage scene).
  - 'stat'        : eligible iff beat carries stat data {value, label}.
  - 'enumeration' : eligible iff beat carries items (data.items) and is NOT
                    stat-shaped — LIVE-ELIGIBLE DAY ONE (plan is explicit).
  - 'hook'        : eligible iff position == 0.
  - 'outro'       : eligible iff position == scene_count - 1.

Position gating fixes the accidental overlap: a last-position outro scene no
longer lists hook, and a first-position hook scene no longer lists outro (unless
scene_count == 1, in which case position 0 == last → both apply).

Pure: no I/O, no DB access.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from manifest import Manifest
from pipeline.validate import SCENE_KINDS


def _has_stat_data(beat_data: Optional[dict]) -> bool:
    """True iff the beat data carries both value and label (stat-wins criterion)."""
    if not isinstance(beat_data, dict):
        return False
    return bool(beat_data.get("value") and beat_data.get("label"))


def _has_enumeration_data(beat_data: Optional[dict]) -> bool:
    """True iff the beat data carries items but is NOT stat-shaped (mutual exclusion)."""
    if not isinstance(beat_data, dict):
        return False
    return bool(beat_data.get("items") and not _has_stat_data(beat_data))


def eligible_templates(
    beat_data: Optional[dict],
    position: int,
    scene_count: int,
    catalog: Dict[str, Manifest],
) -> List[str]:
    """Return the sorted list of scene-kind template ids eligible for this beat.

    beat_data:   the beat's raw .data dict (may be None for text-only beats).
    position:    0-based index of this scene in the script.
    scene_count: total number of scenes in the session.
    catalog:     the full id → Manifest catalog (load_catalog's output).

    Eligibility rules mirror recipe._derive_role + _is_stat/_is_enumeration so
    the routing signal is never duplicated between the two sides.
    """
    result: List[str] = []

    for tmpl_id, manifest in catalog.items():
        if manifest.kind not in SCENE_KINDS:
            continue  # skip transitions, overlays

        # Determine eligibility by template id / consumes capability
        if tmpl_id == "scene":
            # 'scene' is always eligible — any beat can be a footage scene.
            result.append(tmpl_id)
        elif tmpl_id == "stat":
            if _has_stat_data(beat_data):
                result.append(tmpl_id)
        elif tmpl_id == "enumeration" or manifest.consumes == "enumeration":
            if _has_enumeration_data(beat_data):
                result.append(tmpl_id)
        elif tmpl_id == "hook":
            if position == 0:
                result.append(tmpl_id)
        elif tmpl_id == "outro":
            if scene_count > 0 and position == scene_count - 1:
                result.append(tmpl_id)
        # Any other scene-kind template: eligible only for matching position/data
        # (future extension point — for now unknown ids are skipped unless they
        # match the rules above; we could add a fallback for custom templates here).

    return sorted(result)
