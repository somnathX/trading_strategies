from dataclasses import dataclass
from pathlib import Path

IST = "Asia/Kolkata"
MARKET_OPEN = "09:15"
MARKET_CLOSE = "15:00"  # flat by 3:00 PM IST (last candle opens before this time)

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
    stop_level: float = 0.618
    slippage_points: float = 1.0
    max_trades_per_day: int = 1
    # exit_mode: eod | tp_ladder | fib_tsl
    exit_mode: str = "tp_ladder"
    tp_extensions: tuple[float, float, float] = (1.272, 1.618, 2.0)
    tp_sizes: tuple[float, float, float] = (0.33, 0.33, 0.34)
    tsl_ratchet_fibs: tuple[float, float, float] = (0.618, 0.500, 0.382)
    min_body_ratio: float = 0.55
    max_wick_ratio: float = 0.35
    require_strong_candle: bool = True
