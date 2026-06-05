from pipeline.footage import pick_video_file, fetch_footage, query_slug
from pipeline.contracts import Clip


def test_pick_prefers_portrait_mp4_near_1920():
    files = [
        {"link": "land", "width": 1920, "height": 1080, "file_type": "video/mp4"},
        {"link": "tall_sd", "width": 540, "height": 960, "file_type": "video/mp4"},
        {"link": "tall_hd", "width": 1080, "height": 1920, "file_type": "video/mp4"},
    ]
    assert pick_video_file(files) == "tall_hd"


def test_pick_returns_none_when_no_mp4():
    assert pick_video_file([{"link": "x", "width": 1080, "height": 1920, "file_type": "video/webm"}]) is None


def test_fetch_caches_by_query(tmp_path):
    calls = {"search": 0, "download": 0}

    def fake_search(query, key):
        calls["search"] += 1
        return {"videos": [{"video_files": [
            {"link": "u", "width": 1080, "height": 1920, "file_type": "video/mp4"}]}]}

    def fake_download(url, dest):
        calls["download"] += 1
        dest.write_bytes(b"fakevideo")

    lines = ["ocean waves", "ocean waves", "coral reef"]  # dup query
    clips = fetch_footage(lines, tmp_path, key="K", search=fake_search, downloader=fake_download)

    assert len(clips) == 3
    assert calls["download"] == 2          # "ocean waves" downloaded once, reused
    assert clips[0].path == clips[1].path  # same query -> same file
    assert clips[0].path == f"assets/footage_{query_slug('ocean waves')}.mp4"
    assert all(isinstance(c, Clip) for c in clips)
