from typing import Any

from mural_mcp import client
from mural_mcp.colors import resolve_color


def create_frame(
    name: str,
    x: float,
    y: float,
    width: float,
    height: float,
    border_color: str | None = None,
) -> dict:
    """Create a named frame (zone) on the mural at the given position and size.

    Frames are Mural "area" widgets: cards created with this frame's id as their
    parentId become its children and move with it.
    """
    mid = client.mural_id()
    body: dict[str, Any] = {
        "title": name,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
    }
    if border_color is not None:
        body["style"] = {"borderColor": resolve_color(border_color)}
    result = client.post(f"/murals/{mid}/widgets/area", body)
    return result.get("value", result)


def update_frame(
    frame_id: str,
    name: str | None = None,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    height: float | None = None,
    border_color: str | None = None,
) -> dict:
    """Update a frame's title, position, size, or border colour.

    Needed for incremental growth (a frame gets taller as cards fill it) and for a
    full board reflow, which repositions and resizes every frame.
    """
    mid = client.mural_id()
    body: dict[str, Any] = {}
    if name is not None:
        body["title"] = name
    if x is not None:
        body["x"] = x
    if y is not None:
        body["y"] = y
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    if border_color is not None:
        body["style"] = {"borderColor": resolve_color(border_color)}
    return client.patch(f"/murals/{mid}/widgets/area/{frame_id}", body)


def get_mural(mural_id: str) -> dict:
    """Fetch a mural's metadata (id, title, embedLink) — also a reachability check."""
    result = client.get(f"/murals/{mural_id}")
    return result.get("value", result)
