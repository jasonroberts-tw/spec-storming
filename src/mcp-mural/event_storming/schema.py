"""Pydantic metamodel for EventStorming diagrams synced to Mural."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel


LinkRelation = Literal["triggers", "raises", "invokes", "reads"]


class ConceptType(StrEnum):
    # ── Core Event Storming types ─────────────────────────────────────────────
    DOMAIN_EVENT   = "domain_event"
    COMMAND        = "command"
    ACTOR          = "actor"
    POLICY         = "policy"
    READ_MODEL     = "read_model"
    EXTERNAL       = "external"       # matches Concept.EXTERNAL in vocabulary.py
    EXTERNAL_SYSTEM = "external_system"  # snake_case alias — LLM sometimes outputs this
    HOTSPOT        = "hotspot"
    AGGREGATE      = "aggregate"
    # ── Tactic DDD types (reserved for future inside-aggregate pass) ──────────
    ENTITY         = "entity"
    VALUE_OBJECT   = "value_object"
    DOMAIN_SERVICE = "domain_service"
    REPOSITORY     = "repository"
    # ── Container ─────────────────────────────────────────────────────────────
    BOUNDED_CONTEXT = "bounded_context"


class Position(BaseModel):
    x: float
    y: float


class CardSize(BaseModel):
    width: float
    height: float


class CardLink(BaseModel):
    to_id: str
    relation: LinkRelation


class EventStormCard(BaseModel):
    id: str
    concept: ConceptType
    text: str
    position: Position
    size: CardSize | None = None
    mural_widget_id: str | None = None
    links: list[CardLink] = []
    bounded_context_id: str | None = None
    order: int = 0
    # The domain event this command triggers. Required for command cards;
    # the layout engine uses it to place the command directly left of its event.
    event_id: str | None = None


class BoundedContextFrame(BaseModel):
    id: str
    name: str
    position: Position
    width: float
    height: float
    mural_frame_id: str | None = None


class EventStormDiagram(BaseModel):
    session_id: str
    title: str
    cards: list[EventStormCard]
    frames: list[BoundedContextFrame] = []
    last_updated: str
