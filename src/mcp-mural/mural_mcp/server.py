"""Mural MCP server — exposes Mural board operations as MCP tools."""

from mcp.server.fastmcp import FastMCP

from event_storming.layout import assign_layout
from event_storming.renderer import apply_diagram
from event_storming.schema import EventStormDiagram
from event_storming import state_store
from event_storming.state_store import default_path
from mural_mcp.tools.connectors import create_connector
from event_storming.tools import (
    add_aggregate,
    add_actor,
    add_command,
    add_event,
    add_external,
    add_hotspot,
    add_policy,
    add_read_model,
)
from mural_mcp import client
from mural_mcp.tools.cards import (
    create_card,
    create_cards_bulk,
    delete_card,
    delete_widget,
    update_card,
)
from mural_mcp.tools.frames import create_frame, get_mural, update_frame
from mural_mcp.tools.layout import auto_layout, auto_layout_in_frame
from mural_mcp.tools.query import (
    list_cards,
    list_cards_by_color,
    list_frames,
    list_widgets,
    list_widgets_by_color,
)
from mural_mcp.tools.shapes import create_shape
from mural_mcp.tools.text import create_text

mcp = FastMCP("mural")

# ── Session (host-driven target board and credentials) ─────────────────────────
#
# Standalone use (Cursor) reads MURAL_ID and the OAuth refresh_token from
# mural_mcp/.env. An embedding host that owns its own OAuth and lets users bind a
# board per session pushes both in at runtime with these two tools instead.

@mcp.tool()
def tool_set_target(mural_id: str) -> dict:
    """Point every subsequent board operation at the given mural.

    Overrides MURAL_ID from .env for the lifetime of this server process.
    Call this after binding a session to a board.
    """
    client.set_target(mural_id)
    return {"mural_id": mural_id}


@mcp.tool()
def tool_set_auth(access_token: str) -> dict:
    """Use the given Mural access token for every subsequent board operation.

    Overrides the internal OAuth refresh flow, for hosts that already hold Mural
    credentials. Mural access tokens expire after ~15 minutes, so push a fresh one
    regularly rather than once at startup.
    """
    client.set_access_token(access_token)
    return {"ok": True}


@mcp.tool()
def tool_get_mural(mural_id: str) -> dict:
    """Fetch a mural's metadata (id, title, embedLink).

    Doubles as a reachability/authorization check before binding to a board.
    embedLink is absent unless embedding is enabled on that mural.
    """
    return get_mural(mural_id)


# ── Cards ──────────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_create_card(
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
    """Create a single sticky-note card on the Mural board.

    color is either a named color (yellow, orange, blue, purple, pink, green,
    red, white, gray, teal, lime, brown) or an 8-digit '#RRGGBBAA' hex string.
    x and y are the centre coordinates of the card in pixels — relative to the
    parent frame when frame_id is given, otherwise relative to the board.
    width and height default to 200×200 px when omitted.
    frame_id places the card inside an existing frame/zone.
    rotation tilts the card in degrees; italic renders its text italic.
    """
    return create_card(text, color, x, y, width, height, frame_id, rotation, italic)


@mcp.tool()
def tool_create_cards_bulk(cards: list[dict]) -> list[dict]:
    """Create multiple sticky-note cards in a single API call.

    Each item in `cards` is an object with keys:
      text (required), color, x, y, width, height, frame_id, rotation, italic.
    Returns the list of created widget objects, in input order.
    """
    return create_cards_bulk(cards)


@mcp.tool()
def tool_update_card(
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

    Only the fields you provide will be changed; all others remain unchanged.
    card_id is the widget ID returned when the card was created.
    frame_id moves the card into a different frame — because child coordinates
    are relative to the parent, send x and y alongside it.
    """
    return update_card(
        card_id, text, color, x, y, width, height, frame_id, rotation, italic
    )


@mcp.tool()
def tool_delete_card(card_id: str) -> dict:
    """Delete a sticky-note card from the Mural board by its widget ID."""
    return delete_card(card_id)


@mcp.tool()
def tool_delete_widget(widget_id: str) -> dict:
    """Delete any widget — card, frame, connector, shape — by its widget ID."""
    return delete_widget(widget_id)


# ── Frames ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_create_frame(
    name: str,
    x: float,
    y: float,
    width: float,
    height: float,
    border_color: str | None = None,
) -> dict:
    """Create a named frame (zone) on the Mural board.

    Cards can be placed inside a frame by passing its ID as frame_id when creating
    or updating a card; they then move with the frame.
    x and y are the top-left corner of the frame; width and height define its size.
    border_color is a named color or an 8-digit '#RRGGBBAA' hex string.
    """
    return create_frame(name, x, y, width, height, border_color)


@mcp.tool()
def tool_update_frame(
    frame_id: str,
    name: str | None = None,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    height: float | None = None,
    border_color: str | None = None,
) -> dict:
    """Update an existing frame's title, position, size, or border colour.

    Only the fields you provide will be changed. Use this to grow a frame as cards
    fill it, or to reposition frames during a full board reflow.
    """
    return update_frame(frame_id, name, x, y, width, height, border_color)


# ── Shapes ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_create_shape(
    shape_type: str,
    x: float,
    y: float,
    width: float,
    height: float,
    color: str | None = None,
    text: str | None = None,
) -> dict:
    """Create a shape widget on the Mural board.

    shape_type must be 'rectangle' or 'diamond'.
    color is an optional named color (yellow, blue, gray, etc.).
    text is optional label text rendered inside the shape.
    x and y are the centre coordinates of the shape.
    """
    return create_shape(shape_type, x, y, width, height, color, text)


# ── Text ───────────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_create_text(
    text: str,
    x: float,
    y: float,
    width: float | None = None,
    height: float | None = None,
) -> dict:
    """Create a free-standing text label on the Mural board.

    x and y are the top-left position of the text box.
    width and height are optional; Mural auto-sizes when omitted.
    """
    return create_text(text, x, y, width, height)


# ── Query ──────────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_list_cards(frame_id: str | None = None) -> list[dict]:
    """List all sticky-note cards on the Mural board.

    Pass frame_id to scope the results to a specific frame/zone.
    Each returned dict includes id, text, x, y, width, height, and style.
    """
    return list_cards(frame_id)


@mcp.tool()
def tool_list_cards_by_color(color: str, frame_id: str | None = None) -> list[dict]:
    """List sticky-note cards whose background color matches the given named color.

    color must be one of: yellow, orange, blue, purple, pink, green,
    red, white, gray, teal, lime, brown.
    Optionally scope to a specific frame via frame_id.
    """
    return list_cards_by_color(color, frame_id)


@mcp.tool()
def tool_list_frames() -> list[dict]:
    """List all frames (zones/areas) on the Mural board.

    Returns each frame's id, title, x, y, width, and height.
    Use the id to scope card operations to that frame.
    """
    return list_frames()


@mcp.tool()
def tool_list_widgets(widget_type: str | None = None) -> list[dict]:
    """List all widgets on the Mural board, optionally filtered by type.

    Valid widget_type values: sticky_note, shape, text, connector,
    area, image, title, mindmap_node, doc.
    Omit widget_type to retrieve every widget on the board.
    """
    return list_widgets(widget_type)


@mcp.tool()
def tool_list_widgets_by_color(
    color: str, widget_type: str | None = None
) -> list[dict]:
    """List widgets whose background color matches the given named color.

    color must be a named color (e.g. 'blue', 'green').
    Optionally filter by widget_type as well.
    """
    return list_widgets_by_color(color, widget_type)


# ── Layout ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_auto_layout(
    padding: float = 20,
    card_width: float = 200,
    card_height: float = 200,
    start_x: float = 0,
    start_y: float = 0,
) -> dict:
    """Redistribute all sticky-note cards into an even grid layout.

    Cards are arranged left-to-right, top-to-bottom starting at (start_x, start_y).
    padding controls the gap between cards in pixels.
    card_width and card_height set the uniform size applied to every card.
    Returns a dict with 'moved' and 'total' counts, plus any 'errors'.
    """
    return auto_layout(padding, card_width, card_height, start_x, start_y)


@mcp.tool()
def tool_auto_layout_in_frame(frame_id: str, padding: float = 20) -> dict:
    """Redistribute sticky-note cards inside a specific frame into an even grid.

    frame_id is the widget ID of the target frame/zone.
    padding controls the gap between cards in pixels.
    Card size is inferred from the first card found in the frame.
    Returns a dict with 'moved', 'total', and 'frame_id'.
    """
    return auto_layout_in_frame(frame_id, padding)


# ── Event Storming ─────────────────────────────────────────────────────────────

@mcp.tool()
def tool_es_event(name: str) -> dict:
    """Add a Domain Event card (orange) to the Mural board.

    The card is placed immediately to the right of the last orange card,
    aligned to the same vertical position, with a small gap so cards
    never overlap.  Use this when something meaningful happened in the domain.
    Example: 'Order Placed', 'Payment Confirmed', 'Item Shipped'.
    """
    return add_event(name)


@mcp.tool()
def tool_es_command(name: str) -> dict:
    """Add a Command card (blue) to the Mural board.

    Placed to the right of the last blue card.
    Commands represent intent — an actor or system asking for something to happen.
    Example: 'Place Order', 'Confirm Payment', 'Ship Item'.
    """
    return add_command(name)


@mcp.tool()
def tool_es_aggregate(name: str) -> dict:
    """Add an Aggregate card (yellow) to the Mural board.

    Placed to the right of the last yellow card.
    Aggregates are business entities that enforce invariants and own state.
    Example: 'Order', 'Customer', 'Inventory Item'.
    """
    return add_aggregate(name)


@mcp.tool()
def tool_es_policy(name: str) -> dict:
    """Add a Policy card (purple) to the Mural board.

    Placed to the right of the last purple card.
    Policies are reaction rules: 'Whenever X happens, do Y'.
    Example: 'Whenever Payment Confirmed → Reserve Inventory'.
    """
    return add_policy(name)


@mcp.tool()
def tool_es_read_model(name: str) -> dict:
    """Add a Read Model card (green) to the Mural board.

    Placed to the right of the last green card.
    Read models are the data projections or views that actors use to make decisions.
    Example: 'Order Summary', 'Inventory Dashboard'.
    """
    return add_read_model(name)


@mcp.tool()
def tool_es_external(name: str) -> dict:
    """Add an External System card (pink) to the Mural board.

    Placed to the right of the last pink card.
    External systems are third-party services or bounded contexts outside the core domain.
    Example: 'Payment Gateway', 'Email Service', 'Shipping Provider'.
    """
    return add_external(name)


@mcp.tool()
def tool_es_actor(name: str) -> dict:
    """Add an Actor card (yellow) to the Mural board.

    Placed to the right of the last yellow card.
    Actors are the people or roles that issue commands.
    Example: 'Customer', 'Warehouse Staff', 'System'.
    """
    return add_actor(name)


@mcp.tool()
def tool_es_hotspot(name: str) -> dict:
    """Add a Hotspot card (red) to the Mural board.

    Placed to the right of the last red card.
    Hotspots flag questions, risks, or unresolved problems in the flow.
    Example: 'Who owns refund logic?', 'Race condition here?'.
    """
    return add_hotspot(name)


# ── Connectors ─────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_create_connector(
    from_id: str,
    to_id: str,
    label: str | None = None,
) -> dict:
    """Create an arrow connector between two widgets on the Mural board.

    from_id: widget ID of the source widget.
    to_id:   widget ID of the target widget.
    label:   optional text label rendered on the connector.
    """
    return create_connector(from_id, to_id, label)


# ── Diagram sync ────────────────────────────────────────────────────────────────

@mcp.tool()
def tool_apply_diagram(diagram_json: str) -> str:
    """Apply an EventStormDiagram to the Mural board (idempotent upsert).

    Accepts a JSON string conforming to the EventStormDiagram schema.
    Merges any previously persisted mural_widget_id / mural_frame_id values so
    subsequent calls update existing widgets rather than creating duplicates.
    Runs the swim-lane layout engine, then creates/updates all cards, frames,
    and connectors.  Returns the updated diagram JSON (with widget IDs filled in).
    """
    diagram = EventStormDiagram.model_validate_json(diagram_json)

    # Recover previously saved widget IDs so this call is idempotent.
    saved = state_store.load_diagram(default_path(diagram.session_id))
    if saved is not None:
        saved_cards = {c.id: c for c in saved.cards}
        for card in diagram.cards:
            if card.mural_widget_id is None:
                saved_card = saved_cards.get(card.id)
                if saved_card and saved_card.mural_widget_id:
                    card.mural_widget_id = saved_card.mural_widget_id

        saved_frames = {f.id: f for f in saved.frames}
        for frame in diagram.frames:
            if frame.mural_frame_id is None:
                saved_frame = saved_frames.get(frame.id)
                if saved_frame and saved_frame.mural_frame_id:
                    frame.mural_frame_id = saved_frame.mural_frame_id

    diagram.cards, diagram.frames = assign_layout(diagram.cards, diagram.frames)
    updated = apply_diagram(diagram)
    state_store.save_diagram(updated, default_path(updated.session_id))
    return updated.model_dump_json()


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    try:
        mcp.run()
    except (BrokenPipeError, OSError):
        # Parent process closed the stdio pipe (normal shutdown); exit cleanly.
        pass


if __name__ == "__main__":
    main()
