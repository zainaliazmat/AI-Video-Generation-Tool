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
