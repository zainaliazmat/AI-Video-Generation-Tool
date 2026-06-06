"""Stage 0 — the retrieval seam (grounding spine, step 3.1).

Tavily search wrapped THINLY so it stays swappable — mirroring the pluggable LLM
provider and the footage HTTP seam — but no full provider system: Tavily is the
concrete default. It returns clean snippets WITH source URLs (exactly what
citations need), cached by (query + params) like the footage cache, and the call
is bounded (one topic retrieval per video by default).

Tavily REST (verified against docs.tavily.com, 2026-06):
    POST https://api.tavily.com/search
    Authorization: Bearer <key>
    body: {"query", "max_results", "search_depth", "topic", ...}
    response: {"results": [{"title","url","content","score"}, ...], "usage": {...}}
`requests` only — no SDK dependency (the endpoint is simple enough that the SDK
buys little and a thin seam stays genuinely swappable).

Run standalone:  python backend/pipeline/retrieval.py --query "facts about octopuses"
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Set

import requests

from pipeline.config import require_env

TAVILY_SEARCH_URL = "https://api.tavily.com/search"
DEFAULT_MAX_RESULTS = 6
DEFAULT_SEARCH_DEPTH = "advanced"   # 2 credits; richer snippets — worth it for client grounding
DEFAULT_TOPIC = "general"


@dataclass
class RetrievedSnippet:
    """One Tavily result: a sourced fact candidate."""
    title: str
    url: str
    content: str
    score: float


@dataclass
class RetrievedContext:
    """The evidence pool a script is grounded in — snippets + their source URLs."""
    query: str
    snippets: List[RetrievedSnippet]

    @property
    def urls(self) -> Set[str]:
        """The set of real source URLs — used to check a beat's `source` is one we
        actually retrieved (strict grounding), not an invented citation."""
        return {s.url for s in self.snippets}

    def prompt_block(self) -> str:
        """The evidence block injected into the grounding prompt: each snippet
        numbered with its URL so the model can cite the exact source it used."""
        if not self.snippets:
            return "(no sources retrieved)"
        return "\n\n".join(
            f"[{i}] {s.title} — {s.url}\n{s.content}" for i, s in enumerate(self.snippets, 1)
        )


def _cache_key(query: str, params: Dict) -> str:
    payload = json.dumps({"q": query.strip().lower(), **params}, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _search_tavily(query: str, key: str, params: Dict) -> Dict:
    r = requests.post(
        TAVILY_SEARCH_URL,
        json={"query": query, **params},
        headers={"Authorization": f"Bearer {key}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _parse(raw: Dict, query: str) -> RetrievedContext:
    snippets = [
        RetrievedSnippet(
            title=(res.get("title") or "").strip(),
            url=res.get("url") or "",
            content=(res.get("content") or "").strip(),
            score=float(res.get("score") or 0.0),
        )
        for res in raw.get("results", [])
        if res.get("url")  # a result with no URL can't be cited — drop it
    ]
    return RetrievedContext(query=query, snippets=snippets)


def retrieve(
    query: str,
    *,
    key: Optional[str] = None,
    search: Optional[Callable[[str, str, Dict], Dict]] = None,
    cache_dir=None,
    max_results: int = DEFAULT_MAX_RESULTS,
    search_depth: str = DEFAULT_SEARCH_DEPTH,
    topic: str = DEFAULT_TOPIC,
) -> RetrievedContext:
    """Tavily-search `query` → a cached, parsed RetrievedContext.

    `search` is injectable (tests pass a fake → fully offline). `key` defaults to
    TAVILY_API_KEY and is required only on a cache MISS, so cached runs need no key.
    Cached by (query + params) under `cache_dir` (None disables caching)."""
    search = search or _search_tavily
    params = {"max_results": max_results, "search_depth": search_depth, "topic": topic}

    cache_path = None
    if cache_dir is not None:
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / f"retrieval_{_cache_key(query, params)}.json"
        if cache_path.exists():
            return _parse(json.loads(cache_path.read_text(encoding="utf-8")), query)

    key = key or require_env("TAVILY_API_KEY")
    raw = search(query, key, params)
    if cache_path is not None:
        cache_path.write_text(json.dumps(raw), encoding="utf-8")
    return _parse(raw, query)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--max-results", type=int, default=DEFAULT_MAX_RESULTS)
    args = ap.parse_args()
    ctx = retrieve(args.query, max_results=args.max_results, cache_dir=None)
    print(ctx.prompt_block())
