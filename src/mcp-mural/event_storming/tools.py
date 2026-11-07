"""Event Storming tool functions.

Each function corresponds to one domain concept in Event Storming and
creates the appropriate Mural card, automatically positioned to the right
of the last existing card of the same type.

These functions are imported by mural_mcp.server and registered as MCP tools
on the shared FastMCP instance — they do NOT define their own server.
"""

from mural_mcp.tools.cards import create_card
from event_storming.placement import next_position
from event_storming.vocabulary import color_for, size_for


def _place_concept(concept: str, name: str) -> dict:
    """Create a card for *concept* labelled *name*, placed right of the last card of the same color."""
    color = color_for(concept)
    width, height = size_for(concept)
    x, y = next_position(color, width=width, height=height)
    return create_card(name, color=color, x=x, y=y, width=width, height=height)


# ── Individual concept helpers (used by the MCP tool wrappers below) ──────────

def add_event(name: str) -> dict:
    """Add a Domain Event card (orange) to the right of the last domain event."""
    return _place_concept("event", name)


def add_command(name: str) -> dict:
    """Add a Command card (blue) to the right of the last command."""
    return _place_concept("command", name)


def add_aggregate(name: str) -> dict:
    """Add an Aggregate card (yellow) to the right of the last aggregate."""
    return _place_concept("aggregate", name)


def add_policy(name: str) -> dict:
    """Add a Policy card (purple) to the right of the last policy."""
    return _place_concept("policy", name)


def add_read_model(name: str) -> dict:
    """Add a Read Model card (green) to the right of the last read model."""
    return _place_concept("read_model", name)


def add_external(name: str) -> dict:
    """Add an External System card (pink) to the right of the last external system."""
    return _place_concept("external", name)


def add_actor(name: str) -> dict:
    """Add an Actor card (yellow) to the right of the last actor."""
    return _place_concept("actor", name)


def add_hotspot(name: str) -> dict:
    """Add a Hotspot/Problem card (red) to the right of the last hotspot."""
    return _place_concept("hotspot", name)
