/**
 * Reproduces two more paths of ss-oei. After a restart with a board bound, and before a hydrate,
 * the session is still the empty startup session. "Tidy board" (MuralProjector.tidy(), which
 * POST /api/mural/tidy calls) and "Finish" (SessionMemory.setStatus("finished"), which
 * POST /api/session/finish calls) each saved that session over the snapshot, although neither
 * changed anything the snapshot needs.
 */
import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import type { SessionState } from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import type { SnapshotStore } from "../memory/store.ts";
import type { MuralAuth } from "./auth.ts";
import { createLayoutState } from "./layout.ts";
import type { MuralMcp } from "./muralMcp.ts";
import { MuralProjector } from "./MuralProjector.ts";
import { restoreMuralBinding } from "./restoreBinding.ts";

/** A store that keeps one copy of each saved session in memory, and writes nothing to disk. */
function inMemoryStore(...initial: SessionState[]): SnapshotStore {
  const sessions = new Map(initial.map((s) => [s.id, structuredClone(s)]));
  return {
    save: async (state) => {
      sessions.set(state.id, structuredClone(state));
    },
    load: async (id) => {
      const saved = sessions.get(id);
      return saved ? structuredClone(saved) : null;
    },
  };
}

/** The server after a restart: a fresh, empty session, with the saved board's binding restored. */
async function restartWithBoardBound(): Promise<{ store: SnapshotStore; memory: SessionMemory; bus: EventBus }> {
  const beforeRestart = emptySession("demo", "Before the restart");
  beforeRestart.transcript.push({ id: "t-0001", ts: "2026-08-01T00:00:00Z", speaker: "Ana", text: "hello", seq: 1 });
  beforeRestart.mural = {
    muralId: "workspace.12345",
    embedUrl: "https://app.mural.co/embed/00000000-0000-0000-0000-000000000000",
    lastProjectedRev: 1,
    widgets: {},
    layout: createLayoutState(),
  };
  const store = inMemoryStore(beforeRestart);
  const bus = new EventBus();
  const memory = new SessionMemory(bus, { snapshots: store });
  await restoreMuralBinding(memory, store, "demo");
  return { store, memory, bus };
}

const MESSAGE = "the snapshot no longer holds the transcript saved before the restart";

test("a tidy after a restart, before a hydrate, keeps the transcript saved before the restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, memory, bus } = await restartWithBoardBound();
  const connectedAuth = { configured: true, connected: async () => true } as unknown as MuralAuth;
  // A tidy of an empty canvas has no widget to move, so it makes no board call.
  const projector = new MuralProjector(memory, bus, connectedAuth, {} as unknown as MuralMcp);

  const result = await projector.tidy();

  deepStrictEqual(result, { moved: 0 });
  // Past every debounced save the tidy could have scheduled.
  t.mock.timers.tick(5000);
  deepStrictEqual((await store.load("demo"))?.transcript.map((c) => c.text), ["hello"], MESSAGE);
});

test("finishing the session after a restart, before a hydrate, keeps the transcript saved before the restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, memory } = await restartWithBoardBound();

  memory.setStatus("finished");

  strictEqual(memory.getState().status, "finished");
  // Past every debounced save the finish could have scheduled.
  t.mock.timers.tick(5000);
  deepStrictEqual((await store.load("demo"))?.transcript.map((c) => c.text), ["hello"], MESSAGE);
});
