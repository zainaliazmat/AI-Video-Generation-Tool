from session import gates, stages


def test_segments_partition_the_stage_order():
    flat = [s for g in gates.GATE_ORDER for s in gates.GATE_SEGMENTS[g]]
    assert flat == [s for s in stages.STAGE_ORDER if s != "render"]


def test_every_editable_stage_maps_to_one_gate():
    assert set(gates.GATE_FOR_STAGE) == {"script", "voice", "timing", "footage", "assemble"}
    assert set(gates.GATE_FOR_STAGE.values()) <= set(gates.GATE_ORDER)


def test_next_gate_chain():
    assert gates.next_gate("script") == "voice"
    assert gates.next_gate("voice") == "scenes"
    assert gates.next_gate("scenes") == "assemble"
    assert gates.next_gate("assemble") is None


def test_downstream_gates():
    assert gates.downstream_gates("script") == ["voice", "scenes", "assemble"]
    assert gates.downstream_gates("assemble") == []
