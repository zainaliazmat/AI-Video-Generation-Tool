from pipeline.timing import words_to_timings
from pipeline.contracts import WordTiming


def test_words_to_timings_converts_and_strips():
    raw = [("Hello ", 0.0, 0.5), (" world", 0.5, 1.0)]
    out = words_to_timings(raw, 30)
    assert out == [
        WordTiming("Hello", 0, 15),
        WordTiming("world", 15, 30),
    ]


def test_skips_blank_and_guarantees_min_one_frame():
    raw = [("  ", 1.0, 1.0), ("hi", 2.0, 2.0)]
    out = words_to_timings(raw, 30)
    assert out == [WordTiming("hi", 60, 61)]  # blank skipped; end bumped to start+1
