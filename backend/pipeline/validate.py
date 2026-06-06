"""Step 6.3 — validate a Spec against the template catalog BEFORE render.

The fail-fast backstop behind the renderer's type-level discrimination (step 4):
a bad prop or a template used in the wrong slot must fail loudly here, not paint a
loud placeholder at render time and certainly not at volume.

Two checks per reference:
  1. SLOT/KIND — a `scene.template` must be a content kind (not transition/overlay);
     a `scene.transition.template` must be `transition`; a `layers[].template` must
     be `overlay`.
  2. PROPS — the props validate against that template's manifest `inputSchema`
     (JSON Schema, authored as zod in the template — see step 6.3 codegen).

`validate_spec` is pure given an injected catalog; `load_catalog` is the thin
filesystem scan that builds it.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

import jsonschema

from manifest import Manifest
from schema import Spec

# Kinds that may render in a scene position (NOT transition, NOT overlay).
SCENE_KINDS = {"hook", "scene", "stat", "lower-third", "outro"}


def load_catalog(templates_dir) -> Dict[str, Manifest]:
    """Scan <templates_dir>/*/manifest.json into an id -> Manifest catalog."""
    templates_dir = Path(templates_dir)
    catalog: Dict[str, Manifest] = {}
    for manifest_path in sorted(templates_dir.glob("*/manifest.json")):
        manifest = Manifest.model_validate(json.loads(manifest_path.read_text(encoding="utf-8")))
        catalog[manifest.id] = manifest
    return catalog


def _check_props(props, manifest: Manifest, where: str) -> None:
    try:
        jsonschema.validate(instance=props or {}, schema=manifest.inputSchema)
    except jsonschema.ValidationError as e:
        raise ValueError(f"{where}: props invalid for template {manifest.id!r}: {e.message}") from e


def _require(template_id, catalog, where: str) -> Manifest:
    if not template_id:
        raise ValueError(f"{where}: no template set (a template id is required)")
    manifest = catalog.get(template_id)
    if manifest is None:
        raise ValueError(f"{where}: unknown template id {template_id!r} (not in catalog)")
    return manifest


def validate_spec(spec: Spec, catalog: Dict[str, Manifest]) -> None:
    """Raise ValueError on the first slot/kind or prop violation."""
    for scene in spec.scenes:
        where = f"scene {scene.id!r}"
        manifest = _require(scene.template, catalog, where)
        if manifest.kind not in SCENE_KINDS:
            raise ValueError(
                f"{where}: template {manifest.id!r} has kind {manifest.kind!r}, "
                f"which cannot fill a scene slot (expected one of {sorted(SCENE_KINDS)})"
            )
        _check_props(scene.templateProps, manifest, where)

        if scene.transition is not None:
            twhere = f"{where} transition"
            tmanifest = _require(scene.transition.template, catalog, twhere)
            if tmanifest.kind != "transition":
                raise ValueError(
                    f"{twhere}: template {tmanifest.id!r} has kind {tmanifest.kind!r}, "
                    f"but a transition slot requires kind 'transition'"
                )
            _check_props(scene.transition.props, tmanifest, twhere)

    for layer in spec.layers:
        where = f"layer {layer.id!r}"
        manifest = _require(layer.template, catalog, where)
        if manifest.kind != "overlay":
            raise ValueError(
                f"{where}: template {manifest.id!r} has kind {manifest.kind!r}, "
                f"but a layer slot requires kind 'overlay'"
            )
        _check_props(layer.props, manifest, where)
