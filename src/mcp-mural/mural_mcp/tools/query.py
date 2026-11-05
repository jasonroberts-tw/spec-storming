from mural_mcp import client
from mural_mcp.colors import resolve_color


def _paginate_widgets(mid: str, params: dict) -> list[dict]:
    """Fetch all pages of widgets for a given query."""
    results: list[dict] = []
    next_token: str | None = None
    while True:
        if next_token:
            params = {**params, "next": next_token}
        response = client.get(f"/murals/{mid}/widgets", params=params)
        items = response.get("value", [])
        results.extend(items)
        next_token = response.get("next")
        if not next_token:
            break
    return results


def list_cards(frame_id: str | None = None) -> list[dict]:
    """List all sticky-note cards on the mural.

    Optionally filter to only cards inside a specific frame by frame_id.
    """
    mid = client.mural_id()
    params: dict = {"type": "sticky_note"}
    if frame_id:
        params["parentId"] = frame_id
    return _paginate_widgets(mid, params)


def list_cards_by_color(color: str, frame_id: str | None = None) -> list[dict]:
    """List sticky-note cards whose background color matches the given named color.

    color must be a named color (e.g. 'yellow', 'pink').
    Optionally scope to a specific frame via frame_id.
    """
    target_hex = resolve_color(color)
    cards = list_cards(frame_id=frame_id)
    return [
        c for c in cards
        if c.get("style", {}).get("backgroundColor", "").upper() == target_hex.upper()
    ]


def list_frames() -> list[dict]:
    """List all frames (zones/areas) on the mural."""
    mid = client.mural_id()
    return _paginate_widgets(mid, {"type": "area"})


def list_widgets(widget_type: str | None = None) -> list[dict]:
    """List all widgets on the mural, optionally filtered by type.

    Valid widget_type values: sticky_note, shape, text, connector, area,
    image, title, mindmap_node, doc.
    """
    mid = client.mural_id()
    params: dict = {}
    if widget_type:
        params["type"] = widget_type
    return _paginate_widgets(mid, params)


def list_widgets_by_color(color: str, widget_type: str | None = None) -> list[dict]:
    """List widgets whose background color matches the given named color.

    color must be a named color (e.g. 'blue', 'green').
    Optionally filter by widget_type as well.
    """
    target_hex = resolve_color(color)
    widgets = list_widgets(widget_type=widget_type)
    return [
        w for w in widgets
        if w.get("style", {}).get("backgroundColor", "").upper() == target_hex.upper()
    ]
