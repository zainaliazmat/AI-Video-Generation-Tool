"""Phase 4 — footage relevance: the cross-stage paths + the timing invariant.

The tests here pass in isolation but break E2E if a stage handoff is wrong — plus
the guard that footage SELECTION never feeds back into span/timing:

  * demote -> footage query: a stat whose on-screen NUMBER fails verification is
    demoted (data dropped) and the recipe re-renders it as a footage scene. The
    query must stay filmable; the missing-keyword fallback is the TITLE, never the
    8-18 word narration sentence (a poor stock query) or a crash.
  * broaden-on-empty: a specific query returning zero portrait clips retries the
    broader title query before failing the whole render (RuntimeError).
  * invariant: clip length only toggles media.loop; it can never move scene timing.
"""
import pytest

from pipeline.content import Beat, BeatsScript
from pipeline.contracts import Clip, FootageRequest, LineOffset
from pipeline.footage import fetch_footage
from pipeline.recipe import plan
from pipeline.assemble import build_spec
from pipeline import verify as verify_stage
from pipeline.retrieval import RetrievedContext, RetrievedSnippet
from schema import Theme


def _video(link, duration):
    return {"duration": duration, "video_files": [
        {"link": link, "width": 1080, "height": 1920, "file_type": "video/mp4"}]}


def _ctx(*snips):
    return RetrievedContext(
        query="topic",
        snippets=[RetrievedSnippet(title=t, url=u, content=c, score=1.0) for (u, t, c) in snips],
    )


def _supportive_vfn(items):
    """Keep every claim, but mark the on-screen NUMBER unsupported -> demote stats."""
    return [
        {"index": it["index"], "claim_supported": True,
         "number_supported": (False if it["value"] else None), "source": "https://a"}
        for it in items
    ]


# ── cross-stage: demote -> filmable footage query ──────────────────────────

def test_demoted_stat_without_keywords_uses_title_not_sentence():
    script = BeatsScript(title="Deep Ocean", beats=[
        Beat(text="hook line", source="https://a"),
        Beat(text="the pressure down there exceeds a thousand atmospheres of force",
             data={"value": "1100 atm", "label": "crushing pressure"}, source="https://a"),
        Beat(text="follow for more"),
    ])
    verify_stage.verify_script(script, _ctx(("https://a", "A", "snip")), verify_fn=_supportive_vfn)
    assert script.beats[1].data is None                 # number unsupported -> demoted

    p = plan(script, theme=Theme())
    assert p.scenes[1].role == "scene"                  # demoted stat -> footage scene
    assert p.scenes[1].query == "Deep Ocean"            # TITLE fallback, NOT the sentence


def test_demoted_stat_with_keywords_uses_its_keywords_as_query():
    # The PRIMARY demote path: "keywords on every beat" must hold UNDER demotion. A
    # stat that loses its data in verify re-renders as a footage scene and uses its
    # own KEYWORDS (the filmable hint) — not the title fallback, not a crash.
    script = BeatsScript(title="Deep Ocean", beats=[
        Beat(text="hook line", source="https://a"),
        Beat(text="the trench plunges to eleven kilometers below the surface",
             data={"value": "11 km", "label": "max depth"}, keywords="ocean trench", source="https://a"),
        Beat(text="follow for more"),
    ])
    verify_stage.verify_script(script, _ctx(("https://a", "A", "snip")), verify_fn=_supportive_vfn)
    assert script.beats[1].data is None                  # number unsupported -> demoted
    assert script.beats[1].keywords == "ocean trench"    # keywords survive demotion

    p = plan(script, theme=Theme())
    assert p.scenes[1].role == "scene"                   # demoted stat -> footage scene
    assert p.scenes[1].query == "ocean trench"           # its KEYWORDS, not the title fallback


# ── cross-stage: broaden-on-empty ──────────────────────────────────────────

def test_fetch_broadens_to_title_when_specific_query_empty(tmp_path):
    searched = []

    def fake_search(query, key):
        searched.append(query)
        return {"videos": []} if query == "bioluminescent anglerfish abyss" else {"videos": [_video("hit", 6)]}

    def fake_download(url, dest):
        dest.write_bytes(b"v")

    reqs = [FootageRequest(index=2, query="bioluminescent anglerfish abyss",
                           min_frames=60, broad_query="Deep Ocean")]
    clips = fetch_footage(reqs, tmp_path, fps=30, key="K", search=fake_search, downloader=fake_download)

    assert searched == ["bioluminescent anglerfish abyss", "Deep Ocean"]   # broadened after the whiff
    assert clips[0].duration_frames == 180
    assert clips[0].path.endswith(".mp4")


def test_fetch_raises_when_specific_and_broad_both_empty(tmp_path):
    def fake_search(query, key):
        return {"videos": []}

    def fake_download(url, dest):
        dest.write_bytes(b"v")

    reqs = [FootageRequest(index=0, query="x", min_frames=0, broad_query="Title")]
    with pytest.raises(RuntimeError):
        fetch_footage(reqs, tmp_path, fps=30, key="K", search=fake_search, downloader=fake_download)


# ── invariant: selection never feeds span/timing (regression guard) ────────

def test_clip_duration_only_toggles_loop_never_timing():
    p = plan(BeatsScript(title="T", beats=[Beat(text="h"), Beat(text="scene"), Beat(text="o")]), theme=Theme())
    offsets = [LineOffset(0, "h", 0.0, 1.0), LineOffset(1, "scene", 1.0, 3.0), LineOffset(2, "o", 3.0, 4.0)]
    short = [Clip(index=1, query="q", path="assets/s.mp4", duration_frames=5)]
    long = [Clip(index=1, query="q", path="assets/l.mp4", duration_frames=9999)]

    spec_s = build_spec(p, offsets, [], short, catalog={}, fps=30)
    spec_l = build_spec(p, offsets, [], long, catalog={}, fps=30)

    timing = lambda spec: [(sc.startFrame, sc.durationInFrames) for sc in spec.scenes]
    assert timing(spec_s) == timing(spec_l)                            # selection can't move timing
    assert spec_s.scenes[1].templateProps["media"]["loop"] is True     # short clip -> loops
    assert spec_l.scenes[1].templateProps["media"]["loop"] is False    # long clip -> no loop


# ── wiring: the recipe title is threaded as the broaden fallback (E2E guard) ──

def test_footage_requests_carry_title_as_broad_query():
    from main import _footage_requests
    p = plan(BeatsScript(title="Coral Reefs", beats=[Beat(text="h"), Beat(text="scene"), Beat(text="o")]),
             theme=Theme())
    offsets = [LineOffset(0, "h", 0.0, 1.0), LineOffset(1, "scene", 1.0, 3.0), LineOffset(2, "o", 3.0, 4.0)]
    reqs = _footage_requests(p, offsets, {}, 30)
    assert len(reqs) == 1                          # only the middle scene needs footage
    assert reqs[0].broad_query == "Coral Reefs"    # title threaded so fetch_footage can broaden on a whiff
