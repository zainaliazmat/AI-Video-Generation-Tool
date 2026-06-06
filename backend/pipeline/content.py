"""The structured CONTENT contract DeepSeek returns (step 6.1).

`BeatsScript` is the model-output schema, validated by Pydantic so the guarantee
is provider-portable (LLM_PROVIDER is pluggable — we do NOT rely on a provider's
own json_schema mode). It is DISTINCT from a template's inputSchema: the model
emits narration `text` + optional structured `data` only and NEVER names a
template `kind` — the recipe (6.2) derives slot/template from position + data.
"""
from __future__ import annotations

import json
from typing import Dict, List, Optional

from pydantic import BaseModel, field_validator


class Beat(BaseModel):
    """One narration beat: a spoken sentence plus optional structured payload."""

    text: str
    data: Optional[Dict] = None       # e.g. {"value": "90%", "label": "..."} → recipe may pick `stat`
    keywords: Optional[str] = None    # footage search hint; falls back to `text`
    source: Optional[str] = None      # URL backing this beat's fact (grounding); set/checked in script.py

    @field_validator("text", "keywords")
    @classmethod
    def _strip(cls, v):
        if v is None:
            return None
        v = v.strip()
        return v

    @field_validator("text")
    @classmethod
    def _text_non_empty(cls, v):
        if not v:
            raise ValueError("beat.text must be non-empty")
        return v


class Source(BaseModel):
    """A retrieved source the script is grounded in (one Tavily result)."""

    url: str
    title: Optional[str] = None


class HookCandidate(BaseModel):
    """One candidate opening hook (Phase 3.2): a punchy line grounded in a fact.
    The model generates several across patterns; a deterministic selector picks the
    strongest as beat 0 and the rest are retained (with scores) for inspection."""

    text: str
    pattern: str = ""                 # curiosity gap | surprising stat | bold claim | direct question
    source: Optional[str] = None      # URL backing the hook's fact (grounding)
    score: Optional[float] = None     # filled by the selector
    chosen: bool = False              # True on the selected winner

    @field_validator("text")
    @classmethod
    def _hook_text_non_empty(cls, v):
        v = (v or "").strip()
        if not v:
            raise ValueError("hook candidate text must be non-empty")
        return v


class BeatsScript(BaseModel):
    title: str
    beats: List[Beat]
    sources: Optional[List[Source]] = None                 # retrieved evidence set (grounding); set in script.py
    hook_candidates: Optional[List[HookCandidate]] = None  # ranked opening hooks (3.2); set in script.py

    @field_validator("title")
    @classmethod
    def _title_non_empty(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("title must be non-empty")
        return v

    @field_validator("beats")
    @classmethod
    def _beats_non_empty(cls, v):
        if not v:
            raise ValueError("beats must be a non-empty list")
        return v


def parse_beats_response(content: str) -> BeatsScript:
    """Parse + validate a raw LLM reply into a BeatsScript.

    Raises ValueError on bad JSON or schema violation (Pydantic's ValidationError
    is a subclass of ValueError), so callers catch one type for the retry path.
    """
    data = json.loads(content)  # JSONDecodeError is a ValueError subclass
    return BeatsScript.model_validate(data)
