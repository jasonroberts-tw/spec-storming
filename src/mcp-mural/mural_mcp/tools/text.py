from typing import Any

from mural_mcp import client


def create_text(
    text: str,
    x: float,
    y: float,
    width: float | None = None,
    height: float | None = None,
) -> dict:
    """Create a free text label on the mural."""
    mid = client.mural_id()
    body: dict[str, Any] = {
        "text": text,
        "x": x,
        "y": y,
    }
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    return client.post(f"/murals/{mid}/widgets/text", body)
