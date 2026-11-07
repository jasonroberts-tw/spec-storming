"""Connector (arrow) support for Mural boards."""

from mural_mcp import client


def create_connector(
    from_widget_id: str,
    to_widget_id: str,
    label: str | None = None,
) -> dict:
    """Create an arrow connector between two widgets on the Mural board.

    from_widget_id: widget ID of the source widget
    to_widget_id:   widget ID of the target widget
    label:          optional text label on the connector
    """
    mid = client.mural_id()
    body: dict = {
        "startWidget": {"id": from_widget_id},
        "endWidget":   {"id": to_widget_id},
    }
    if label is not None:
        body["label"] = label
    result = client.post(f"/murals/{mid}/widgets/connector", body)
    return result.get("value", result)
