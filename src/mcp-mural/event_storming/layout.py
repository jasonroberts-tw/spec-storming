"""Deterministic swim-lane layout engine for EventStorming diagrams.

Positions are computed entirely from session order + bounded-context lane index.
placement.py (which queries the live Mural board) is intentionally NOT used here —
this engine is fully reproducible without any board round-trips.

Layout passes:
  1. All non-anchored cards (everything except commands that carry event_id) are
     placed sequentially left-to-right within their lane.
  2. Anchored commands (concept == "command" and event_id set) are placed at
     event.position.x − CARD_STEP_X so they always appear immediately left of their
     paired domain event, regardless of card order.
  3. Frame bounding boxes are computed from all card positions in the lane.
"""

from __future__ import annotations

from event_storming.schema import BoundedContextFrame, ConceptType, EventStormCard, Position

LANE_HEIGHT:    float = 400.0
LANE_PADDING_X: float = 100.0
LANE_PADDING_Y: float = 80.0
CARD_STEP_X:    float = 220.0

# Vertical row within a lane per concept type (relative to lane origin y).
# Convention (matches the Booking Process template):
#   above baseline:  hotspot > external > read_model
#   at baseline:     actor, command, domain_event  (all same row — left-to-right flow)
#   below baseline:  aggregate, policy
# Unrecognised concept types default to 0.
Y_OFFSETS: dict[str, float] = {
    "hotspot":      -200.0,  # above all — risk/question strip
    "external":     -160.0,  # external systems above the main flow
    "read_model":    -80.0,  # info the actor needs to make a decision
    "actor":           0.0,  # main flow baseline
    "command":         0.0,  # main flow baseline
    "domain_event":    0.0,  # main flow baseline
    "aggregate":      80.0,  # below events — consistency boundary
    "policy":         80.0,  # below and right of event — reaction rule
}

# Left-to-right reading order within a lane.
# Actors → Commands → Events → Policies → Read models → Aggregates → External → Hotspots.
# Cards with the same priority are then sorted by their `order` field.
CONCEPT_X_ORDER: dict[str, int] = {
    "actor":        0,
    "command":      1,
    "domain_event": 2,
    "policy":       3,
    "read_model":   4,
    "aggregate":    5,
    "external":     6,
    "hotspot":      7,
}

_UNASSIGNED = "__unassigned__"


def _is_anchored(card: EventStormCard) -> bool:
    """True for command cards that carry an event_id — laid out in Pass 2."""
    return card.concept == ConceptType.COMMAND and card.event_id is not None


def assign_layout(
    cards: list[EventStormCard],
    frames: list[BoundedContextFrame],
) -> tuple[list[EventStormCard], list[BoundedContextFrame]]:
    """Assign absolute x, y positions to every card and compute frame bounding boxes.

    Cards are grouped into swim lanes by bounded_context_id (None → unassigned lane).
    Within each lane, non-anchored cards are ordered by card.order; anchored commands
    are pinned immediately left of their referenced domain event (event_id).
    """
    # Global lookup so anchored commands can find events in any lane.
    card_by_id: dict[str, EventStormCard] = {c.id: c for c in cards}

    # ── Group cards by lane ───────────────────────────────────────────────────
    groups: dict[str, list[EventStormCard]] = {}
    for card in cards:
        key = card.bounded_context_id if card.bounded_context_id is not None else _UNASSIGNED
        groups.setdefault(key, []).append(card)

    for group in groups.values():
        group.sort(key=lambda c: c.order)

    frame_lookup: dict[str, BoundedContextFrame] = {f.id: f for f in frames}

    # ── Pass 1: position non-anchored cards sequentially in each lane ─────────
    for lane_index, (_, lane_cards) in enumerate(groups.items()):
        lane_origin_y = lane_index * LANE_HEIGHT
        free_cards = [c for c in lane_cards if not _is_anchored(c)]
        # Sort by concept reading order first (commands before events, policies after),
        # then by card.order within each concept group so the timeline is preserved.
        free_cards.sort(key=lambda c: (CONCEPT_X_ORDER.get(str(c.concept), 99), c.order))
        for order_index, card in enumerate(free_cards):
            x = LANE_PADDING_X + order_index * CARD_STEP_X
            y = lane_origin_y + Y_OFFSETS.get(str(card.concept), 0.0)
            card.position = Position(x=x, y=y)

    # ── Pass 2: anchor commands immediately left of their domain event ────────
    for lane_index, (_, lane_cards) in enumerate(groups.items()):
        lane_origin_y = lane_index * LANE_HEIGHT
        anchored = [c for c in lane_cards if _is_anchored(c)]
        free_count = sum(1 for c in lane_cards if not _is_anchored(c))
        for fallback_index, command in enumerate(anchored):
            event = card_by_id.get(command.event_id)  # type: ignore[arg-type]
            if event is not None:
                x = event.position.x - CARD_STEP_X
            else:
                # Event not found yet — place after free cards as fallback.
                x = LANE_PADDING_X + (free_count + fallback_index) * CARD_STEP_X
            y = lane_origin_y + Y_OFFSETS.get("command", -60.0)
            command.position = Position(x=x, y=y)

    # ── Pass 3: compute frame bounding boxes from all card positions ──────────
    for lane_key, lane_cards in groups.items():
        if lane_key == _UNASSIGNED or lane_key not in frame_lookup:
            continue
        xs = [c.position.x for c in lane_cards]
        ys = [c.position.y for c in lane_cards]
        if not xs:
            continue
        frame = frame_lookup[lane_key]
        min_x = min(xs) - LANE_PADDING_X
        min_y = min(ys) - LANE_PADDING_Y
        max_x = max(xs) + LANE_PADDING_X
        max_y = max(ys) + LANE_PADDING_Y
        frame.position = Position(x=min_x, y=min_y)
        frame.width  = max_x - min_x
        frame.height = max_y - min_y

    return cards, frames
