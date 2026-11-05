"""Idempotent renderer: creates or updates Mural cards, frames, and connectors.

Processing order:
  1. Frames  — create any frame that lacks a mural_frame_id
  2. Cards   — create or update each card; populate mural_widget_id
  3. Connectors — create arrows after both ends have widget IDs
"""

from __future__ import annotations

from mural_mcp.client import MuralAPIError
from mural_mcp.tools.cards import create_card, update_card
from mural_mcp.tools.frames import create_frame
from mural_mcp.tools.connectors import create_connector
from event_storming.vocabulary import color_for, size_for
from event_storming.schema import EventStormDiagram


def apply_diagram(diagram: EventStormDiagram) -> EventStormDiagram:
    """Apply (create or update) all cards, frames, and connectors on the Mural board.

    Returns the mutated diagram with mural_widget_id / mural_frame_id populated.
    """
    # ── Pass 1: frames ────────────────────────────────────────────────────────
    frame_id_lookup: dict[str, str] = {}
    for frame in diagram.frames:
        if frame.mural_frame_id is None:
            result = create_frame(
                frame.name,
                frame.position.x,
                frame.position.y,
                frame.width,
                frame.height,
            )
            frame.mural_frame_id = result.get("id") or result.get("value", {}).get("id")
        if frame.mural_frame_id:
            frame_id_lookup[frame.id] = frame.mural_frame_id

    # ── Pass 2: cards ─────────────────────────────────────────────────────────
    for card in diagram.cards:
        color = color_for(card.concept)
        w, h = (
            (card.size.width, card.size.height)
            if card.size is not None
            else size_for(card.concept)
        )
        fid = frame_id_lookup.get(card.bounded_context_id) if card.bounded_context_id else None

        if card.mural_widget_id is not None:
            try:
                update_card(
                    card.mural_widget_id,
                    text=card.text,
                    color=color,
                    x=card.position.x,
                    y=card.position.y,
                    width=w,
                    height=h,
                )
            except MuralAPIError as exc:
                if exc.status_code != 404:
                    raise
                # Widget was deleted from the board; recreate it fresh.
                card.mural_widget_id = None
                result = create_card(
                    card.text,
                    color=color,
                    x=card.position.x,
                    y=card.position.y,
                    width=w,
                    height=h,
                    frame_id=fid,
                )
                card.mural_widget_id = result.get("id") or result.get("value", {}).get("id")
        else:
            result = create_card(
                card.text,
                color=color,
                x=card.position.x,
                y=card.position.y,
                width=w,
                height=h,
                frame_id=fid,
            )
            card.mural_widget_id = result.get("id") or result.get("value", {}).get("id")

    # ── Pass 3: connectors ────────────────────────────────────────────────────
    widget_id_lookup: dict[str, str] = {
        c.id: c.mural_widget_id for c in diagram.cards if c.mural_widget_id
    }
    for card in diagram.cards:
        if not card.mural_widget_id:
            continue
        for link in card.links:
            to_widget_id = widget_id_lookup.get(link.to_id)
            if to_widget_id:
                create_connector(card.mural_widget_id, to_widget_id, label=link.relation)

    return diagram
