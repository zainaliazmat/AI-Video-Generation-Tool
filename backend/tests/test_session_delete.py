import session_delete


def test_delete_removes_folder_voiceover_and_session(tmp_path, monkeypatch):
    repo = tmp_path
    sid = "auto-del"
    (repo / "projects" / sid).mkdir(parents=True)
    (repo / "projects" / sid / "spec.json").write_text("{}")
    for root in ("remotion/public/assets", "preview/public/assets"):
        d = repo / root
        d.mkdir(parents=True)
        (d / f"voiceover_{sid}.wav").write_bytes(b"x")
    from session import store, job_ctx
    monkeypatch.setattr(job_ctx, "REPO_ROOT", repo)
    monkeypatch.setattr(job_ctx, "SESSIONS_DB", repo / "s.db")
    conn = store.connect(job_ctx.SESSIONS_DB)
    store.create_session(conn, id=sid, topic="t", now="now")
    conn.close()

    res = session_delete.delete(sid)

    assert res["ok"] is True
    assert not (repo / "projects" / sid).exists()
    assert not (repo / "remotion/public/assets" / f"voiceover_{sid}.wav").exists()
    assert not (repo / "preview/public/assets" / f"voiceover_{sid}.wav").exists()
    conn = store.connect(job_ctx.SESSIONS_DB)
    assert store.get_session(conn, sid) is None
    conn.close()


def test_delete_is_idempotent(tmp_path, monkeypatch):
    from session import job_ctx
    monkeypatch.setattr(job_ctx, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(job_ctx, "SESSIONS_DB", tmp_path / "s.db")
    # deleting a sid that never existed must not raise
    res = session_delete.delete("auto-nope")
    assert res["ok"] is True
