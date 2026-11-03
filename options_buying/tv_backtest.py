"""TradingView-equivalent underlying backtest for the swing long/short strategy.

Mirrors the Pine `strategy()` semantics so results can be reconciled with TradingView:
- default_qty_type = percent_of_equity (size = qty_pct% of equity / fill price)
- pyramiding = 1 (one position at a time; same-side repeat ignored)
- market entries fill at the NEXT bar open (Pine default on bar close)
- stop / take-profit checked intrabar via bar high/low
- multiple TP legs (scale-out): each leg exits a fraction of the position at its target,
  optionally moving the stop to breakeven after TP1
- reverse on opposite signal (closes the remainder + flips)
- commission (% per order) + slippage (ticks) optional

Feed it the SAME OHLC (symbol + timeframe) you used on TradingView to reconcile.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import pandas as pd

from options_buying.config import SwingConfig
from options_buying.signals import generate_signals


@dataclass
class UTrade:
    side: str
    entry_date: object
    exit_date: object
    entry_price: float
    exit_price: float  # qty-weighted average across legs
    stop_loss: float
    tp1: float
    tp2: float
    tp3: float
    qty: float
    tps_hit: int
    exit_reason: str  # final leg / close reason
    pnl: float
    pnl_pct: float
    equity_after: float


def backtest_underlying(
    df: pd.DataFrame,
    cfg: SwingConfig,
    *,
    initial_capital: float = 1_000_000.0,
    qty_pct: float = 100.0,
    commission_pct: float = 0.0,
    slippage_ticks: float = 0.0,
    tick_size: float = 0.0,
    stop_first: bool = True,
) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Return (trades_df, equity_df, tv_stats). Rows are position-level (aggregated legs)."""
    data = df.copy()
    if "date" in data.columns:
        data = data.set_index("date")
    data = data.sort_index()

    signals = generate_signals(data, cfg)
    sig_by_date = {s.date: s for s in signals}

    o, h, l = data["open"].to_numpy(), data["high"].to_numpy(), data["low"].to_numpy()
    idx = list(data.index)
    slip = slippage_ticks * tick_size

    equity = initial_capital
    position: dict | None = None
    pending = None
    trades: list[UTrade] = []
    eq_points: list[tuple[object, float]] = []

    def _comm(notional: float) -> float:
        return notional * commission_pct / 100.0

    def _fill_leg(price: float, qty: float, when, *, is_long: bool):
        """Realize one leg's qty at `price`; update equity + position accumulators."""
        nonlocal equity
        entry = position["entry"]
        fill = price - slip if is_long else price + slip
        gross = qty * (fill - entry) if is_long else qty * (entry - fill)
        pnl = gross - _comm(qty * entry) - _comm(qty * fill)
        equity += pnl
        position["realized"] += pnl
        position["exit_notional"] += qty * fill
        position["exit_qty"] += qty
        eq_points.append((when, equity))

    def _close(when, reason: str):
        nonlocal position
        exit_qty = position["exit_qty"] or 1.0
        avg_exit = position["exit_notional"] / exit_qty
        tps = position["tp_prices"]
        trades.append(UTrade(
            side=position["side"], entry_date=position["entry_date"], exit_date=when,
            entry_price=round(position["entry"], 4), exit_price=round(avg_exit, 4),
            stop_loss=round(position["sl0"], 4),
            tp1=round(tps[0], 4) if len(tps) > 0 else float("nan"),
            tp2=round(tps[1], 4) if len(tps) > 1 else float("nan"),
            tp3=round(tps[2], 4) if len(tps) > 2 else float("nan"),
            qty=round(position["qty0"], 4), tps_hit=position["tps_hit"],
            exit_reason=reason, pnl=round(position["realized"], 2),
            pnl_pct=round(100 * position["realized"] / initial_capital, 3),
            equity_after=round(equity, 2),
        ))
        position = None

    def _remaining() -> float:
        return sum(q for _, q in position["legs"])

    def _open(sig, price: float, when):
        nonlocal position
        side = "long" if sig.side == "buy" else "short"
        is_long = side == "long"
        fill = price + slip if is_long else price - slip
        qty0 = (equity * qty_pct / 100.0) / fill if fill > 0 else 0.0
        levels = sig.tp_levels or ((sig.take_profit, 1.0),)
        legs, remaining = [], qty0
        for k, (p, frac) in enumerate(levels):
            q = remaining if k == len(levels) - 1 else qty0 * frac
            remaining -= q
            legs.append([p, q])
        position = {
            "side": side, "is_long": is_long, "entry": fill, "sl": sig.stop_loss,
            "sl0": sig.stop_loss, "qty0": qty0, "legs": legs,
            "tp_prices": [p for p, _ in levels], "entry_date": when,
            "realized": 0.0, "exit_notional": 0.0, "exit_qty": 0.0, "tps_hit": 0,
        }

    for i, d in enumerate(idx):
        # 1) intrabar exits on an open position (not on its entry bar)
        if position is not None and d != position["entry_date"]:
            is_long = position["is_long"]
            sl = position["sl"]
            stop_hit = (l[i] <= sl) if is_long else (h[i] >= sl)
            if stop_hit:
                rem = _remaining()
                if rem > 0:
                    _fill_leg(sl, rem, d, is_long=is_long)
                position["legs"] = []
                reason = "stop_loss" if position["tps_hit"] == 0 else f"sl_after_tp{position['tps_hit']}"
                _close(d, reason)
            else:
                while position["legs"]:
                    tp_price, q = position["legs"][0]
                    hit = (h[i] >= tp_price) if is_long else (l[i] <= tp_price)
                    if not hit:
                        break
                    position["legs"].pop(0)
                    _fill_leg(tp_price, q, d, is_long=is_long)
                    position["tps_hit"] += 1
                    if cfg.move_sl_to_be and position["tps_hit"] == 1:
                        position["sl"] = position["entry"]
                if position is not None and not position["legs"]:
                    _close(d, f"tp{position['tps_hit']}")

        # 2) fill pending order at this bar's open
        if pending is not None:
            want = "long" if pending.side == "buy" else "short"
            if position is None:
                _open(pending, o[i], d)
            elif want != position["side"]:
                rem = _remaining()
                if rem > 0:
                    _fill_leg(o[i], rem, d, is_long=position["is_long"])
                position["legs"] = []
                _close(d, "reverse")
                _open(pending, o[i], d)
            pending = None

        # 3) record this bar's signal to fill next bar
        sig = sig_by_date.get(d)
        if sig is not None:
            pending = sig

    if position is not None:
        rem = _remaining()
        if rem > 0:
            _fill_leg(float(data["close"].iloc[-1]), rem, idx[-1], is_long=position["is_long"])
        position["legs"] = []
        _close(idx[-1], "eod")

    trades_df = pd.DataFrame([asdict(t) for t in trades])
    equity_df = pd.DataFrame(eq_points, columns=["date", "equity"])
    if not equity_df.empty:
        equity_df["peak"] = equity_df["equity"].cummax()
        equity_df["drawdown"] = equity_df["equity"] - equity_df["peak"]
        equity_df["drawdown_pct"] = 100 * equity_df["drawdown"] / equity_df["peak"]
    stats = _tv_stats(trades_df, equity_df, initial_capital, equity)
    return trades_df, equity_df, stats


def _tv_stats(trades: pd.DataFrame, equity: pd.DataFrame, initial: float, final: float) -> dict:
    if trades.empty:
        return {"trades": 0, "net_profit": 0.0, "net_profit_pct": 0.0, "max_drawdown": 0.0,
                "max_drawdown_pct": 0.0, "percent_profitable": 0.0, "wins": 0, "profit_factor": 0.0}
    pnl = trades["pnl"]
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    gp, gl = float(wins.sum()), float(-losses.sum())
    return {
        "trades": int(len(trades)),
        "net_profit": round(final - initial, 2),
        "net_profit_pct": round(100 * (final - initial) / initial, 2),
        "max_drawdown": round(float(-equity["drawdown"].min()), 2) if not equity.empty else 0.0,
        "max_drawdown_pct": round(float(-equity["drawdown_pct"].min()), 2) if not equity.empty else 0.0,
        "percent_profitable": round(100 * len(wins) / len(trades), 2),
        "wins": int(len(wins)),
        "profit_factor": round(gp / gl, 3) if gl > 0 else float("inf"),
    }
