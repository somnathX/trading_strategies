from __future__ import annotations

import os
from pathlib import Path

import pyotp
from dhanhq import DhanContext, dhanhq
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")

_client: dhanhq | None = None


def _missing_env_message() -> str:
    return f"""Dhan credentials not configured.

Create {PROJECT_ROOT / ".env"} with:

  DHAN_CLIENT_ID=your_client_id
  DHAN_ACCESS_TOKEN=your_access_token

Get these from https://web.dhan.co → My Profile → DhanHQ Trading APIs
  - Subscribe to Data API (₹499+tax/month) for historical candles
  - Generate / copy Access Token (valid ~24h, renew daily)
  - Client ID is shown on the same page

Or use PIN + TOTP instead of a static token:

  DHAN_CLIENT_ID=your_client_id
  DHAN_PIN=your_4_digit_pin
  DHAN_TOTP_SECRET=your_totp_secret

Copy the template: cp .env.example .env
"""


def _format_dhan_error(response: dict) -> str:
    remarks = response.get("remarks", response)
    if isinstance(remarks, dict):
        code = remarks.get("error_code", "")
        message = remarks.get("error_message", str(remarks))
        if code == "DH-902":
            return (
                f"{code}: {message}\n\n"
                "Your Dhan login works, but Data API is not active.\n"
                "Fix: web.dhan.co → My Profile → DhanHQ Trading APIs\n"
                "  1. Subscribe to Data API (₹499+tax/month, needs ledger balance)\n"
                "  2. Regenerate access token after subscription is active\n"
            )
        return f"{code}: {message}" if code else str(message)
    return str(remarks)


def _resolve_access_token(client_id: str) -> str:
    token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    if token:
        return token

    pin = os.environ.get("DHAN_PIN", "").strip()
    totp_secret = os.environ.get("DHAN_TOTP_SECRET", "").strip()
    if not pin or not totp_secret:
        raise RuntimeError(_missing_env_message())

    ctx = DhanContext(client_id, "")
    totp = pyotp.TOTP(totp_secret).now()
    response = ctx.get_dhan_login().generate_token(pin, totp)
    token = response.get("accessToken") or response.get("access_token")
    if not token:
        raise RuntimeError(f"Dhan PIN/TOTP login failed: {response}")
    return token


def get_dhan_client() -> dhanhq:
    global _client

    client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
    if not client_id:
        raise RuntimeError(_missing_env_message())

    if _client is not None:
        return _client

    access_token = _resolve_access_token(client_id)
    ctx = DhanContext(client_id, access_token)
    _client = dhanhq(ctx)
    return _client


def check_dhan_response(response: dict, context: str) -> dict:
    if response.get("status") != "success":
        raise RuntimeError(f"Dhan API failed ({context}): {_format_dhan_error(response)}")
    return response.get("data") or {}
