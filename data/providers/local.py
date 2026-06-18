from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd
import pytz

from config import IST, Instrument, MARKET_CLOSE, MARKET_OPEN
from data.fetcher import session_time_mask

DATA_FILES = {
    "5": Path("data/nifty_5min/data.parquet"),
    "15": Path("data/nifty_15min/data.parquet"),
}


def _load_file(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise RuntimeError(
            f"Local data file missing: {path}\n"
            "Fetch from branch: git checkout add-market-data -- data/nifty_5min data/nifty_15min"
        )

    df = pd.read_parquet(path)
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])
        df = df.set_index("date")
    else:
        df.index = pd.to_datetime(df.index)

    if df.index.tz is None:
        df.index = df.index.tz_localize(pytz.timezone(IST))
    else:
        df.index = df.index.tz_convert(IST)

    return df.sort_index()


def available_range(interval: str = "5") -> tuple[pd.Timestamp, pd.Timestamp]:
    df = _load_file(DATA_FILES[interval])
    return df.index.min(), df.index.max()


def fetch_intraday(
    from_date: date,
    to_date: date,
    instrument: Instrument | None = None,
    interval: str = "5",
    use_cache: bool = True,
) -> pd.DataFrame:
    from data.instruments import NIFTY

    instrument = instrument or NIFTY
    if instrument.name != "NIFTY":
        raise ValueError(
            f"Local parquet only has NIFTY. Use --provider dhan for {instrument.name}."
        )

    path = DATA_FILES.get(interval)
    if not path:
        raise ValueError(
            f"Local data has intervals {list(DATA_FILES)} only. "
            f"Requested '{interval}'. Use --interval 5 or 15."
        )

    df = _load_file(path)
    tz = pytz.timezone(IST)
    start = pd.Timestamp(from_date, tz=tz)
    end = pd.Timestamp(to_date, tz=tz) + pd.Timedelta(days=1)
    out = df.loc[start:end]
    out = out[session_time_mask(out.index)]

    if out.empty:
        data_start, data_end = df.index.min(), df.index.max()
        raise RuntimeError(
            f"No local candles for {from_date}→{to_date}.\n"
            f"Available: {data_start.date()} → {data_end.date()}"
        )

    return out.copy()
