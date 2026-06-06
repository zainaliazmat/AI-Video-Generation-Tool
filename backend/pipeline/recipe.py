"""Step 6.2 — the recipe / director: deterministic composition.

`plan()` maps a `BeatsScript` (what the model said) to a `ScenePlan` (which
template renders each narration span). It is the "how to compose" brain, and it
is **deliberately deterministic, not LLM-chosen**, for reliability at volume:

  * The model never names a `kind`. The recipe derives slot/template from beat
    POSITION + DATA SHAPE only (constraint #1).
  * Positional hook/outro: beat 0 → hook, last → outro, every beat narrated
    (locked #1). N=1 → a single hook; N=2 → hook + outro.
  * stat-wins: a MIDDLE beat whose `data` carries both `value` and `label`
    becomes a `stat` (no footage); everything else middle is a footage `scene`
    (locked #4). Position wins over data on the first/last beat.
  * Transitions are SELECTIVE by default — emphasis only, into a `stat` / into
    the `outro` (locked #3); `every` and `none` are knobs. The plan emits
    transition INTENT (template + props) only; `assemble` resolves the duration
    Tᵢ against the audio-derived dᵢ.

Pure: no I/O, no audio, no frames. `assemble` (6.4) binds timing + footage.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from pipeline.content import Beat, BeatsScript
from schema import Theme

# Recipe knobs.
TransitionPolicy = str  # "selective" (default) | "every" | "none"
_TRANSITION_POLICIES = {"selective", "every", "none"}
# Roles that a SELECTIVE policy treats as emphasis — the scene BEFORE one of
# these gets the transition.
_EMPHASIS_ROLES = {"stat", "outro"}

# Default slot → template-id mapping (current templates use id == slot). 6.4
# builds a real catalog from the manifests; tests/override pass their own.
_DEFAULT_TEMPLATES = {"hook": "hook", "scene": "scene", "stat": "stat", "outro": "outro"}


@dataclass
class TransitionIntent:
    """An OUTGOING transition into the next scene — template + props only. The
    duration Tᵢ is resolved later (assemble) against dᵢ; here we don't know it."""

    template: str            # transition-kind template id (from theme.transition)
    props: Dict = field(default_factory=dict)


@dataclass
class PlannedScene:
    role: str                              # slot: hook | scene | stat | outro
    template: str                          # resolved template id for that slot
    props: Dict                            # templateProps (media filled at assemble for scenes)
    needs_footage: bool                    # True only for `scene`
    query: Optional[str] = None            # footage search query when needs_footage
    transition: Optional[TransitionIntent] = None  # outgoing, into the next scene


@dataclass
class ScenePlan:
    title: str
    scenes: List[PlannedScene]

    @property
    def footage_scenes(self) -> List[PlannedScene]:
        return [s for s in self.scenes if s.needs_footage]


def _is_stat(beat: Beat) -> bool:
    """value-shaped data → stat. Requires BOTH value and label (the stat
    template needs both); a bare number falls back to a footage scene."""
    d = beat.data
    return bool(isinstance(d, dict) and d.get("value") and d.get("label"))


def _stat_props(beat: Beat) -> Dict:
    d = beat.data or {}
    props = {"value": d["value"], "label": d["label"]}
    if d.get("icon"):
        props["icon"] = d["icon"]
    return props


def _derive_role(index: int, n: int, beat: Beat) -> str:
    """Position wins over data: first → hook, last → outro; middle → stat|scene."""
    if index == 0:
        return "hook"
    if index == n - 1:
        return "outro"
    return "stat" if _is_stat(beat) else "scene"


def plan(
    script: BeatsScript,
    *,
    theme: Theme,
    templates: Optional[Dict[str, str]] = None,
    recipe: str = "fact-list",
    transition_policy: TransitionPolicy = "selective",
) -> ScenePlan:
    if recipe != "fact-list":
        raise ValueError(f"Unknown recipe {recipe!r} (only 'fact-list' this phase)")
    if transition_policy not in _TRANSITION_POLICIES:
        raise ValueError(
            f"Unknown transition_policy {transition_policy!r} (expected one of {sorted(_TRANSITION_POLICIES)})"
        )
    catalog = {**_DEFAULT_TEMPLATES, **(templates or {})}
    beats = script.beats
    n = len(beats)

    scenes: List[PlannedScene] = []
    for i, beat in enumerate(beats):
        role = _derive_role(i, n, beat)
        if role == "hook":
            props: Dict = {"title": script.title, "subtitle": beat.text}
            scenes.append(PlannedScene(role, catalog["hook"], props, needs_footage=False))
        elif role == "outro":
            scenes.append(PlannedScene(role, catalog["outro"], {"title": beat.text}, needs_footage=False))
        elif role == "stat":
            scenes.append(PlannedScene(role, catalog["stat"], _stat_props(beat), needs_footage=False))
        else:  # scene
            scenes.append(
                PlannedScene(role, catalog["scene"], {}, needs_footage=True, query=(beat.keywords or beat.text))
            )

    _assign_transitions(scenes, theme.transition, transition_policy)
    return ScenePlan(title=script.title, scenes=scenes)


def _assign_transitions(scenes: List[PlannedScene], transition_template: str, policy: TransitionPolicy) -> None:
    """Set the OUTGOING transition on each scene per policy. The final scene
    never gets one (no scene follows it).

    SELECTIVE fires into an emphasis target (stat / outro) ONLY from a footage
    `scene` source. A crossfade between two centered text cards (hook→stat,
    stat→outro, stat→stat) double-exposes the text — verified on the render — so
    those boundaries hard-cut. A footage source fades cleanly (the held footage
    carries no typographic structure). `every` is literal (all boundaries)."""
    if policy == "none":
        return
    for i in range(len(scenes) - 1):
        cur, nxt = scenes[i], scenes[i + 1]
        fire = policy == "every" or (
            policy == "selective" and nxt.role in _EMPHASIS_ROLES and cur.role == "scene"
        )
        if fire:
            cur.transition = TransitionIntent(template=transition_template, props={})
