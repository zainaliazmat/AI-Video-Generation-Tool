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


def test_merges_leading_comma_number_fragment():
    # faster-whisper splits "37,700" into "37" + ",700"; glue it back so the
    # karaoke never renders a leading-comma fragment. Span is the union.
    raw = [("37", 0.0, 0.3), (",700", 0.3, 0.6), ("gigatons", 0.6, 1.0)]
    out = words_to_timings(raw, 30)
    assert out == [
        WordTiming("37,700", 0, 18),
        WordTiming("gigatons", 18, 30),
    ]


def test_merges_decimal_fragment_and_chains_thousands():
    # ".5" continues "3"; a second ",xxx" continues the accumulating number.
    raw = [("1", 0.0, 0.1), (",234", 0.1, 0.2), (",567", 0.2, 0.3), ("3", 0.4, 0.5), (".5", 0.5, 0.6)]
    out = words_to_timings(raw, 100)
    assert out == [
        WordTiming("1,234,567", 0, 30),
        WordTiming("3.5", 40, 60),
    ]


def test_does_not_merge_ordinary_words_or_non_numeric_predecessor():
    # ordinary adjacent words never merge; a separator fragment after a NON-digit
    # word is left alone (narrow, number-atomic rule).
    raw = [("hot", 0.0, 0.3), ("enough", 0.3, 0.6), ("end", 0.6, 0.9), (",700", 0.9, 1.2)]
    out = words_to_timings(raw, 30)
    assert out == [
        WordTiming("hot", 0, 9),
        WordTiming("enough", 9, 18),
        WordTiming("end", 18, 27),
        WordTiming(",700", 27, 36),
    ]
