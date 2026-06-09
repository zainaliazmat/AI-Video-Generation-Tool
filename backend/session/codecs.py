"""Per-stage output <-> JSON-able dict codecs. Stage outputs are persisted in
SQLite (store.stages.output_json) and re-loaded to feed downstream stages, so each
must round-trip exactly. Pydantic models use model_dump/model_validate; the
dataclass contracts (LineOffset/WordTiming/Clip) and the recipe ScenePlan get
explicit (de)serializers."""
from __future__ import annotations

from dataclasses import asdict

from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import BeatsScript
from pipeline.recipe import ScenePlan, PlannedScene, TransitionIntent
from schema import Spec


def offsets_to_json(offsets):
    return [asdict(o) for o in offsets]


def offsets_from_json(data):
    return [LineOffset(**o) for o in data]


def words_to_json(words):
    return [asdict(w) for w in words]


def words_from_json(data):
    return [WordTiming(**w) for w in data]


def clips_to_json(clips):
    return [asdict(c) for c in clips]


def clips_from_json(data):
    return [Clip(**c) for c in data]


def _plan_to_json(plan: ScenePlan):
    # Field-completeness contract: serialize ALL PlannedScene fields
    # (role, template, props, needs_footage, query, transition) and the
    # TransitionIntent two-field struct (template, props). A dropped field would
    # round-trip to a default and silently corrupt the re-derived spec — if
    # recipe.py grows a PlannedScene/TransitionIntent field, add it here + below.
    return {
        "title": plan.title,
        "scenes": [
            {
                "role": s.role, "template": s.template, "props": s.props,
                "needs_footage": s.needs_footage, "query": s.query,
                "transition": ({"template": s.transition.template, "props": s.transition.props}
                               if s.transition else None),
            }
            for s in plan.scenes
        ],
    }


def _plan_from_json(d) -> ScenePlan:
    scenes = [
        PlannedScene(
            role=s["role"], template=s["template"], props=s["props"],
            needs_footage=s["needs_footage"], query=s.get("query"),
            transition=(TransitionIntent(template=s["transition"]["template"],
                                         props=s["transition"]["props"])
                        if s.get("transition") else None),
        )
        for s in d["scenes"]
    ]
    return ScenePlan(title=d["title"], scenes=scenes)


def script_bundle_to_json(bundle):
    return {"script": bundle["script"].model_dump(), "plan": _plan_to_json(bundle["plan"])}


def script_bundle_from_json(d):
    return {"script": BeatsScript.model_validate(d["script"]), "plan": _plan_from_json(d["plan"])}


def footage_to_json(bundle):
    """bundle = {"clips": [Clip], "candidates": {scene_index: [cand dict]}}."""
    return {"clips": clips_to_json(bundle["clips"]),
            "candidates": {str(k): v for k, v in bundle.get("candidates", {}).items()}}


def footage_from_json(d):
    return {"clips": clips_from_json(d["clips"]),
            "candidates": {int(k): v for k, v in d.get("candidates", {}).items()}}


def spec_to_json(spec: Spec):
    return spec.model_dump(by_alias=True)


def spec_from_json(d) -> Spec:
    return Spec.model_validate(d)
