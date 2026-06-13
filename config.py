from dataclasses import dataclass
from pathlib import Path

IST = "Asia/Kolkata"
MARKET_OPEN = "09:15"
MARKET_CLOSE = "15:30"

CACHE_DIR = Path("data/cache")


@dataclass(frozen=True)
class Instrument:
    name: str
    exchange: str
    symbol_token: str


NIFTY = Instrument(
    name="NIFTY",
    exchange="NSE",
    symbol_token="99926000",
)


@dataclass(frozen=True)
class OrbFibConfig:
    orb_minutes: int = 15
    interval: str = "5"
    entry_mode: str = "breakout"  # breakout | fib_pullback
    fib_entry_level: float = 0.5
    target_extension: float = 1.272
    stop_level: float = 0.618
    slippage_points: float = 1.0
    max_trades_per_day: int = 1
    min_body_ratio: float = 0.55  # body must be >= 55% of candle range
    max_wick_ratio: float = 0.35  # each wick must be <= 35% of range
    require_strong_candle: bool = True
