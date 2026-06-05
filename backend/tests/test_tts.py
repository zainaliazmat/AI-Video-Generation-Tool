import numpy as np
import soundfile as sf
from pipeline.tts import compute_offsets, synthesize, SAMPLE_RATE, SILENCE_SEC
from pipeline.contracts import LineOffset


def test_compute_offsets_inserts_gaps():
    offs = compute_offsets(["a", "b"], [1.0, 2.0], gap=0.5)
    assert offs == [
        LineOffset(0, "a", 0.0, 1.0),
        LineOffset(1, "b", 1.5, 3.5),
    ]


def test_synthesize_writes_wav_and_offsets(tmp_path):
    one_sec = np.ones(SAMPLE_RATE, dtype=np.float32)
    out = tmp_path / "vo.wav"
    offs = synthesize(["x", "y"], out, synth=lambda line: one_sec)
    assert out.exists()
    data, sr = sf.read(out)
    assert sr == SAMPLE_RATE
    gap = int(SILENCE_SEC * SAMPLE_RATE)
    assert len(data) == SAMPLE_RATE * 2 + gap          # 2 lines + 1 gap
    assert offs[0].start == 0.0 and abs(offs[0].end - 1.0) < 1e-6
    assert abs(offs[1].start - (1.0 + SILENCE_SEC)) < 1e-6
