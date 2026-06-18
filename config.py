from dataclasses import dataclass
from pathlib import Path

IST = "Asia/Kolkata"
MARKET_OPEN = "09:15"
MARKET_CLOSE = "15:00"  # flat by 3:00 PM IST (last candle opens before this time)

CACHE_DIR = Path("data/cache")


@dataclass(frozen=True)
class Instrument:
    name: str
    display_name: str = ""
    lot_size: int = 1
    kind: str = "equity"  # index | equity
    exchange: str = "NSE"
    symbol_token: str = ""
    dhan_security_id: str = ""
    dhan_exchange_segment: str = ""
    dhan_instrument_type: str = ""


NIFTY_LOT_SIZE = 75  # fallback if scrip master unavailable


@dataclass(frozen=True)
class OrbFibConfig:
    orb_minutes: int = 15
    interval: str = "5"
    entry_mode: str = "breakout"  # breakout | fib_pullback
    fib_entry_level: float = 0.5  # fib pullback touch (0.5 | 0.618)
    fib_pullback_stop_level: float = 0.786  # stop at 78.6% on impulse leg
    min_impulse_or_ratio: float = 0.25  # min impulse span vs OR width
    stop_level: float = 0.618  # breakout stop / trail distance: fraction of OR span
    stop_mode: str = "fixed"  # fixed | trail — trail ratchets with session extreme
    slippage_points: float = 1.0
    max_trades_per_day: int = 2  # sequential: e.g. short stopped → opposite breakout
    # exit_mode: eod | tp_ladder | fib_tsl
    exit_mode: str = "tp_ladder"
    max_hold_days: int = 1  # 1 = intraday (3 PM flat); 2+ = carry until TP/SL or max sessions
    tp_extensions: tuple[float, float, float] = (1.272, 1.618, 2.0)
    tp_sizes: tuple[float, float, float] = (0.33, 0.33, 0.34)
    tp_full_exit: tuple[bool, bool, bool] = (False, False, False)  # close all remainder on TP hit
    tp_first_touch_full_exit: tuple[bool, bool, bool] = (False, False, False)  # e.g. TP2 before TP1
    tp_after_time: tuple[str | None, str | None, str | None] = (None, None, None)  # IST HH:MM gate per TP
    tsl_ratchet_fibs: tuple[float, float, float] = (0.618, 0.500, 0.382)
    min_body_ratio: float = 0.55
    max_wick_ratio: float = 0.35
    require_strong_candle: bool = True
    use_vwap_filter: bool = False  # long only above VWAP, short only below
    last_entry_time: str | None = None  # "HH:MM" IST — no new entries at or after this candle open
    swing_opposite_or: str = "eod"  # off | intraday | eod (swing only, days after entry)
    block_same_day_after_swing: bool = True  # no new entries same session after multi-day trade exits
