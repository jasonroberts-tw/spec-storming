# Proposal: Add Coach Hints

## Why

Today the coach only answers questions the facilitator thinks to ask, and the synthesizer's insights (hotspots, ambiguity, thin areas of the model) sit passively on the canvas. Workshops stall or drift when nobody notices that a hot spot needs discussion, a term is ambiguous, or a whole area of the domain hasn't been explored. Unprompted, timely guidance from the coach would keep the workshop moving and improve model quality without waiting for someone to ask.

## What Changes

- Add a **Hints** capability to the coach: proactively generated, unprompted guidance tied to the current workshop state — e.g. "discuss this hot spot", "clarify this ambiguous term", "go broader: no one has mentioned billing", "go deeper on the fulfillment flow", "suggested next topic".
- Hints are generated server-side by a coach-driven background pass over recent transcript and canvas state (hotspots, thin bounded contexts, vague language), rate-limited so they arrive occasionally rather than constantly.
- Hints **appear on the canvas** as a distinct, visually lightweight element (separate from stickies/hotspots), optionally anchored to the canvas element they concern.
- Hints are **engageable in the coach chat**: clicking a hint starts/continues a coach conversation seeded with that hint's topic; hints can also be dismissed.
- New server events carry hint lifecycle (suggested, engaged, dismissed) over the existing SSE stream; hints persist in session state like other canvas data.

## Capabilities

### New Capabilities

- `hint-generation`: When and how the system proactively produces hints — triggers, inputs (transcript window, canvas, chat history), hint kinds (hot-spot discussion, clarify ambiguity, go broader, go deeper, next topic), rate limiting, deduplication, and lifecycle (active, engaged, dismissed, stale).
- `hint-canvas-display`: How hints are rendered on the canvas — distinct visual treatment, anchoring to related canvas elements, freshness indication, and dismissal affordance.
- `hint-chat-engagement`: How a facilitator engages a hint in the coach chat — engaging a hint seeds a coach conversation with the hint's context, the coach responds with concrete guidance, and the hint's state updates accordingly.

### Modified Capabilities

_None — there are no existing specs in `openspec/specs/`; all behavior here is new._

## Impact

- **Shared types** (`packages/shared/src/canvas.ts`, `events.ts`, `session.ts`): new `Hint` type, hint lifecycle events in the `ServerEvent` union, hints in session state.
- **Server** (`packages/server/src`): new hint generation logic on the coach side (`CoachAgent.ts` or a sibling `HintAgent`), new upsert/dismiss methods in `SessionMemory.ts`, new API route(s) for engage/dismiss, SSE catch-up replay of active hints in `index.ts`.
- **Web** (`packages/web/src`): hint rendering in `Canvas.tsx` (new component), engage/dismiss wiring into `CoachChat.tsx`, new event handling in `useSessionStream.ts`.
- **Agents/cost**: one additional periodic Agent SDK query path (budgeted and rate-limited); canvas write discipline is preserved — the synthesizer remains the only writer of stickies/BCs/hotspots, hints are a separate store.
- **No breaking changes** to existing events, tools, or state; hints are additive.
