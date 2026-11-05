import math

from mural_mcp import client
from mural_mcp.tools.query import list_cards


def _grid_positions(
    count: int,
    card_width: float,
    card_height: float,
    padding: float,
    start_x: float,
    start_y: float,
) -> list[tuple[float, float]]:
    """Compute (x, y) centre positions for `count` items arranged in a grid."""
    cols = max(1, math.ceil(math.sqrt(count)))
    positions: list[tuple[float, float]] = []
    for i in range(count):
        col = i % cols
        row = i // cols
        x = start_x + col * (card_width + padding) + card_width / 2
        y = start_y + row * (card_height + padding) + card_height / 2
        positions.append((x, y))
    return positions


def auto_layout(
    padding: float = 20,
    card_width: float = 200,
    card_height: float = 200,
    start_x: float = 0,
    start_y: float = 0,
) -> dict:
    """Redistribute all sticky-note cards on the mural into an even grid.

    Cards are arranged left-to-right, top-to-bottom starting at (start_x, start_y).
    Returns a summary with the number of cards moved.
    """
    mid = client.mural_id()
    cards = list_cards()
    if not cards:
        return {"moved": 0, "message": "No cards found on the mural."}

    positions = _grid_positions(
        len(cards), card_width, card_height, padding, start_x, start_y
    )
    moved = 0
    errors: list[str] = []
    for card, (x, y) in zip(cards, positions):
        widget_id = card.get("id")
        if not widget_id:
            continue
        try:
            client.patch(
                f"/murals/{mid}/widgets/sticky-note/{widget_id}",
                {"x": x, "y": y, "width": card_width, "height": card_height},
            )
            moved += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{widget_id}: {exc}")

    result: dict = {"moved": moved, "total": len(cards)}
    if errors:
        result["errors"] = errors
    return result


def auto_layout_in_frame(frame_id: str, padding: float = 20) -> dict:
    """Redistribute sticky-note cards inside a specific frame into an even grid.

    Card width and height are preserved from each card's existing dimensions,
    falling back to 200×200 px when not present.
    Positions are computed relative to the frame's top-left corner.
    """
    mid = client.mural_id()

    # Fetch frame details to get its bounds.
    frame_response = client.get(f"/murals/{mid}/widgets", params={"type": "area"})
    frames = frame_response.get("value", [])
    frame = next((f for f in frames if f.get("id") == frame_id), None)
    if frame is None:
        return {"moved": 0, "message": f"Frame '{frame_id}' not found."}

    frame_x: float = frame.get("x", 0)
    frame_y: float = frame.get("y", 0)

    cards = list_cards(frame_id=frame_id)
    if not cards:
        return {"moved": 0, "message": "No cards found in this frame."}

    # Use the first card's dimensions as the common card size.
    card_width: float = cards[0].get("width", 200)
    card_height: float = cards[0].get("height", 200)

    positions = _grid_positions(
        len(cards), card_width, card_height, padding, frame_x, frame_y
    )
    moved = 0
    errors: list[str] = []
    for card, (x, y) in zip(cards, positions):
        widget_id = card.get("id")
        if not widget_id:
            continue
        try:
            client.patch(
                f"/murals/{mid}/widgets/sticky-note/{widget_id}",
                {"x": x, "y": y},
            )
            moved += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{widget_id}: {exc}")

    result: dict = {"moved": moved, "total": len(cards), "frame_id": frame_id}
    if errors:
        result["errors"] = errors
    return result
