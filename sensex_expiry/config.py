"""SENSEX expiry strategy config — isolated from orb_fib config."""

from dataclasses import dataclass
from datetime import date

from sensex_expiry.calendar import REGIME_START

IST = "Asia/Kolkata"
MARKET_OPEN = "09:15"
MARKET_CLOSE = "15:30"  # SENSEX cash/index follows BSE session (15:30 close)


@dataclass(frozen=True)
class SensexExpiryConfig:
    interval: str = "5"
    slippage_points: float = 1.0
    backtest_from: date = REGIME_START
    max_trades_per_expiry: int = 1
    # Sideways classification (expiry day study)
    or_minutes: int = 30
    sideways_mode: str = "close_in_or"  # close_in_or | net_move | low_efficiency | combined
    max_net_move_pct: float = 0.35  # |close-open|/open % — used by net_move / combined
    max_directional_efficiency: float = 0.35  # |close-open|/(high-low) — used by low_efficiency
    # Late breakout study (range until cutoff, move after)
    breakout_cutoff: str = "14:55"
    terrible_breakout_min_pts: float = 120.0
    terrible_breakout_range_mult: float = 0.75  # late move >= mult × pre-cutoff range width
    terrible_breakout_min_range_pct: float = 0.75  # late move >= 75% of containment width
    # Hero-zero: one leg per expiry ~3 PM (CE or PE, not straddle)
    hero_entry_time: str = "15:00"
    hero_direction: str = "momentum"  # momentum | contrarian | call | put
    direction_lookback_minutes: int = 30  # pre-entry window for momentum/contrarian
    hero_min_post_move_pts: float = 80.0  # index proxy: favorable settle pts
    hero_zero_max_move_pts: float = 25.0  # pinned / whipped → option → zero
    hero_min_premium_pct: float = 50.0  # premium PnL % at close → hero (when Dhan data)
    zero_premium_pct: float = 10.0  # exit premium ≤ this % of entry → zero
