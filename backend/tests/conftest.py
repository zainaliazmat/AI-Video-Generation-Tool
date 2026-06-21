import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_pexels_photos: opt OUT of the autouse photo stub (test the real "
        "search_pexels_photos directly).",
    )


@pytest.fixture(autouse=True)
def _stub_pexels_photos(request, monkeypatch):
    """Default-stub the merged gate pool's PHOTO arm to empty so no test makes a real
    Pexels photo request (the arm is best-effort; an unstubbed real call would be slow
    and flaky). Tests that exercise the REAL search_pexels_photos mark themselves
    @pytest.mark.real_pexels_photos to opt out."""
    if request.node.get_closest_marker("real_pexels_photos"):
        return
    monkeypatch.setattr(
        "pipeline.footage.search_pexels_photos",
        lambda q, key, **kw: {"photos": []},
        raising=False,
    )
