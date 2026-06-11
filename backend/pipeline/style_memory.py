"""Studio v2 — preference / style memory (honestly named).

DeepSeek is hosted and STATELESS; it does not learn from chats. This module is the
honest substitute: the user's accepted edits and rejected regenerations are saved
as few-shot examples + prompt guidance lines, then composed into the script
generation prompt as an ADDITIVE block (never rewriting the frozen SYSTEM_PROMPT or
the frozen footage query rule). Local-first JSON at the repo/user level.

Caps (PRD §6.1): ≤ 12 few-shot example pairs, ≤ 8 guidance lines, FIFO with
pinning — a pinned entry is never evicted by FIFO and is not counted against the
cap when trimming (it sits above the FIFO window). A small manager (list/pin/
delete) is exposed so pollution is curable.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

MAX_EXAMPLES = 12
MAX_GUIDANCE = 8

_EMPTY = {"examples": [], "guidance": []}


def load(path) -> Dict:
    """Load style memory, returning a fresh empty doc if the file is absent or
    unreadable (never raise on a missing/corrupt memory — it must not block a run)."""
    p = Path(path)
    if not p.exists():
        return json.loads(json.dumps(_EMPTY))
    try:
        data = json.loads(p.read_text())
    except (ValueError, OSError):
        return json.loads(json.dumps(_EMPTY))
    data.setdefault("examples", [])
    data.setdefault("guidance", [])
    return data


def save(path, mem: Dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(mem, indent=2))


def _trim(items: List[Dict], cap: int, *, pin_key="pinned") -> List[Dict]:
    """FIFO trim to `cap`, never evicting pinned entries. Pinned entries are kept in
    place; the oldest UNPINNED entries are dropped until len ≤ cap."""
    if len(items) <= cap:
        return items
    pinned = [x for x in items if x.get(pin_key)]
    unpinned = [x for x in items if not x.get(pin_key)]
    keep_unpinned = max(0, cap - len(pinned))
    # drop oldest unpinned (front of list is oldest)
    unpinned = unpinned[len(unpinned) - keep_unpinned:] if keep_unpinned else []
    # preserve original ordering
    kept = [x for x in items if x.get(pin_key) or x in unpinned]
    return kept


def record_edit(mem: Dict, *, before: str, after: str) -> Dict:
    """Record an accepted human edit (before → after) as a few-shot example."""
    before = (before or "").strip()
    after = (after or "").strip()
    if not after or before == after:
        return mem
    mem.setdefault("examples", [])
    mem["examples"].append({"before": before, "after": after, "pinned": False})
    mem["examples"] = _trim(mem["examples"], MAX_EXAMPLES)
    return mem


def record_guidance(mem: Dict, line: str) -> Dict:
    """Record a stable preference / rejection feedback as a guidance line."""
    line = (line or "").strip()
    if not line:
        return mem
    mem.setdefault("guidance", [])
    if any(g["text"] == line for g in mem["guidance"]):
        return mem  # dedup
    mem["guidance"].append({"text": line, "pinned": False})
    mem["guidance"] = _trim(mem["guidance"], MAX_GUIDANCE)
    return mem


def pin(mem: Dict, *, kind: str, index: int, value: bool = True) -> Dict:
    items = mem.get("examples" if kind == "example" else "guidance", [])
    if 0 <= index < len(items):
        items[index]["pinned"] = bool(value)
    return mem


def delete(mem: Dict, *, kind: str, index: int) -> Dict:
    items = mem.get("examples" if kind == "example" else "guidance", [])
    if 0 <= index < len(items):
        items.pop(index)
    return mem


def to_prompt_block(mem: Dict) -> str:
    """Compose an ADDITIVE few-shot + guidance block for the script generation prompt.
    Returns '' when memory is empty (so the prompt is byte-identical to a no-memory
    run). This block is appended to the USER prompt, never the frozen SYSTEM_PROMPT."""
    examples = mem.get("examples", [])
    guidance = mem.get("guidance", [])
    if not examples and not guidance:
        return ""
    lines: List[str] = ["", "STYLE MEMORY (preferences learned from this operator's past edits;",
                        "these are few-shot guides, not rules that override grounding):"]
    if guidance:
        lines.append("Guidance:")
        for g in guidance:
            lines.append(f"- {g['text']}")
    if examples:
        lines.append("Preferred phrasings (before -> after):")
        for e in examples:
            lines.append(f"- {e['before']!r} -> {e['after']!r}")
    return "\n".join(lines)
