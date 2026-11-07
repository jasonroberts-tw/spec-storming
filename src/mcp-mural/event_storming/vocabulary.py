"""Event Storming vocabulary: domain concept enum, colors, and card sizes.

Classic Event Storming color conventions used here:
  - domain_event  → orange  (something that happened in the domain)
  - command       → blue    (intent that causes an event)
  - aggregate     → yellow  (business entity / state boundary)
  - policy        → purple  (reaction rule: "whenever X, then Y")
  - read_model    → green   (data a user sees / query result)
  - external      → pink    (external system or bounded context)
  - actor         → yellow  (person or role triggering a command)
  - hotspot       → red     (question, problem, or risk to resolve)

Project-specific shorthand (overrides classic aliases where noted):
  - user          → yellow  (person / actor initiating an action)
  - event         → blue    (something that happened; blue in this project)
  - important     → red     (key decision, risk, or highlighted item)
  - system        → pink    (external or supporting system)

Card sizes (each is half the previous):
  LARGE  = (200, 160)  — full-size card (main flow events, commands)
  MEDIUM = (100,  80)  — half of LARGE  (actors, triggers, systems)
  SMALL  = ( 50,  40)  — half of MEDIUM (annotations, fine detail)
"""

from enum import StrEnum


class Concept(StrEnum):
    """Event Storming concept types used to drive card color and size."""
    # ── Project-specific shorthand ────────────────────────────────────────────
    USER         = "user"
    EVENT        = "event"
    IMPORTANT    = "important"
    SYSTEM       = "system"
    # ── Classic Event Storming ────────────────────────────────────────────────
    DOMAIN_EVENT = "domain_event"
    COMMAND      = "command"
    AGGREGATE    = "aggregate"
    POLICY       = "policy"
    READ_MODEL   = "read_model"
    EXTERNAL     = "external"
    ACTOR        = "actor"
    HOTSPOT      = "hotspot"


# ── Size constants ─────────────────────────────────────────────────────────────
LARGE:  tuple[int, int] = (150, 120)
MEDIUM: tuple[int, int] = (100,  80)
SMALL:  tuple[int, int] = ( 50,  40)

# Gap between adjacent cards of the same concept type (pixels)
CARD_GAP: float = 20.0

# ── Color mapping ──────────────────────────────────────────────────────────────
# Maps ES concept name → Mural named color
CONCEPT_COLORS: dict[str, str] = {
    "domain_event": "orange",
    "command":      "blue",
    "cmd":          "blue",     # shorthand alias
    "aggregate":    "yellow",
    "agg":          "yellow",   # shorthand alias
    "policy":       "purple",
    "read_model":   "green",
    "view":         "green",    # shorthand alias
    "external":         "pink",
    "external_system":  "pink",   # snake_case alias for LLM output
    "actor":            "yellow",
    "hotspot":      "red",
    "problem":      "red",      # shorthand alias
    # ── Project-specific shorthand ────────────────────────────────────────────
    "user":         "yellow",
    "event":        "blue",
    "important":    "red",
    "system":       "pink",
}

# ── Size mapping ───────────────────────────────────────────────────────────────
# Maps ES concept name → canonical card size
CONCEPT_SIZES: dict[str, tuple[int, int]] = {
    "domain_event": LARGE,
    "command":      LARGE,
    "cmd":          LARGE,
    "aggregate":    LARGE,
    "agg":          LARGE,
    "policy":       MEDIUM,
    "read_model":   LARGE,
    "view":         LARGE,
    "external":         MEDIUM,
    "external_system":  MEDIUM,   # snake_case alias
    "actor":            LARGE,
    "hotspot":      MEDIUM,
    "problem":      MEDIUM,
    # ── Project-specific shorthand ────────────────────────────────────────────
    "user":         MEDIUM,
    "event":        LARGE,
    "important":    MEDIUM,
    "system":       LARGE,
}


def _key(concept: str) -> str:
    return concept.strip().lower().replace(" ", "_").replace("-", "_")


def color_for(concept: Concept | str) -> str:
    """Return the Mural color name for an Event Storming concept.

    Raises ValueError if the concept is not recognised.
    """
    k = _key(concept)
    if k not in CONCEPT_COLORS:
        raise ValueError(
            f"Unknown Event Storming concept '{concept}'. "
            f"Valid concepts: {', '.join(sorted(CONCEPT_COLORS))}."
        )
    return CONCEPT_COLORS[k]


def size_for(concept: Concept | str) -> tuple[int, int]:
    """Return the canonical (width, height) for an Event Storming concept.

    Raises ValueError if the concept is not recognised.
    """
    k = _key(concept)
    if k not in CONCEPT_SIZES:
        raise ValueError(
            f"Unknown Event Storming concept '{concept}'. "
            f"Valid concepts: {', '.join(sorted(CONCEPT_SIZES))}."
        )
    return CONCEPT_SIZES[k]
