"""SENSEX option strike selection for hero-zero."""

from __future__ import annotations

SENSEX_STRIKE_STEP = 100


def strike_for_direction(spot: float, direction: str, *, step: int = SENSEX_STRIKE_STEP) -> int:
    """Single leg: CE = floor, PE = ceil (77777 → 77700 CE or 77800 PE)."""
    ce, pe = atm_strikes(spot, step=step)
    return ce if direction == "call" else pe


def atm_strikes(spot: float, *, step: int = SENSEX_STRIKE_STEP) -> tuple[int, int]:
    """ATM pair: CE = floor to step, PE = ceil to step (min one step above CE).

    77777 → CE 77700, PE 77800
    77700 → CE 77700, PE 77800
    """
    s = int(round(spot))
    ce = (s // step) * step
    pe = ((s + step - 1) // step) * step
    if pe <= ce:
        pe = ce + step
    return ce, pe
