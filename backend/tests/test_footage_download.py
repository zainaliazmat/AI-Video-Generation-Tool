"""Item 3 — footage download hardening: atomic temp→rename + 429/5xx backoff.

The corrupt-cache landmine: _download streamed straight into `dest`, so a
mid-stream drop left a truncated file that the `if dest.exists()` cache check
later served as valid. The fix downloads to a sibling `.part` and os.replace()s
it onto `dest` only on success; the `.frames` sidecar is written only AFTER the
rename. These tests pin that a failed download leaves NO dest and NO sidecar, and
that a clean download is a cache no-op.
"""
import pytest

from pipeline.contracts import FootageRequest
from pipeline import footage as footage_stage


def _video(link, duration):
    return {"duration": duration, "video_files": [
        {"link": link, "width": 1080, "height": 1920, "file_type": "video/mp4"}]}


def test_failed_download_leaves_no_dest_and_no_sidecar(tmp_path):
    """A downloader that writes a partial file then raises must leave neither a
    `dest` .mp4 nor a `.frames` sidecar — so a later run can't serve the truncate."""
    def good_search(query, key):
        return {"videos": [_video("http://x/clip.mp4", 6)]}

    def failing_download(url, dest):
        dest.write_bytes(b"partial")          # a truncated body lands in the .part
        raise IOError("connection dropped mid-stream")

    req = FootageRequest(index=0, query="ocean waves", min_frames=0)
    with pytest.raises(IOError):
        footage_stage._fetch_one(
            req, "ocean waves", tmp_path,
            fps=30, key="K", search=good_search, downloader=failing_download,
        )

    assert list(tmp_path.glob("*.mp4")) == []        # no dest serving a truncate
    assert list(tmp_path.glob("*.frames")) == []     # no sidecar pointing at nothing
    assert list(tmp_path.glob("*.part")) == []       # the temp was cleaned up too


def test_clean_download_then_cache_hit_does_not_redownload(tmp_path):
    """First call downloads (and writes dest + sidecar); the second call with the
    SAME query is a cache hit — the downloader is never invoked again."""
    calls = {"download": 0, "search": 0}

    def good_search(query, key):
        calls["search"] += 1
        return {"videos": [_video("http://x/clip.mp4", 6)]}

    def good_download(url, dest):
        calls["download"] += 1
        dest.write_bytes(b"full clip bytes")

    req = FootageRequest(index=0, query="ocean waves", min_frames=0)
    c1 = footage_stage._fetch_one(req, "ocean waves", tmp_path,
                                  fps=30, key="K", search=good_search, downloader=good_download)
    c2 = footage_stage._fetch_one(req, "ocean waves", tmp_path,
                                  fps=30, key="K", search=good_search, downloader=good_download)

    assert calls == {"download": 1, "search": 1}     # second call hit the cache
    assert c1.path == c2.path
    assert c1.duration_frames == c2.duration_frames == 180   # 6s * 30fps, from the sidecar
    assert len(list(tmp_path.glob("*.mp4"))) == 1    # exactly one cached clip


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


def test_search_pexels_retries_on_429_then_succeeds_honoring_retry_after():
    slept = []
    responses = iter([
        _FakeResp(429, headers={"Retry-After": "5"}),       # rate-limited, told to wait 5s
        _FakeResp(200, json_body={"videos": [{"id": 1}]}),  # then OK
    ])

    def fake_get(url, **kw):
        return next(responses)

    out = footage_stage.search_pexels(
        "ocean waves", "K", _get=fake_get, _sleep=slept.append, max_retries=3,
    )

    assert out == {"videos": [{"id": 1}]}
    assert slept == [5.0]            # honored the Retry-After header, retried once


def test_search_pexels_exhausts_retries_then_raises():
    slept = []

    def always_429(url, **kw):
        return _FakeResp(429, headers={})        # no Retry-After → exponential backoff

    import requests
    with pytest.raises(requests.HTTPError):
        footage_stage.search_pexels(
            "ocean waves", "K", _get=always_429, _sleep=slept.append, max_retries=2,
        )
    assert slept == [1.0, 2.0]       # 2^0, 2^1 backoff between the 3 attempts, then raised


def test_search_pexels_retries_on_5xx_then_succeeds():
    slept = []
    responses = iter([
        _FakeResp(503),
        _FakeResp(200, json_body={"videos": []}),
    ])
    out = footage_stage.search_pexels(
        "ocean waves", "K", _get=lambda url, **kw: next(responses),
        _sleep=slept.append, max_retries=3,
    )
    assert out == {"videos": []}
    assert len(slept) == 1   # one sleep between the two attempts
