from typing import Any

from mural_mcp import client
from mural_mcp.colors import resolve_color

_DEFAULT_WIDTH = 200
_DEFAULT_HEIGHT = 200


def _card_body(
    text: str,
    color: str,
    x: float,
    y: float,
    width: float | None,
    height: float | None,
    frame_id: str | None,
    rotation: float | None = None,
    italic: bool | None = None,
) -> dict[str, Any]:
    style: dict[str, Any] = {"backgroundColor": resolve_color(color)}
    if italic:
        style["italic"] = True
    body: dict[str, Any] = {
        "text": text,
        "x": x,
        "y": y,
        "width": width if width is not None else _DEFAULT_WIDTH,
        "height": height if height is not None else _DEFAULT_HEIGHT,
        "shape": "rectangle",
        "style": style,
    }
    if rotation:
        body["rotation"] = rotation
    # Child coordinates are relative to the parent area, not the board.
    if frame_id:
        body["parentId"] = frame_id
    return body


def create_card(
    text: str,
    color: str = "yellow",
    x: float = 0,
    y: float = 0,
    width: float | None = None,
    height: float | None = None,
    frame_id: str | None = None,
    rotation: float | None = None,
    italic: bool | None = None,
) -> dict:
    """Create a single sticky-note card on the mural."""
    mid = client.mural_id()
    body = [_card_body(text, color, x, y, width, height, frame_id, rotation, italic)]
    result = client.post(f"/murals/{mid}/widgets/sticky-note", body)
    items = result.get("value", result)
    return items[0] if isinstance(items, list) else items


def create_cards_bulk(cards: list[dict]) -> list[dict]:
    """Create multiple sticky-note cards in a single API call.

    Each card dict may contain: text, color, x, y, width, height, frame_id,
    rotation, italic.
    """
    mid = client.mural_id()
    body = [
        _card_body(
            text=c["text"],
            color=c.get("color", "yellow"),
            x=c.get("x", 0),
            y=c.get("y", 0),
            width=c.get("width"),
            height=c.get("height"),
            frame_id=c.get("frame_id"),
            rotation=c.get("rotation"),
            italic=c.get("italic"),
        )
        for c in cards
    ]
    result = client.post(f"/murals/{mid}/widgets/sticky-note", body)
    return result.get("value", result)


def update_card(
    card_id: str,
    text: str | None = None,
    color: str | None = None,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    height: float | None = None,
    frame_id: str | None = None,
    rotation: float | None = None,
    italic: bool | None = None,
) -> dict:
    """Update one or more fields of an existing sticky-note card.

    Pass frame_id to move the card into a different frame. Because child
    coordinates are relative to the parent, send x/y alongside frame_id.
    """
    mid = client.mural_id()
    body: dict[str, Any] = {}
    if text is not None:
        body["text"] = text
    if color is not None or italic is not None:
        style: dict[str, Any] = {}
        if color is not None:
            style["backgroundColor"] = resolve_color(color)
        if italic is not None:
            style["italic"] = italic
        body["style"] = style
    if x is not None:
        body["x"] = x
    if y is not None:
        body["y"] = y
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    if frame_id is not None:
        # Empty string is the explicit "detach from any frame" signal — Mural clears
        # the parent on null, which JSON-null cannot express through an optional arg.
        body["parentId"] = frame_id if frame_id else None
    if rotation is not None:
        body["rotation"] = rotation
    return client.patch(f"/murals/{mid}/widgets/sticky-note/{card_id}", body)


def delete_card(card_id: str) -> dict:
    """Delete a sticky-note card by its widget ID."""
    return delete_widget(card_id)


def delete_widget(widget_id: str) -> dict:
    """Delete any widget (card, frame, connector, …) by its widget ID."""
    mid = client.mural_id()
    return client.delete(f"/murals/{mid}/widgets/{widget_id}")
