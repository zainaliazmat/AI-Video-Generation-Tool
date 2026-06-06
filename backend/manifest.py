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

from typing import Literal

from pydantic import BaseModel

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
    min: int
    max: int


class Manifest(BaseModel):
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
