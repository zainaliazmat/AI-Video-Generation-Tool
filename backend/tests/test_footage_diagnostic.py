"""Phase 4 — footage diagnostic: the pure core that turns a Pexels search result
into a rank-ordered, eyeball-ready view, and the loop-playthrough math that answers
the (3)-band question (does the relevance-first pick loop perceptibly?)."""
from pipeline.footage_diagnostic import summarize_candidates, loop_playthroughs, kfloor_pick


def _v(link, dur, ftype="video/mp4", w=1080, h=1920, image="t", url="p"):
    return {"duration": dur, "image": image, "url": url,
            "video_files": [{"link": link, "width": w, "height": h, "file_type": ftype}]}


def test_summarize_ranks_and_marks_first_usable_selected():
    videos = [
        _v("x", 2, ftype="video/webm"),          # no mp4 -> not usable
        _v("a", 5, image="ta", url="pa"),         # first usable -> selected
        _v("b", 9, image="tb", url="pb"),
    ]
    rows = summarize_candidates(videos, fps=30)
    assert [r["rank"] for r in rows] == [1, 2, 3]
    assert [r["usable"] for r in rows] == [False, True, True]
    assert [r["selected"] for r in rows] == [False, True, False]   # first USABLE, not first overall
    assert rows[1]["duration_frames"] == 150                       # 5s * 30
    assert rows[1]["thumb"] == "ta" and rows[1]["page"] == "pa"


def test_loop_playthroughs_answers_the_band_question():
    assert loop_playthroughs(180, 90) == 2      # half-length clip -> 2 playthroughs (the K=2 boundary)
    assert loop_playthroughs(180, 200) == 1     # long enough -> plays once, no loop
    assert loop_playthroughs(180, 60) == 3      # heavy repeat
    assert loop_playthroughs(180, None) is None # unknown duration -> unknown
    assert loop_playthroughs(180, 0) is None


def test_kfloor_pick_dormant_when_top_usable_clip_clears_floor():
    # The top USABLE clip (rank 2, 4s=120f) clears the 60f floor, so select_clip keeps
    # it: the K-floor pick collapses onto the relevance-first pick. Dormant — the
    # diagnostic reports the SAME rank for * and K (no displacement to eyeball).
    videos = [_v("x", 2, ftype="video/webm"),    # not usable
              _v("a", 4), _v("b", 20)]            # first usable at rank 2, clears floor
    rank, frames = kfloor_pick(videos, min_frames=60, fps=30)
    assert rank == 2 and frames == 120


def test_kfloor_pick_displaces_pathologically_short_top_clip():
    # The top usable clip (1s=30f) is BELOW the 60f floor and a later usable clip (17s)
    # clears it -> select_clip bumps the pick down. The diagnostic must report the LATER
    # rank (the clip actually rendered), proving the instrument tracks the real pick.
    videos = [_v("one_second", 1), _v("seventeen", 17)]
    rank, frames = kfloor_pick(videos, min_frames=60, fps=30)
    assert rank == 2 and frames == 510


def test_kfloor_pick_falls_back_to_first_usable_when_none_clear():
    # Nothing clears the floor -> select_clip falls back to the first usable clip, so the
    # K-floor pick collapses back onto rank 1 (no displacement). Guards against the
    # instrument inventing a displacement the pipeline would never make.
    videos = [_v("short_a", 1), _v("short_b", 2)]
    rank, frames = kfloor_pick(videos, min_frames=300, fps=30)
    assert rank == 1 and frames == 30


def test_report_emits_DISPLACED_when_floor_bumps_the_pick(capsys):
    # The whole point of the instrument upgrade — and a path NO live beat exercised this
    # run. Constructed pool: top usable clip (1s=30f) below the 120f floor, a longer clip
    # (17s) at rank 2. _report must print "K-floor DISPLACED" rank 1 -> rank 2, not DORMANT.
    from pipeline.footage_diagnostic import _report
    _report("t", "q", [_v("one_second", 1), _v("seventeen", 17)], fps=30, span_frames=240, min_frames=120)
    out = capsys.readouterr().out
    assert "K-floor DISPLACED" in out and "rank 1" in out and "rank 2" in out
    assert "DORMANT" not in out


def test_report_emits_DORMANT_when_top_clip_clears_floor(capsys):
    # Contrast direction, so the branch can't silently invert: top usable clip (8s=240f)
    # clears the 120f floor -> select_clip keeps it -> _report says DORMANT, never DISPLACED.
    from pipeline.footage_diagnostic import _report
    _report("t", "q", [_v("eight", 8), _v("twenty", 20)], fps=30, span_frames=240, min_frames=120)
    out = capsys.readouterr().out
    assert "K-floor DORMANT" in out
    assert "DISPLACED" not in out
