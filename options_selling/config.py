"""Config for the positional options-selling backtest."""

from __future__ import annotations

from dataclasses import dataclass

# Lot sizes (current regime). Override per run if exchange changes them.
LOT_SIZES = {
    "NIFTY": 75,
    "BANKNIFTY": 35,
    "SENSEX": 20,
}

STRIKE_STEP = {
    "NIFTY": 50,
    "BANKNIFTY": 100,
    "SENSEX": 100,
}

# Symbols with bundled multi-year daily option history (data/fo_options_daily).
BACKTESTABLE = ("NIFTY", "BANKNIFTY")


@dataclass(frozen=True)
class OptionsSellingConfig:
    symbol: str = "NIFTY"

    # --- Structure ---
    structure: str = "strangle"  # strangle | straddle
    strike_method: str = "delta"  # delta | premium | offset_pct | atm
    target_delta: float = 0.16  # ~1 SD short strangle (16-delta)
    target_premium: float = 60.0  # per leg ₹ when strike_method="premium"
    offset_pct: float = 1.5  # % OTM from spot when strike_method="offset_pct"

    # --- Entry timing ---
    entry_dte: int = 2  # enter this many *trading* days before expiry (0 = expiry day)
    only_monthly: bool = False  # restrict to monthly expiries

    # --- Volatility filter (sell when vol is rich) ---
    use_iv_filter: bool = False
    iv_min: float = 12.0  # absolute index IV floor (from iv_history)
    iv_percentile_lookback: int = 0  # >0 → require IV above this rolling percentile instead

    # --- Risk management (on combined premium) ---
    stop_loss_pct: float = 50.0  # exit if combined premium rises this % above entry credit
    take_profit_pct: float = 50.0  # exit if combined premium decays this % (capture)
    max_hold_days: int = 0  # 0 = hold to expiry; else hard time stop in trading days

    # --- Costs / execution ---
    lot_size: int = 0  # 0 → resolve from LOT_SIZES[symbol]
    lots: int = 1
    slippage_pct: float = 1.0  # % adverse fill applied to each leg, both entry & exit
    brokerage_per_order: float = 20.0  # ₹ flat per leg per side (4 fills round-trip)

    def resolved_lot_size(self) -> int:
        return self.lot_size or LOT_SIZES.get(self.symbol, 1)

    def strike_step(self) -> int:
        return STRIKE_STEP.get(self.symbol, 50)
