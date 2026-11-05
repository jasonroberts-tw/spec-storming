COLORS: dict[str, str] = {
    "yellow":  "#F4D03FFF",
    "orange":  "#F0884BFF",
    "blue":    "#5DADE2FF",
    "purple":  "#8E44ADFF",
    "pink":    "#F1948AFF",
    "green":   "#52BE80FF",
    "red":     "#E74C3CFF",
    "white":   "#FFFFFFFF",
    "gray":    "#BDC3C7FF",
    "teal":    "#1ABC9CFF",
    "lime":    "#ADFF2FFF",
    "brown":   "#C49A6CFF",
}

_VALID = ", ".join(sorted(COLORS))
_HEX_DIGITS = set("0123456789abcdefABCDEF")


def resolve_color(name: str) -> str:
    """Return the Mural hex+alpha string for a named color, or pass hex through.

    Accepts either a name from COLORS or an explicit 8-digit '#RRGGBBAA' string,
    so a caller with its own palette (e.g. EventStorming sticky colors) is not
    limited to the twelve names here. Mural rejects 6-digit hex with a 400, so
    the alpha byte is required.

    Raises ValueError for anything else.
    """
    key = name.strip()
    if key.startswith("#"):
        digits = key[1:]
        if len(digits) == 8 and all(c in _HEX_DIGITS for c in digits):
            return f"#{digits.upper()}"
        raise ValueError(
            f"Invalid hex color '{name}'. Mural requires 8-digit #RRGGBBAA "
            "(6-digit hex is rejected with a 400)."
        )
    key = key.lower()
    if key not in COLORS:
        raise ValueError(
            f"Unknown color '{name}'. Use 8-digit #RRGGBBAA hex, or one of: {_VALID}"
        )
    return COLORS[key]
