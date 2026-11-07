"""Build the e-commerce flow diagram on the Mural board."""

from mural_mcp import client
from mural_mcp.colors import resolve_color
from event_storming import Concept, color_for, size_for


def build_card(text: str, concept: Concept, position: list[int]) -> dict:
    """Domain representation of a card — no Mural details here."""
    return {
        "text":     text,
        "position": position,
        "concept":  concept,
    }


def to_mural_payload(card: dict) -> dict:
    """Translate a domain card to the shape the Mural API expects."""
    cx, cy = card["position"]
    w, h   = size_for(card["concept"])
    return {
        "text":   card["text"],
        "x":      cx,
        "y":      cy,
        "width":  w,
        "height": h,
        "shape":  "rectangle",
        "style":  {"backgroundColor": resolve_color(color_for(card["concept"]))},
    }


# ── Card definitions ──────────────────────────────────────────────────────────
# Each entry: (label, concept, [x, y])
# Size is determined automatically by concept type (see event_storming/vocabulary.py).
# Layout: main flow at y=0, triggers at y=-160, systems at y=160+

TYPE = Concept  # local alias for brevity

CARDS = [
    # ── Phase 1: Order Entry (x 0–500) ───────────────────────────────────────
    ("User",                         TYPE.USER,      [   0,    0]),
    ("Order Information",            TYPE.EVENT,     [ 200,    0]),
    ("Input Checks Performed",       TYPE.EVENT,     [ 400,    0]),
    ("Input Checks Performed",       TYPE.POLICY,    [ 550,   70]),
    ("Order",                        TYPE.IMPORTANT, [ 200, -160]),
    ("Webpage",                      TYPE.SYSTEM,    [ 200,  160]),
    ("Inventory",                    TYPE.SYSTEM,    [ 400,  160]),
    ("Check Inventory",              TYPE.SYSTEM,    [ 400,  310]),
    ("Organization System",          TYPE.SYSTEM,    [ 400,  460]),

    # ── Phase 2: Add to Cart (x 700–1400) ────────────────────────────────────
    ("User",                         TYPE.USER,      [ 700,    0]),
    ("Add to Cart",                  TYPE.EVENT,     [ 900,    0]),
    ("Order Added to Cart",          TYPE.EVENT,     [1100,    0]),
    ("Shopping Cart Updated",        TYPE.EVENT,     [1310,    0]),
    ("Order",                        TYPE.IMPORTANT, [1100, -160]),
    ("Shopping Cart",                TYPE.IMPORTANT, [1310, -160]),
    ("Offer",                        TYPE.IMPORTANT, [ 900,  160]),
    ("Promotional Offers Identified",TYPE.EVENT,     [1100,  160]),
    ("Offer System",                 TYPE.SYSTEM,    [1310,  160]),
    ("Promotional Offers Provided",  TYPE.USER,      [1100,  310]),

    # ── Phase 2b: Offers Decision (x 700–1200, y 530–700) ────────────────────
    ("User",                         TYPE.USER,      [ 700,  610]),
    ("Accept",                       TYPE.EVENT,     [ 900,  560]),
    ("Offers Accepted",              TYPE.EVENT,     [1100,  560]),
    ("Decline",                      TYPE.EVENT,     [ 900,  690]),
    ("Offers Declined",              TYPE.EVENT,     [1100,  690]),

    # ── Phase 3: Checkout (x 1550–2450) ──────────────────────────────────────
    ("User",                         TYPE.USER,      [1550,    0]),
    ("Checkout",                     TYPE.EVENT,     [1750,    0]),
    ("Checkout Selected",            TYPE.EVENT,     [1950,    0]),
    ("Mailing Address Provided",     TYPE.EVENT,     [2160,    0]),
    ("Tax & Shipping Calculated",    TYPE.EVENT,     [2370,    0]),
    ("Multiple Offers Bundled",      TYPE.USER,      [1950,  160]),
    ("Billing Address Provided",     TYPE.USER,      [2160,  160]),

    # ── Phase 4: Payment (x 2580–3000) ───────────────────────────────────────
    ("Inventory Updated",            TYPE.EVENT,     [2580,    0]),
    ("Process Payment",              TYPE.EVENT,     [2790,    0]),
    ("Payment Processed",            TYPE.EVENT,     [3000,    0]),
    ("Advise",                       TYPE.IMPORTANT, [2370, -160]),
    ("Inventory",                    TYPE.IMPORTANT, [2580, -160]),
    ("Payment",                      TYPE.IMPORTANT, [2790, -160]),
    ("Inventory System",             TYPE.SYSTEM,    [2580,  160]),

    # ── Phase 5: Fulfillment (x 3200–3450) ───────────────────────────────────
    ("Visa, MC,\nAmerican Express",  TYPE.IMPORTANT, [3200, -160]),
    ("Fulfill Order",                TYPE.EVENT,     [3200,    0]),
    ("Order",                        TYPE.IMPORTANT, [3430,    0]),
    ("Warehouse Notified",           TYPE.EVENT,     [3200,  160]),
    ("Warehouse System",             TYPE.SYSTEM,    [3430,  160]),
    ("Order Fulfilled",              TYPE.EVENT,     [3200,  310]),
]

# ── Create cards one at a time ────────────────────────────────────────────────
print(f"Creating {len(CARDS)} cards...")
mid = client.mural_id()

for text, concept, position in CARDS:
    card = build_card(text, concept, position)
    resp = client.post(f"/murals/{mid}/widgets/sticky-note", to_mural_payload(card))
    print(f"  created: {text!r} [{concept}] @ {position}")

print(f"Done. View: https://app.mural.co/t/hackathon0833/m/hackathon0833/1784235982791")
