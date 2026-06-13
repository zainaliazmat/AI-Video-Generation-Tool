"""Per-scene template eligibility: which templates can a scene switch to?

A template is eligible for a scene iff:
  1. It is a scene-kind template (not transition/overlay — the slot is a scene slot).
  2. The scene's current templateProps validate against the template's inputSchema.

This is the shared helper extracted for T7 (state surface) and T6 (_pick_template
validation), so the routing signal is never duplicated between the two sides.

Pure: no I/O, no DB access. Takes scene props (a plain dict from spec.json
templateProps or {}) and the catalog (id → Manifest).
"""
from __future__ import annotations

from typing import Dict, List

import jsonschema

from manifest import Manifest
from pipeline.validate import SCENE_KINDS


def eligible_templates(scene_props: dict, catalog: Dict[str, Manifest]) -> List[str]:
    """Return the sorted list of scene-kind template ids whose inputSchema the
    given scene_props satisfy.

    scene_props: the scene's current templateProps (may be {} — e.g. a hero beat
    before a background clip is bound). An empty dict satisfies any schema with no
    required fields; schemas with required fields (stat needs value+label) will not
    validate against an empty dict and are thus ineligible.

    catalog: the full id → Manifest catalog (load_catalog's output).
    """
    result: List[str] = []
    for tmpl_id, manifest in catalog.items():
        if manifest.kind not in SCENE_KINDS:
            continue  # skip transitions, overlays
        try:
            jsonschema.validate(instance=scene_props or {}, schema=manifest.inputSchema)
            result.append(tmpl_id)
        except jsonschema.ValidationError:
            pass
    return sorted(result)
