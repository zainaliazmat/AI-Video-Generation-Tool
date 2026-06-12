"""Studio v3 gate topology (PRD §4): four human gates over the stage DAG.

A gate's SEGMENT is the list of stages that run to REACH it; approving a gate
runs the NEXT gate's segment and halts there. The mapping is total: every
editable stage belongs to exactly one gate (the gate that reopens on §4.1
edit intent). The engine stays gate-blind; only gatekeeper.py reads this.
"""
from __future__ import annotations

GATE_ORDER = ["script", "voice", "scenes", "assemble"]

# stages that run to REACH each gate (PRD §4 flow, amended per ruling 1A:
# assemble runs BEFORE the scenes gate so the per-scene player has a spec)
GATE_SEGMENTS = {
    "script": ["script"],                                  # Generate → script gate
    "voice": [],                                           # previews are on-demand (M3)
    "scenes": ["voice", "timing", "footage", "assemble"],  # heavy interstitial + compose
    "assemble": [],                                        # terminal: theme/chat/render
}

# which gate REOPENS when a stage is edited (§4.1)
GATE_FOR_STAGE = {
    "script": "script",
    "voice": "voice",
    "timing": "scenes",
    "footage": "scenes",
    "assemble": "assemble",
}

# DESIGN NOTE (ruling OV-10): gate state is STORED, not derived from stage
# staleness. Derivation cannot attribute a reopen: a footage edit marks the
# assemble STAGE stale, and assemble is downstream of script too — so the
# script gate would wrongly derive "needs re-approval" when only the scenes
# gate reopened. The stored reopened-bit (state=awaiting_approval on an
# approved_at-bearing row) is exactly the information stage staleness can't
# carry. Do not "simplify" this to a derived view.

# the assemble gate is terminal — its tinted action is Render, not Approve
APPROVABLE = ["script", "voice", "scenes"]


def next_gate(gate: str):
    i = GATE_ORDER.index(gate)
    return GATE_ORDER[i + 1] if i + 1 < len(GATE_ORDER) else None


def downstream_gates(gate: str) -> list:
    return GATE_ORDER[GATE_ORDER.index(gate) + 1:]
