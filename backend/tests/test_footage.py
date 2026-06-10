import dataclasses

from pipeline.footage import pick_video_file, select_clip, fetch_footage, candidate_rows
from pipeline.contracts import Clip, FootageRequest
from pathlib import Path


def test_pick_prefers_portrait_mp4_near_1920():
    files = [
        {"link": "land", "width": 1920, "height": 1080, "file_type": "video/mp4"},
        {"link": "tall_sd", "width": 540, "height": 960, "file_type": "video/mp4"},
        {"link": "tall_hd", "width": 1080, "height": 1920, "file_type": "video/mp4"},
    ]
    assert pick_video_file(files) == "tall_hd"


def test_pick_returns_none_when_no_mp4():
    assert pick_video_file([{"link": "x", "width": 1080, "height": 1920, "file_type": "video/webm"}]) is None


def _video(link, duration):
    return {"duration": duration, "video_files": [
        {"link": link, "width": 1080, "height": 1920, "file_type": "video/mp4"}]}


def _video_pid(link, duration, pid, purl):
    v = _video(link, duration)
    v["id"] = pid
    v["url"] = purl
    return v


def test_select_clip_returns_link_and_duration_frames():
    sel = select_clip([_video("a", 6)], min_frames=0, fps=30)
    assert sel.link == "a"
    assert sel.duration_frames == 180  # 6s * 30fps


def test_select_clip_relevance_wins_when_top_clip_clears_the_floor():
    # Phase 4 ③: relevance (Pexels order) wins among clips that clear the loop floor.
    # The top clip is 4s — well over the 60f (2s) floor — so it is kept even though a
    # much longer clip follows. Length never displaces a relevant-enough top hit.
    sel = select_clip([_video("relevant_ok", 4), _video("longer_offtopic", 20)],
                      min_frames=60, fps=30)
    assert sel.link == "relevant_ok"
    assert sel.duration_frames == 120


def test_select_clip_skips_pathologically_short_top_clip_for_a_longer_usable_one():
    # Phase 4 duration floor — the diagnostic's K-floor case, reproducible in place via
    # `--query "storm clouds radar"`: a 1s clip ranked #1 looped 5× over a beat while a
    # relevant 17s clip sat at rank 2 (a fat pool — the trigger is "Pexels ranks a
    # pathologically short clip #1", not pool sparsity). When the top clip is below the
    # floor AND a later usable clip clears it, take the longer one — a tight loop reads
    # worse than dropping one rank.
    sel = select_clip([_video("one_second", 1), _video("seventeen_second", 17)],
                      min_frames=60, fps=30)
    assert sel.link == "seventeen_second"
    assert sel.duration_frames == 510


def test_select_clip_falls_back_to_first_when_none_long_enough():
    sel = select_clip([_video("a", 1), _video("b", 2)], min_frames=999, fps=30)
    assert sel.link == "a"  # relevance order preserved when nothing qualifies
    assert sel.duration_frames == 30


def test_select_clip_handles_missing_duration():
    sel = select_clip([{"video_files": [
        {"link": "x", "width": 1080, "height": 1920, "file_type": "video/mp4"}]}], min_frames=0, fps=30)
    assert sel.link == "x"
    assert sel.duration_frames is None


def test_select_clip_surfaces_rank_and_pexels_origin():
    sel = select_clip([_video_pid("a", 6, 101, "https://pexels.com/v/101")], min_frames=0, fps=30)
    assert sel.link == "a" and sel.duration_frames == 180
    assert sel.rank == 1 and sel.pexels_id == 101 and sel.pexels_url == "https://pexels.com/v/101"


def test_select_clip_rank_is_kfloor_displaced_position():
    # The 1s top clip is below the 60f floor; select_clip drops to the 17s clip at
    # usable-rank 2 — provenance rank must be 2, not 1.
    sel = select_clip([_video_pid("one_second", 1, 11, "u11"),
                       _video_pid("seventeen_second", 17, 22, "u22")], min_frames=60, fps=30)
    assert sel.link == "seventeen_second" and sel.rank == 2 and sel.pexels_id == 22


def test_select_clip_fallback_carries_first_usable_origin():
    # Nothing clears the floor -> fall back to the first usable clip (rank 1) and carry
    # ITS origin.
    sel = select_clip([_video_pid("a", 1, 7, "u7"), _video_pid("b", 2, 8, "u8")],
                      min_frames=999, fps=30)
    assert sel.link == "a" and sel.rank == 1 and sel.pexels_id == 7


# ── fetch_footage: request-driven, cached, duration recorded ────────────────

def _fake_search_factory(calls):
    def fake_search(query, key):
        calls["search"] += 1
        # duration keyed off query so we can assert mapping
        dur = 3 if query == "coral reef" else 6
        return {"videos": [_video(f"url-{query}", dur)]}
    return fake_search


def test_fetch_by_request_records_duration_and_caches(tmp_path):
    calls = {"search": 0, "download": 0}

    def fake_download(url, dest):
        calls["download"] += 1
        dest.write_bytes(b"fakevideo")

    reqs = [
        FootageRequest(index=1, query="ocean waves", min_frames=60),
        FootageRequest(index=3, query="ocean waves", min_frames=60),  # dup query
        FootageRequest(index=4, query="coral reef", min_frames=60),
    ]
    clips = fetch_footage(reqs, tmp_path, fps=30, key="K",
                          search=_fake_search_factory(calls), downloader=fake_download)

    assert [c.index for c in clips] == [1, 3, 4]            # keyed to beat index
    assert calls["download"] == 2                            # dup query downloaded once
    assert clips[0].path == clips[1].path
    assert clips[0].duration_frames == 180                  # 6s * 30
    assert clips[2].duration_frames == 90                   # coral reef 3s * 30
    assert all(isinstance(c, Clip) for c in clips)


def test_fetch_cache_hit_recovers_duration_from_sidecar(tmp_path):
    calls = {"search": 0, "download": 0}

    def fake_download(url, dest):
        calls["download"] += 1
        dest.write_bytes(b"fakevideo")

    search = _fake_search_factory(calls)
    req = [FootageRequest(index=0, query="ocean waves", min_frames=0)]
    first = fetch_footage(req, tmp_path, fps=30, key="K", search=search, downloader=fake_download)
    # second run: file is cached; duration must survive without re-searching
    second = fetch_footage(req, tmp_path, fps=30, key="K", search=search, downloader=fake_download)

    assert calls["download"] == 1                            # cached, not re-downloaded
    assert second[0].duration_frames == first[0].duration_frames == 180


def test_candidate_rows_include_pexels_origin():
    rows = candidate_rows([_video_pid("a", 6, 101, "https://pexels.com/v/101")],
                          query="coral reef", fps=30)
    assert len(rows) == 1
    r = rows[0]
    assert r["rank"] == 1 and r["query"] == "coral reef"
    assert r["pexels_id"] == 101 and r["pexels_url"] == "https://pexels.com/v/101"
    assert r["link"] == "a"  # existing fields preserved


def test_clip_provenance_fields_default_none_and_roundtrip():
    # Old construction (no provenance) still works — fields default to None.
    bare = Clip(index=0, query="q", path="assets/x.mp4", duration_frames=180)
    assert bare.rank is None and bare.pexels_id is None and bare.pexels_url is None

    # New construction carries provenance, and asdict<->Clip(**d) round-trips it
    # (this IS the mechanism session/codecs.clips_to_json/from_json rely on).
    c = Clip(index=1, query="reef", path="assets/r.mp4", duration_frames=210,
             rank=2, pexels_id=12345, pexels_url="https://pexels.com/v/12345")
    d = dataclasses.asdict(c)
    assert d["rank"] == 2 and d["pexels_id"] == 12345 and d["pexels_url"] == "https://pexels.com/v/12345"
    assert Clip(**d) == c
