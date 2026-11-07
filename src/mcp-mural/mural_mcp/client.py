import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / ".env")

_BASE = "https://app.mural.co/api/public/v1"
_TOKEN_URL = "https://app.mural.co/api/public/v1/authorization/oauth2/token"

# In-memory token cache: (access_token, expires_at_monotonic)
_token_cache: tuple[str, float] | None = None

# Runtime overrides pushed by an embedding host (see tools set_target / set_auth).
# When the SpecStorming server drives this process it owns OAuth and board binding,
# so both the MURAL_ID and the token come from it rather than from .env.
_target_override: str | None = None
_access_token_override: str | None = None


def set_target(mural_id: str) -> None:
    """Point every subsequent call at *mural_id*, overriding MURAL_ID from .env."""
    global _target_override
    _target_override = mural_id or None


def set_access_token(access_token: str) -> None:
    """Use *access_token* for every subsequent call, overriding the OAuth refresh flow.

    Mural access tokens live ~15 minutes, so a host using this is expected to push a
    fresh one regularly rather than relying on the internal refresh.
    """
    global _access_token_override
    _access_token_override = access_token or None


class MuralAPIError(Exception):
    def __init__(self, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"Mural API error {status_code}: {body}")


def _refresh_access_token() -> tuple[str, float]:
    """Use the stored refresh_token to obtain a new access_token.

    Mural tokens expire after 15 minutes; we refresh 60 s early.
    Requires refresh_token, client_id, and secret_key in .env.
    """
    client_id = os.environ.get("client_id", "")
    secret_key = os.environ.get("secret_key", "")
    refresh_token = os.environ.get("refresh_token", "")
    if not all([client_id, secret_key, refresh_token]):
        raise RuntimeError(
            "client_id, secret_key, and refresh_token must all be set in .env.\n"
            "Run the one-time OAuth setup to obtain a refresh_token:\n"
            "  uv run python -m mural_mcp.auth"
        )
    with httpx.Client() as http:
        resp = http.post(
            _TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "client_secret": secret_key,
                "refresh_token": refresh_token,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
    if resp.status_code >= 400:
        raise MuralAPIError(resp.status_code, resp.text)
    payload = resp.json()
    access_token = payload["access_token"]
    expires_in = int(payload.get("expires_in", 900))  # Mural default: 15 min
    expires_at = time.monotonic() + expires_in - 60
    return access_token, expires_at


def _token() -> str:
    """Return a valid Bearer token, refreshing automatically when expired.

    Priority:
    1. MURAL_API_TOKEN env var (static override — useful for short-lived testing)
    2. refresh_token + client_id + secret_key → auto-refresh via OAuth2
    """
    global _token_cache

    if _access_token_override:
        return _access_token_override

    static = os.environ.get("MURAL_API_TOKEN", "")
    if static:
        return static

    if _token_cache is None or time.monotonic() >= _token_cache[1]:
        _token_cache = _refresh_access_token()

    return _token_cache[0]


def mural_id() -> str:
    if _target_override:
        return _target_override

    mid = os.environ.get("MURAL_ID", "")
    if not mid:
        raise RuntimeError(
            "No target mural. Either call the set_target tool, or copy "
            ".env.example to .env and fill in MURAL_ID."
        )
    return mid


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code >= 400:
        raise MuralAPIError(response.status_code, response.text)


def _send(
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json: dict | list | None = None,
) -> httpx.Response:
    """Issue one request, waiting out a single 429 before giving up.

    Mural allows 25 req/s per user; a batched array counts as one request, so at
    session scale only a burst of individual PATCHes can trip the limit. One
    wait-and-retry (capped at 5s) is enough — anything worse should surface as an
    error rather than stall a projection pass.
    """
    with httpx.Client() as client:
        for attempt in (0, 1):
            response = client.request(
                method,
                f"{_BASE}{path}",
                headers=_headers(),
                params=params or {},
                json=json,
                timeout=30,
            )
            if response.status_code != 429 or attempt == 1:
                return response
            reset = response.headers.get("X-RateLimit-Reset", "1")
            try:
                delay = float(reset)
            except ValueError:
                delay = 1.0
            time.sleep(min(max(delay, 1.0), 5.0))
    return response


def get(path: str, params: dict | None = None) -> dict:
    response = _send("GET", path, params=params)
    _raise_for_status(response)
    return response.json()


def post(path: str, body: dict | list) -> dict:
    response = _send("POST", path, json=body)
    _raise_for_status(response)
    return response.json()


def patch(path: str, body: dict) -> dict:
    response = _send("PATCH", path, json=body)
    _raise_for_status(response)
    return response.json()


def delete(path: str) -> dict:
    response = _send("DELETE", path)
    _raise_for_status(response)
    if response.status_code == 204 or not response.content:
        return {"status": "deleted"}
    return response.json()
