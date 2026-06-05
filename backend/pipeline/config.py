"""Env loading. Loads .env once from the repo root (cwd when running main.py)."""
from __future__ import annotations

import os

from dotenv import load_dotenv

_loaded = False


def load_env() -> None:
    global _loaded
    if not _loaded:
        load_dotenv()  # finds .env in cwd / parent dirs; does not override real env
        _loaded = True


def get_env(name: str, default: str = "") -> str:
    load_env()
    val = os.environ.get(name, "").strip()
    return val or default


def require_env(name: str) -> str:
    val = get_env(name)
    if not val:
        raise RuntimeError(
            f"Missing required environment variable: {name}. Set it in .env"
        )
    return val
