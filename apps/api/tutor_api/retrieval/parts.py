"""Candidate parts for one block: the composer's `part` enum.

LLD §6 retrieves up to 40 parts by role, then by vector similarity. The registry has 15 parts, so
the role filter alone always fits within k and there is nothing to rank: the parts tagged with
the block's role, every passive part, and every part the reference template uses (an emitter
follower's coupling capacitor is tagged `coupling`, not `buffer`). pgvector ranking comes back
when the registry outgrows k.
"""

from __future__ import annotations

from typing import Any

K_PARTS = 40


def candidates(bundle: dict[str, Any], template: str) -> list[str]:
    t = bundle["templates"][template]
    used = {d["part"] for d in t["parts"].values()}
    out = [
        pid for pid, p in bundle["parts"].items()
        if pid in used or t["role"] in p["role_tags"] or "passive" in p["role_tags"]
    ]
    return out[:K_PARTS]
