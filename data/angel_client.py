from pathlib import Path

import os
import pyotp
from SmartApi import SmartConnect
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")

_session: SmartConnect | None = None


def _missing_env_message() -> str:
    return f"""Angel One credentials not configured.

Create {PROJECT_ROOT / ".env"} with:

  ANGEL_API_KEY=your_api_key
  ANGEL_CLIENT_ID=your_client_code
  ANGEL_PIN=your_login_pin
  ANGEL_TOTP_SECRET=your_totp_secret

Get API key: https://smartapi.angelone.in/ → My Apps → Create App
Client ID / PIN: your Angel One login
TOTP secret: from authenticator setup (or re-setup 2FA to capture secret)

Copy the template: cp .env.example .env
"""


def get_angel_client() -> SmartConnect:
    global _session

    api_key = os.environ.get("ANGEL_API_KEY")
    client_id = os.environ.get("ANGEL_CLIENT_ID")
    pin = os.environ.get("ANGEL_PIN")
    totp_secret = os.environ.get("ANGEL_TOTP_SECRET")

    if not all([api_key, client_id, pin, totp_secret]):
        raise RuntimeError(_missing_env_message())

    if _session is not None:
        return _session

    client = SmartConnect(api_key=api_key)
    totp = pyotp.TOTP(totp_secret).now()
    response = client.generateSession(client_id, pin, totp)

    if not response.get("status"):
        message = response.get("message", response)
        raise RuntimeError(f"Angel One login failed: {message}")

    _session = client
    return client
