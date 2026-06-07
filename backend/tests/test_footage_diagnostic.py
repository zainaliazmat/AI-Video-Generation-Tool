"""Phase 4 — footage diagnostic: the pure core that turns a Pexels search result
into a rank-ordered, eyeball-ready view, and the loop-playthrough math that answers
the (3)-band question (does the relevance-first pick loop perceptibly?)."""
from pipeline.footage_diagnostic import summarize_candidates, loop_playthroughs


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
