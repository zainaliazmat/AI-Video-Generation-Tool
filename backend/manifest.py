"""The template manifest contract.

A template plugin is a self-contained folder whose `manifest.json` is the
language-neutral contract read by BOTH sides:
  - the Python backend, to know the catalog, validate specs, and inform the
    script/recipe steps, and
  - the renderer, to build its component registry.

`inputSchema` is JSON Schema, generated from each template's zod schema (the
single source of truth authored in TS). This Pydantic model validates the
manifest's *envelope*; per-template prop validation against `inputSchema`
happens later (recipe / spec-validation step).

Keep the `TemplateKind` slot set identical to the TS side
(`templates/sdk.ts`) — it is part of the shared contract.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

# Template slots. A spec references templates by the slot appropriate to each
# position (a `transition` cannot go where a `scene` goes); validation enforces
# this in a later step. MUST match TemplateKind in templates/sdk.ts.
TemplateKind = Literal[
    "hook",
    "scene",
    "stat",
    "lower-third",
    "transition",
    "overlay",
    "outro",
]


class DurationFrames(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min: int
    max: int


class Manifest(BaseModel):
    # The envelope is strict (§15.13) — an unknown key is a stale or malformed
    # package, never something to ignore. MUST stay in lockstep with
    # templates/sdk.ts and the generated templates/manifest.schema.json.
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    version: str
    author: str
    apiVersion: str
    kind: TemplateKind
    inputSchema: dict       # JSON Schema for this template's props (from zod)
    sampleProps: dict       # example props used to auto-render the gallery preview
    durationFrames: DurationFrames
    # A full-text template (hook/stat/outro hero cards) renders its own on-screen
    # text, so the global karaoke caption is SUPPRESSED over its scene span by the
    # renderer (else the same words show twice). Footage/overlay templates leave it
    # False and keep captions. Renderer-side policy; the backend just carries it.
    rendersOwnText: bool = False
    # Content capability this template CONSUMES — the routing signal the recipe
    # reads generically (the generalization of rendersOwnText). A beat whose content
    # shape matches is routed to whichever template DECLARES the capability, with no
    # hardcoded id. None on position/data-routed templates. Today: "enumeration".
    # MUST stay in lockstep with templates/sdk.ts.
    consumes: Optional[str] = None
    # --- v1.1 additive fields (§4.2) — all optional at the envelope level.
    # license is required for non-core authors by the IMPERATIVE pass (§15.13),
    # which lives installer-side (M2), not in this schema validator.
    description: Optional[str] = None     # catalog/search text
    tags: Optional[list[str]] = None      # search facets
    license: Optional[str] = None         # SPDX id
    homepage: Optional[str] = None        # author link in the drawer
    assets: Optional[list[str]] = None    # declared relative paths under assets/
