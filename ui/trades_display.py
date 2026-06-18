"""Human-readable trade labels for the UI."""

from __future__ import annotations

OUTCOME_PARTS = {
    "stop": "Stop loss",
    "trail": "Trailing stop",
    "gap_stop": "Gap through stop",
    "eod": "3 PM flat",
    "max_days": "Max hold",
    "opp_or": "Opposite OR",
    "opp_or_eod": "Opposite OR (close)",
    "tp1": "Target 1",
    "tp2": "Target 2",
    "tp3": "Target 3",
    "tp1_first": "Target 1 (full)",
    "tp2_first": "Target 2 (full)",
    "tp3_first": "Target 3 (full)",
    "tsl": "Trailing stop",
}


def format_outcome(outcome: str) -> str:
    if not outcome:
        return ""
    parts = str(outcome).split("+")
    return " + ".join(OUTCOME_PARTS.get(p, p) for p in parts)


def format_hold_label(sessions_held: int, max_sessions: int) -> str:
    """e.g. '3 of 10 sessions' or '1 session (intraday)'."""
    if max_sessions <= 1:
        return "1 session (intraday)"
    return f"{sessions_held} of {max_sessions} sessions"
