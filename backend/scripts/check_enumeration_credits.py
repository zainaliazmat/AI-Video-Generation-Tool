"""Gate: every bundled enumeration image has a COMPLETE provenance record.

COVERAGE direction (the part that makes "no image ships undocumented" true): we
enumerate the actual image files in remotion/public/enumeration/ and require each
to have a complete CREDITS record. An image dropped in with no record FAILS — it is
not enough to check that listed records are filled, because a no-record file would
be invisible to that. We also flag records whose file is missing (stale entry).

Checks COMPLETENESS (source_url/rights/date filled), NOT correctness — the truth of
each rights claim is operator-owned, confirmed against NASA media-usage guidance.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CREDITS = ROOT / "templates/enumeration/assets/CREDITS.json"
IMG_DIR = ROOT / "remotion/public/enumeration"
REQUIRED = ("source_url", "rights", "date")
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def main() -> int:
    data = json.loads(CREDITS.read_text())
    # index records by their on-disk path (relative to remotion/public)
    by_file = {a.get("file", ""): a for a in data.get("assets", [])}
    problems: list[str] = []

    # COVERAGE: every actual image file must have a complete record.
    actual = sorted(p for p in IMG_DIR.glob("*") if p.suffix.lower() in IMG_EXTS) if IMG_DIR.exists() else []
    for p in actual:
        rel = f"enumeration/{p.name}"
        rec = by_file.get(rel)
        if rec is None:
            problems.append(f"{rel}: image present but has NO CREDITS record (undocumented)")
            continue
        for field in REQUIRED:
            if not str(rec.get(field, "")).strip():
                problems.append(f"{rel}: empty '{field}'")

    # Hygiene: a record pointing at a missing file is stale.
    for f, rec in by_file.items():
        if not f:
            problems.append(f"{rec.get('label', '<no-label>')}: empty 'file'")
        elif not (ROOT / "remotion/public" / f).exists():
            problems.append(f"{f}: CREDITS record but image file missing")

    if not actual:
        problems.append(f"no image files in {IMG_DIR} yet — operator must drop the curated PD set")

    if problems:
        print("CREDITS gate FAILED — no image ships undocumented:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"CREDITS gate OK: {len(actual)} image files, all documented.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
