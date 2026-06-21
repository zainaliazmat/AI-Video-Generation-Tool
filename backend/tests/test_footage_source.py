"""Phase 0 — footage source overhaul: orientation parameterization + Pexels photo
source. These pin the measurement instrument's building blocks (search_pexels
orientation control, search_pexels_photos, pick_photo) BEFORE the production
fallback is wired in. Production video behavior stays byte-identical here: the
search_pexels default remains "portrait" until measurement validates the switch.

See ~/.gstack/projects/AIVideoGenerationTool/2026-06-14-footage-source-overhaul-design.md
"""
import pytest

from pipeline import footage as footage_stage


class _FakeResp:
    def __init__(self, status, *, json_body=None, headers=None):
        self.status_code = status
        self._json = json_body or {}
        self.headers = headers or {}

    def json(self):
        return self._json

    def raise_for_status(self):
        import requests
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")


def _capturing_get(captured, json_body):
    def fake_get(url, **kw):
        captured["url"] = url
        captured["params"] = kw.get("params")
        return _FakeResp(200, json_body=json_body)
    return fake_get


# ── orientation parameterization (video) ────────────────────────────────────

def test_search_pexels_default_stays_portrait():
    """Measure-first guard: with no orientation arg, production behavior is unchanged
    (Pexels videos still filtered to portrait). Flipping this default is the BUILD step."""
    cap = {}
    footage_stage.search_pexels("ocean", "K", _get=_capturing_get(cap, {"videos": []}))
    assert cap["params"]["orientation"] == "portrait"


def test_search_pexels_omits_orientation_when_none():
    """Passing orientation=None drops the filter entirely → Pexels returns its true
    relevance ranking across all orientations. This is what the diagnostic measures."""
    cap = {}
    footage_stage.search_pexels("ocean", "K", orientation=None,
                                _get=_capturing_get(cap, {"videos": []}))
    assert "orientation" not in cap["params"]


def test_search_pexels_passes_explicit_orientation():
    cap = {}
    footage_stage.search_pexels("ocean", "K", orientation="landscape",
                                _get=_capturing_get(cap, {"videos": []}))
    assert cap["params"]["orientation"] == "landscape"


# ── Pexels photo search ─────────────────────────────────────────────────────

@pytest.mark.real_pexels_photos
def test_search_pexels_photos_hits_photo_endpoint_and_parses():
    cap = {}
    body = {"photos": [{"id": 7, "src": {"large2x": "http://x/p.jpg"}}]}
    out = footage_stage.search_pexels_photos("deep ocean", "K",
                                             _get=_capturing_get(cap, body))
    assert cap["url"] == footage_stage.PEXELS_PHOTO_SEARCH
    assert out == body
    # default photo orientation is unfiltered (photos are huge-res; crop is free)
    assert "orientation" not in cap["params"]


@pytest.mark.real_pexels_photos
def test_search_pexels_photos_shares_retry_backoff():
    """F3 (DRY): photo search reuses the same 429/backoff path as video search."""
    slept = []
    responses = iter([
        _FakeResp(429, headers={"Retry-After": "3"}),
        _FakeResp(200, json_body={"photos": []}),
    ])
    out = footage_stage.search_pexels_photos(
        "deep ocean", "K", _get=lambda url, **kw: next(responses),
        _sleep=slept.append, max_retries=3,
    )
    assert out == {"photos": []}
    assert slept == [3.0]


# ── photo file selection ────────────────────────────────────────────────────

def test_pick_photo_prefers_high_res_src():
    """A 1080x1920 frame needs a wide source so the vertical cover-crop never upscales.
    Prefer large2x (~1880w); fall back to original; never the small/tiny thumbs."""
    photo = {"src": {"tiny": "t", "medium": "m", "large": "l",
                     "large2x": "L2", "original": "O"}}
    assert footage_stage.pick_photo(photo) == "L2"


def test_pick_photo_falls_back_to_original_then_none():
    assert footage_stage.pick_photo({"src": {"original": "O"}}) == "O"
    assert footage_stage.pick_photo({"src": {}}) is None
    assert footage_stage.pick_photo({}) is None


# ── photo candidate rows ────────────────────────────────────────────────────

def _photo(pid, *, large2x="L2", medium="m", w=4000, h=6000, webm=False):
    return {"id": pid, "url": f"ph{pid}", "width": w, "height": h,
            "src": {} if webm else {"large2x": large2x, "medium": medium}}


def test_photo_candidate_rows_marks_image_kind_and_high_res_link():
    rows = footage_stage.photo_candidate_rows([_photo(1), _photo(2)], query="leaf")
    assert [r["rank"] for r in rows] == [1, 2]
    assert all(r["kind"] == "image" for r in rows)
    assert rows[0]["link"] == "L2" and rows[0]["duration_frames"] is None
    assert rows[0]["thumb_url"] == "m" and rows[0]["pexels_id"] == 1


def test_photo_candidate_rows_skips_photos_with_no_usable_src():
    # a photo with no large2x/original is unusable -> dropped, rank counts usable only
    rows = footage_stage.photo_candidate_rows([_photo(1, webm=True), _photo(2)], query="leaf")
    assert [r["rank"] for r in rows] == [1]
    assert rows[0]["pexels_id"] == 2


# ── merged pool: portrait video + unfiltered video + photos ─────────────────

def _vid(link, *, pid=None, dur=6):
    return {"id": pid, "url": f"pg{pid}", "duration": dur,
            "video_files": [{"link": link, "width": 1080, "height": 1920,
                             "file_type": "video/mp4"}],
            "video_pictures": [{"picture": f"thumb_{link}"}]}


def test_fetch_pool_merged_tags_sources_and_flat_ranks():
    def vsearch(q, k, orientation="portrait"):
        if orientation == "portrait":
            return {"videos": [_vid("pa", pid=1), _vid("pb", pid=2)]}
        # unfiltered: pid=1 dup (drop), pid=3 new (keep)
        return {"videos": [_vid("pa", pid=1), _vid("uc", pid=3)]}

    def psearch(q, k):
        return {"photos": [_photo(7), _photo(8)]}

    out = footage_stage.fetch_pool_merged("leaf", "K", 30, search=vsearch, photo_search=psearch)
    rows = out["rows"]
    assert [r["source"] for r in rows] == ["portrait", "portrait", "unfiltered", "photo", "photo"]
    assert [r["kind"] for r in rows] == ["video", "video", "video", "image", "image"]
    assert [r["rank"] for r in rows] == [1, 2, 3, 4, 5]          # one contiguous rank space
    assert out["error"] is None


def test_fetch_pool_merged_dedups_unfiltered_against_portrait_by_link():
    # unfiltered returns the SAME clips as portrait (no pexels id) -> dedup by link, add none
    def vsearch(q, k, orientation="portrait"):
        return {"videos": [_vid("a"), _vid("b")]}   # identical both calls, id=None

    out = footage_stage.fetch_pool_merged("x", "K", 30, search=vsearch,
                                          photo_search=lambda q, k: {"photos": []})
    assert [r["source"] for r in out["rows"]] == ["portrait", "portrait"]


def test_fetch_pool_merged_caps_each_source():
    def vsearch(q, k, orientation="portrait"):
        vids = [_vid(f"v{i}", pid=100 + i) for i in range(10)]
        return {"videos": vids if orientation == "portrait" else []}

    out = footage_stage.fetch_pool_merged("x", "K", 30, per_source=3, search=vsearch,
                                          photo_search=lambda q, k: {"photos": []})
    assert len([r for r in out["rows"] if r["source"] == "portrait"]) == 3


def test_fetch_pool_merged_extras_are_best_effort_primary_failure_sets_error():
    # photos blow up, unfiltered blows up -> pool still has portrait, error stays None
    def vsearch(q, k, orientation="portrait"):
        if orientation is None:
            raise RuntimeError("unfiltered down")
        return {"videos": [_vid("pa", pid=1)]}

    def psearch(q, k):
        raise RuntimeError("photos down")

    out = footage_stage.fetch_pool_merged("x", "K", 30, search=vsearch, photo_search=psearch)
    assert [r["source"] for r in out["rows"]] == ["portrait"]
    assert out["error"] is None


def test_fetch_pool_merged_primary_429_sets_rate_limited():
    import requests

    class _R:
        status_code = 429

    def vsearch(q, k, orientation="portrait"):
        raise requests.HTTPError(response=_R())

    out = footage_stage.fetch_pool_merged("x", "K", 30, search=vsearch,
                                          photo_search=lambda q, k: {"photos": []})
    assert out["rows"] == [] and out["error"] == "rate_limited"
