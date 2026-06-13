"""Studio v2 Assemble gate — chat-to-spec.json-patch (PRD §6.5).

Remotion renders from spec.json; frames are NEVER edited. The Assemble gate takes
plain English ("captions bigger / dark ember theme / swap scene 3's clip") and emits
a structured, whitelist-validated patch against the spec, then re-renders.

THE HARD GUARDRAIL (PRD §6.5). Patches MAY touch:
  - theme.*                         (palette, fonts, caption size/weight/color, transition style)
  - scenes[i].template              (the slot template)
  - scenes[i].templateProps[...]    (incl. the clip reference)
  - scenes[i].media[...]            (footage clip swap)
  - scenes[i].transition[...]       (per-scene transition selection)
Patches may NEVER touch: beat/scene COUNT, captions, durations, startFrame, scene id,
audio (voiceover/music timing), meta. Those are rejected structurally — both by the
path whitelist AND a post-apply invariant check ("audio math untouched"), so a clever
path can't slip a timing change through.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

from schema import Spec
from pipeline.validate import SCENE_KINDS

ALLOWED_SCENE_FIELDS = {"template", "templateProps", "media", "transition"}
FORBIDDEN_SCENE_FIELDS = {"id", "startFrame", "durationInFrames"}


class PatchError(ValueError):
    """A patch op violated the whitelist or could not be applied. The message is
    surfaced to the operator as the friendly 'what can move' chat reply."""


def _parts(path: str) -> List[str]:
    return [p for p in path.strip("/").split("/") if p != ""]


def check_path(path: str) -> None:
    """Raise PatchError unless `path` targets a whitelisted, mutable location."""
    parts = _parts(path)
    if not parts:
        raise PatchError("empty patch path")
    head = parts[0]
    if head == "theme":
        return  # any theme.* is fair game
    if head == "scenes":
        if len(parts) < 3:
            raise PatchError(
                "a patch may not replace a whole scene or the scenes array "
                "(that would change scene count / timing — use the Script gate)")
        try:
            idx = int(parts[1])
        except ValueError:
            raise PatchError(f"scene index must be an integer, got {parts[1]!r}")
        if idx < 0:
            # a negative index would silently wrap (Python list[-1]) and patch the
            # wrong scene — reject so "scene 0" can never become "the last scene".
            raise PatchError(f"scene index must be non-negative, got {idx}")
        field = parts[2]
        if field in FORBIDDEN_SCENE_FIELDS:
            raise PatchError(
                f"scenes[i].{field} is timing/identity and cannot move — "
                "that's the Script/Timing gate's job")
        if field not in ALLOWED_SCENE_FIELDS:
            raise PatchError(f"scenes[i].{field} is not a patchable field")
        return
    raise PatchError(
        f"path {path!r} is outside the patch whitelist "
        "(only theme.* and scenes[i].template/templateProps/media/transition can move; "
        "captions, audio, durations and meta are locked)")


def validate_patch(patch) -> Tuple[bool, str]:
    """Static validation: shape + op kind + path whitelist. Returns (ok, error)."""
    if not isinstance(patch, list) or not patch:
        return False, "patch must be a non-empty list of ops"
    for op in patch:
        if not isinstance(op, dict) or "op" not in op or "path" not in op:
            return False, "each op needs 'op' and 'path'"
        if op["op"] != "replace":
            return False, f"only 'replace' ops are allowed (got {op['op']!r})"
        if "value" not in op:
            return False, "a replace op needs a 'value'"
        try:
            check_path(op["path"])
        except PatchError as e:
            return False, str(e)
    return True, ""


def _scene_template_ids(catalog) -> List[str]:
    return sorted(mid for mid, m in catalog.items() if m.kind in SCENE_KINDS)


def _transition_template_ids(catalog) -> List[str]:
    return sorted(mid for mid, m in catalog.items() if m.kind == "transition")


def _check_template_id(template_id, catalog, *, slot: str, where: str) -> str:
    """Return an error string if `template_id` is not a catalog id valid for `slot`
    ('scene' or 'transition'), else "". Mirrors render-time validate_spec's rules so
    a bad id is caught at propose time, not deferred to apply/render."""
    if not isinstance(template_id, str) or not template_id:
        return f"{where}: template id must be a non-empty string"
    manifest = catalog.get(template_id)
    if manifest is None:
        valid = _scene_template_ids(catalog) if slot == "scene" else _transition_template_ids(catalog)
        return (f"{where}: unknown template id {template_id!r} (not in catalog) — "
                f"valid {slot} templates are {valid}")
    if slot == "scene" and manifest.kind not in SCENE_KINDS:
        return (f"{where}: template {template_id!r} has kind {manifest.kind!r}, "
                f"which cannot fill a scene slot — valid scene templates are "
                f"{_scene_template_ids(catalog)}")
    if slot == "transition" and manifest.kind != "transition":
        return (f"{where}: template {template_id!r} has kind {manifest.kind!r}, "
                f"but a transition slot requires a transition template — valid ones are "
                f"{_transition_template_ids(catalog)}")
    return ""


def validate_template_ops(patch, catalog) -> Tuple[bool, str]:
    """Catalog membership for any template-id the patch sets. The path whitelist
    (`validate_patch`) proves WHERE an op may write; this proves the template VALUE
    it writes is a real, slot-appropriate catalog id. Without it the chat 'valid'
    badge lies and a hallucinated id (e.g. 'clip') only fails at apply/render."""
    for op in patch:
        if not isinstance(op, dict) or "value" not in op:
            continue  # shape errors are validate_patch's job
        parts = _parts(op.get("path", ""))
        value = op["value"]
        # /scenes/{i}/template — the scene slot
        if len(parts) == 3 and parts[0] == "scenes" and parts[2] == "template":
            err = _check_template_id(value, catalog, slot="scene",
                                     where=f"scenes[{parts[1]}].template")
            if err:
                return False, err
        # /scenes/{i}/transition/template — the transition slot (leaf form)
        elif len(parts) == 4 and parts[0] == "scenes" and parts[2] == "transition" \
                and parts[3] == "template":
            err = _check_template_id(value, catalog, slot="transition",
                                     where=f"scenes[{parts[1]}].transition.template")
            if err:
                return False, err
        # /scenes/{i}/transition — whole-object replace carrying a template id
        elif len(parts) == 3 and parts[0] == "scenes" and parts[2] == "transition" \
                and isinstance(value, dict) and "template" in value:
            err = _check_template_id(value["template"], catalog, slot="transition",
                                     where=f"scenes[{parts[1]}].transition.template")
            if err:
                return False, err
    return True, ""


def _set_pointer(data, path: str, value) -> None:
    parts = _parts(path)
    cur = data
    for p in parts[:-1]:
        if isinstance(cur, list):
            cur = cur[int(p)]
        elif isinstance(cur, dict):
            if p not in cur or cur[p] is None:
                raise PatchError(
                    f"cannot set {path!r}: '{p}' does not exist on the target "
                    "(replace the whole object instead of a missing sub-field)")
            cur = cur[p]
        else:
            raise PatchError(f"cannot descend into {p!r} for path {path!r}")
    last = parts[-1]
    if isinstance(cur, list):
        cur[int(last)] = value
    elif isinstance(cur, dict):
        cur[last] = value           # may set a new templateProps/transition sub-key
    else:
        raise PatchError(f"cannot set {last!r} on a non-container for {path!r}")


def _invariants(data: Dict) -> Dict:
    """The fields that must be byte-identical before and after a patch."""
    return {
        "scene_count": len(data.get("scenes", [])),
        "scene_timing": [(s.get("id"), s.get("startFrame"), s.get("durationInFrames"))
                         for s in data.get("scenes", [])],
        "captions": data.get("captions"),
        "audio": data.get("audio"),
        "meta": data.get("meta"),
    }


def apply_patch(spec: Spec, patch) -> Spec:
    """Validate + apply a patch, returning a NEW validated Spec. Raises PatchError on
    a whitelist violation, an unapplyable op, OR a post-apply invariant breach (the
    belt-and-suspenders 'audio math untouched' guarantee)."""
    ok, err = validate_patch(patch)
    if not ok:
        raise PatchError(err)
    data = spec.model_dump(by_alias=True)
    before = _invariants(data)
    for op in patch:
        _set_pointer(data, op["path"], op["value"])
    after = _invariants(data)
    if before != after:
        raise PatchError(
            "patch would change locked timing/captions/audio — rejected "
            "(spec.json's audio math is immutable from the Assemble gate)")
    try:
        return Spec.model_validate(data)
    except Exception as e:  # pydantic ValidationError etc.
        raise PatchError(f"patched spec failed schema validation: {e}")


def diff_lines(spec: Spec, patch) -> List[Dict]:
    """Human-readable diff for the patch card: [{path, before, after}]."""
    data = spec.model_dump(by_alias=True)
    out = []
    for op in patch:
        try:
            cur = data
            for p in _parts(op["path"])[:-1]:
                cur = cur[int(p)] if isinstance(cur, list) else cur[p]
            last = _parts(op["path"])[-1]
            before = cur[int(last)] if isinstance(cur, list) else cur.get(last)
        except (KeyError, IndexError, ValueError, TypeError):
            before = None
        out.append({"path": op["path"].strip("/").replace("/", "."),
                    "before": before, "after": op["value"]})
    return out


# ----------------- chat -> patch (LLM) -----------------

_CHAT_SYSTEM = (
    "You translate a user's plain-English request into a JSON patch for a video's "
    "spec.json. Output ONLY a JSON object: {\"ops\": [{\"op\":\"replace\",\"path\":\"/...\","
    "\"value\": ...}], \"reply\": \"one short sentence\"}.\n"
    "You may ONLY change: /theme/* (palette colors, fonts, caption fontFamily/"
    "fontWeight/color/highlightColor/positionY/size — size is px, e.g. 56; "
    "'bigger captions' means a larger /theme/caption/size — transition style) "
    "and per scene "
    "/scenes/{i}/template, /scenes/{i}/templateProps/*, /scenes/{i}/media/*, "
    "/scenes/{i}/transition/*.\n"
    "You may NEVER change captions text, durations, startFrame, scene count, audio, "
    "or meta — if asked, return an empty ops list and explain in 'reply' that script "
    "changes belong to the Script gate.\n"
    "Use JSON Pointer paths. Numbers/strings/objects as values."
)


def build_chat_messages(message: str, spec: Spec, catalog=None) -> list:
    """The messages for the chat->patch LLM call (a compact spec summary + request).

    When `catalog` is given, the system prompt is grounded with the exact valid
    template ids per slot, so the model cannot invent a non-existent id (the 'clip'
    hallucination that only failed at apply time)."""
    data = spec.model_dump(by_alias=True)
    summary = {
        "theme": data.get("theme"),
        "scenes": [{"i": i, "template": s.get("template"),
                    "hasMedia": s.get("media") is not None,
                    "transition": (s.get("transition") or {}).get("template")}
                   for i, s in enumerate(data.get("scenes", []))],
    }
    system = _CHAT_SYSTEM
    if catalog:
        system = (
            f"{_CHAT_SYSTEM}\n"
            f"Valid scene template ids (for /scenes/{{i}}/template) — use ONLY these, "
            f"never invent one: {_scene_template_ids(catalog)}.\n"
            f"Valid transition template ids (for a transition's 'template'): "
            f"{_transition_template_ids(catalog)}.\n"
            f"To put video footage on a scene, do NOT change its template — set "
            f"/scenes/{{i}}/templateProps/backgroundClip (hero/stat) or "
            f"/scenes/{{i}}/media (footage scenes) instead."
        )
    import json
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Current spec summary:\n{json.dumps(summary)}\n\n"
                                     f"Request: {message}\n\nReturn the JSON object."},
    ]


def parse_chat_response(content: str) -> Tuple[List[Dict], str]:
    """Parse the LLM reply into (ops, reply). Raises PatchError on bad JSON."""
    import json
    try:
        data = json.loads(content)
    except ValueError as e:
        raise PatchError(f"could not parse a patch from the model output: {e}")
    ops = data.get("ops", [])
    reply = data.get("reply", "")
    return ops, reply
