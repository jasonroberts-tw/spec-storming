# Connect the Dots

A pile of stickies is not a model. Value comes from the relationships between them — the
flows and reactions that show how the domain actually behaves.

## The grammar to assemble

`Actor → issues → Command → acts on → Aggregate → emits → Domain Event → triggers → Policy
→ issues → Command …`, with Read Models informing actors and External Systems on the edges.

## What to connect

- **Command → Event**: every command should produce at least one event; every event should
  trace back to a command (or an external system / policy). A dangling event with no cause,
  or a command with no effect, is a gap worth flagging.
- **Event → Policy → Command**: "whenever <event>, then <command>" — these reactive links are
  the connective tissue of the process. Name the policy explicitly.
- **Sticky → Bounded Context**: assign stickies to the context whose language they belong to;
  a sticky that fits two contexts is a boundary hotspot.
- **Cross-context messages**: when an event in one context triggers work in another, record it
  as inbound/outbound communication on the Bounded Context Canvases.

## How to act

- Add the missing connective stickies (especially policies) rather than leaving events
  floating.
- When a connection is implied by the conversation but not stated, add it at lower confidence
  and cite the lines that imply it.
- Where a required link is genuinely absent (event with no trigger, command with no aggregate),
  surface it as a gap/hotspot instead of inventing one.
