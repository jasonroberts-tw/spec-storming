"""JSON persistence for EventStormDiagram.

Stores mural_widget_id / mural_frame_id values so that re-runs update existing
Mural widgets rather than creating duplicates.

Default storage: ~/.mural_sync/{session_id}.json
"""

from __future__ import annotations

from pathlib import Path

from event_storming.schema import EventStormDiagram


def default_path(session_id: str) -> Path:
    """Return the default file path for a session's persisted diagram."""
    return Path.home() / ".mural_sync" / f"{session_id}.json"


def save_diagram(diagram: EventStormDiagram, path: Path) -> None:
    """Persist the diagram (with widget IDs) to *path* as formatted JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(diagram.model_dump_json(indent=2), encoding="utf-8")


def load_diagram(path: Path) -> EventStormDiagram | None:
    """Load and return a previously persisted diagram, or None if not found."""
    if not path.exists():
        return None
    return EventStormDiagram.model_validate_json(path.read_text(encoding="utf-8"))
