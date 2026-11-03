"""Put repo root on sys.path so `options_buying` imports work from entry scripts."""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent


def ensure_repo_root() -> Path:
    root = str(_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    return _ROOT
