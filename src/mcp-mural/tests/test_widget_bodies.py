"""Request bodies for cards and frames — colour, rotation, and reparenting."""

import pytest

from mural_mcp.colors import resolve_color
from mural_mcp.tools.cards import _card_body


# ── colours ───────────────────────────────────────────────────────────────────

def test_named_colour_resolves():
    assert resolve_color("blue") == "#5DADE2FF"
    assert resolve_color(" Blue ") == "#5DADE2FF"


def test_eight_digit_hex_passes_through_uppercased():
    assert resolve_color("#ffb84dff") == "#FFB84DFF"


def test_six_digit_hex_is_rejected():
    """Mural returns a 400 for 6-digit hex, so fail loudly rather than send it."""
    with pytest.raises(ValueError, match="8-digit"):
        resolve_color("#FFB84D")


def test_unknown_name_is_rejected():
    with pytest.raises(ValueError, match="Unknown color"):
        resolve_color("chartreuse")


# ── card bodies ───────────────────────────────────────────────────────────────

def test_card_body_defaults_omit_optional_fields():
    body = _card_body("hi", "yellow", 0, 0, None, None, None)
    assert body["width"] == 200 and body["height"] == 200
    assert "rotation" not in body
    assert "parentId" not in body
    assert body["style"] == {"backgroundColor": "#F4D03FFF"}


def test_card_body_carries_hex_rotation_and_italic():
    body = _card_body("q?", "#FF5A5FFF", 10, 20, 138, 138, None, rotation=45, italic=True)
    assert body["style"] == {"backgroundColor": "#FF5A5FFF", "italic": True}
    assert body["rotation"] == 45


def test_card_body_sets_parent_id_from_frame():
    body = _card_body("evt", "orange", 24, 60, 138, 138, "frame-1")
    assert body["parentId"] == "frame-1"
    # Coordinates are passed straight through; the caller supplies parent-relative
    # values when a frame is given.
    assert (body["x"], body["y"]) == (24, 60)


def test_falsy_rotation_is_omitted():
    """rotation=0 is the default upright card — no need to send it."""
    body = _card_body("evt", "orange", 0, 0, None, None, None, rotation=0)
    assert "rotation" not in body
