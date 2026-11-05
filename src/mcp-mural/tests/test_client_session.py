"""Runtime target/token overrides and 429 handling in mural_mcp.client."""

import httpx
import pytest

from mural_mcp import client


@pytest.fixture(autouse=True)
def _reset_overrides():
    """Overrides are module-level; keep tests independent of each other."""
    client.set_target("")
    client.set_access_token("")
    yield
    client.set_target("")
    client.set_access_token("")


def test_set_target_overrides_env(monkeypatch):
    monkeypatch.setenv("MURAL_ID", "from-env")
    assert client.mural_id() == "from-env"

    client.set_target("workspace.12345")
    assert client.mural_id() == "workspace.12345"


def test_set_target_empty_falls_back_to_env(monkeypatch):
    monkeypatch.setenv("MURAL_ID", "from-env")
    client.set_target("workspace.12345")
    client.set_target("")
    assert client.mural_id() == "from-env"


def test_mural_id_raises_when_unset(monkeypatch):
    monkeypatch.delenv("MURAL_ID", raising=False)
    with pytest.raises(RuntimeError, match="set_target"):
        client.mural_id()


def test_set_auth_takes_priority_over_static_and_refresh(monkeypatch):
    monkeypatch.setenv("MURAL_API_TOKEN", "static-token")
    assert client._token() == "static-token"

    client.set_access_token("pushed-token")
    assert client._token() == "pushed-token"


def test_send_retries_once_on_429(monkeypatch):
    """A 429 is waited out once; the retry's result is what callers see."""
    monkeypatch.setenv("MURAL_API_TOKEN", "t")
    monkeypatch.setattr(client.time, "sleep", lambda _s: None)

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"X-RateLimit-Reset": "2"}, json={})
        return httpx.Response(200, json={"value": {"ok": True}})

    _patch_transport(monkeypatch, handler)

    assert client.get("/murals/x") == {"value": {"ok": True}}
    assert len(calls) == 2


def test_send_gives_up_after_one_retry(monkeypatch):
    """Two 429s in a row surface as an error rather than stalling a caller."""
    monkeypatch.setenv("MURAL_API_TOKEN", "t")
    monkeypatch.setattr(client.time, "sleep", lambda _s: None)

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(429, json={})

    _patch_transport(monkeypatch, handler)

    with pytest.raises(client.MuralAPIError) as excinfo:
        client.get("/murals/x")
    assert excinfo.value.status_code == 429
    assert len(calls) == 2


def test_send_does_not_retry_non_429(monkeypatch):
    monkeypatch.setenv("MURAL_API_TOKEN", "t")

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(404, json={})

    _patch_transport(monkeypatch, handler)

    with pytest.raises(client.MuralAPIError) as excinfo:
        client.get("/murals/x")
    assert excinfo.value.status_code == 404
    assert len(calls) == 1


def test_delete_tolerates_empty_204(monkeypatch):
    monkeypatch.setenv("MURAL_API_TOKEN", "t")
    _patch_transport(monkeypatch, lambda _r: httpx.Response(204))
    assert client.delete("/murals/x/widgets/w") == {"status": "deleted"}


def _patch_transport(monkeypatch, handler):
    """Route every httpx.Client created inside client.py through `handler`."""
    real_init = httpx.Client.__init__

    def init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", init)
