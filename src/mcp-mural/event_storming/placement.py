"""Placement helpers for Event Storming cards.

Finds the rightmost existing card of a given color on the board and
returns the (x, y) centre coordinates for the next card so it sits
flush to the right without overlapping.
"""

from mural_mcp.tools.query import list_cards_by_color
from event_storming.vocabulary import CARD_GAP, LARGE

_DEFAULT_WIDTH, _DEFAULT_HEIGHT = LARGE


def _card_width(card: dict) -> float:
    return float(card.get("width") or _DEFAULT_WIDTH)


def _card_height(card: dict) -> float:
    return float(card.get("height") or _DEFAULT_HEIGHT)


def rightmost_card(color: str) -> dict | None:
    """Return the card with the greatest right-edge x for the given color.

    Returns None when no cards of that color exist yet.
    """
    cards = list_cards_by_color(color)
    if not cards:
        return None
    # Sort by right edge (centre_x + half_width) descending, pick the first.
    return max(cards, key=lambda c: float(c.get("x", 0)) + _card_width(c) / 2)


def next_position(color: str, width: float = _DEFAULT_WIDTH, height: float = _DEFAULT_HEIGHT) -> tuple[float, float]:
    """Return (centre_x, centre_y) for a new card placed to the right of
    the rightmost existing card of *color*.

    If no card of that color exists the card is placed at the origin (0, 0).
    The new card will NOT overlap the existing one: a CARD_GAP pixel gap is
    maintained between the right edge of the last card and the left edge of
    the new one.
    """
    anchor = rightmost_card(color)
    if anchor is None:
        return 0.0, 0.0

    anchor_cx = float(anchor.get("x", 0))
    anchor_w = _card_width(anchor)
    anchor_cy = float(anchor.get("y", 0))

    # right edge of the anchor card
    anchor_right = anchor_cx + anchor_w / 2

    # left edge of the new card sits CARD_GAP pixels to the right
    new_left = anchor_right + CARD_GAP

    # centre of the new card
    new_cx = new_left + width / 2
    new_cy = anchor_cy  # align vertically with the anchor card

    return new_cx, new_cy
