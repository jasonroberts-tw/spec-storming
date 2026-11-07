from typing import Any

from mural_mcp import client
from mural_mcp.colors import resolve_color

_VALID_SHAPES = {"rectangle", "diamond"}


def create_shape(
    shape_type: str,
    x: float,
    y: float,
    width: float,
    height: float,
    color: str | None = None,
    text: str | None = None,
) -> dict:
    """Create a shape widget (rectangle or diamond) on the mural.

    shape_type must be 'rectangle' or 'diamond'.
    color is a named color (e.g. 'blue', 'gray').
    """
    if shape_type not in _VALID_SHAPES:
        raise ValueError(
            f"shape_type must be one of {sorted(_VALID_SHAPES)}, got '{shape_type}'"
        )
    mid = client.mural_id()
    body: dict[str, Any] = {
        "shape": shape_type,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
    }
    if color is not None:
        body["style"] = {"backgroundColor": resolve_color(color)}
    if text is not None:
        body["text"] = text
    return client.post(f"/murals/{mid}/widgets/shape", body)
