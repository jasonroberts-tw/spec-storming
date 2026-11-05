"""One-time OAuth2 authorization code flow to obtain a refresh_token.

Run once:
    uv run python -m mural_mcp.auth

It will:
  1. Print the Mural authorization URL — open it in your browser
  2. After you approve, Mural redirects to localhost:9999 with ?code=...
  3. This script exchanges the code for access_token + refresh_token
  4. Appends refresh_token to mural_mcp/.env automatically
"""

import os
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
from dotenv import load_dotenv

_ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

_TOKEN_URL = "https://app.mural.co/api/public/v1/authorization/oauth2/token"
_AUTH_URL = "https://app.mural.co/api/public/v1/authorization/oauth2/"
_REDIRECT_URI = "http://localhost:9999/callback"
_PORT = 9999

_auth_code: str | None = None


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        global _auth_code
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        _auth_code = params.get("code", [None])[0]
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"<h2>Authorization complete. You can close this tab.</h2>")

    def log_message(self, *_):  # suppress request logs
        pass


def main() -> None:
    client_id = os.environ.get("client_id", "")
    secret_key = os.environ.get("secret_key", "")
    if not client_id or not secret_key:
        raise SystemExit("client_id and secret_key must be set in mural_mcp/.env")

    auth_params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": _REDIRECT_URI,
        "response_type": "code",
        "scope": "murals:read murals:write",
    })
    auth_link = f"{_AUTH_URL}?{auth_params}"

    print("\nOpen this URL in your browser to authorize:\n")
    print(f"  {auth_link}\n")
    webbrowser.open(auth_link)

    print(f"Waiting for callback on http://localhost:{_PORT}/callback ...")
    server = HTTPServer(("localhost", _PORT), _CallbackHandler)
    server.handle_request()  # handle exactly one request then stop

    if not _auth_code:
        raise SystemExit("No authorization code received.")

    print("Exchanging code for tokens ...")
    with httpx.Client() as http:
        resp = http.post(
            _TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "client_secret": secret_key,
                "redirect_uri": _REDIRECT_URI,
                "code": _auth_code,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )

    if resp.status_code >= 400:
        raise SystemExit(f"Token exchange failed {resp.status_code}: {resp.text}")

    payload = resp.json()
    refresh_token = payload.get("refresh_token", "")
    access_token = payload.get("access_token", "")

    if not refresh_token:
        raise SystemExit(f"No refresh_token in response: {payload}")

    # Append or update refresh_token in .env
    env_text = _ENV_PATH.read_text()
    if "refresh_token=" in env_text:
        lines = [
            f"refresh_token={refresh_token}" if l.startswith("refresh_token=") else l
            for l in env_text.splitlines()
        ]
        _ENV_PATH.write_text("\n".join(lines) + "\n")
    else:
        with _ENV_PATH.open("a") as f:
            f.write(f"\nrefresh_token={refresh_token}\n")

    print(f"\nSuccess! refresh_token saved to {_ENV_PATH}")
    print(f"access_token (valid ~15 min): {access_token[:40]}...")
    print("\nYou can now start the MCP server — it will refresh tokens automatically.")


if __name__ == "__main__":
    main()
