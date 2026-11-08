import { deepStrictEqual, strictEqual } from "node:assert";
import { test, type TestContext } from "node:test";
import type { MuralProjectionState, SessionState } from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import type { SnapshotStore } from "../memory/store.ts";
import type { MuralAuth } from "./auth.ts";
import { createLayoutState } from "./layout.ts";
import { MuralApiError, type MuralMcp } from "./muralMcp.ts";
import { MuralProjector } from "./MuralProjector.ts";
import { restoreMuralBinding } from "./restoreBinding.ts";

const EMBED_LINK = "https://app.mural.co/embed/00000000-0000-0000-0000-000000000000";

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

/** Mural is configured and connected, and every board has an embed link. No service is contacted. */
const connectedAuth = { configured: true, connected: async () => true } as unknown as MuralAuth;
const boardWithEmbedLink = {
  getMural: async (id: string) => ({ id, embedLink: EMBED_LINK }),
} as unknown as MuralMcp;

function savedSession(mural?: MuralProjectionState): SessionState {
  const state = emptySession("demo", "Before the restart");
  state.transcript.push({ id: "t-0001", ts: "2026-08-01T00:00:00Z", speaker: "Ana", text: "hello", seq: 1 });
  state.mural = mural;
  return state;
}

test("restoreMuralBinding() keeps the board's id and embed link, and resets the projection state", async () => {
  const store = inMemoryStore(
    savedSession({
      muralId: "workspace.12345",
      embedUrl: EMBED_LINK,
      lastProjectedRev: 7,
      widgets: {
        "order-placed": { widgetId: "w-1", container: "unplaced", x: 10, y: 20, text: "Order Placed" },
      },
      layout: {
        containers: {
          unplaced: { id: "unplaced", areaWidgetId: "a-1", x: 0, y: 0, width: 800, height: 400, laneCounts: [1], overflowCount: 0 },
        },
        nextAreaX: 900,
        hotspotCount: 2,
      },
    }),
  );
  const memory = new SessionMemory(new EventBus(), { snapshots: store });

  const restored = await restoreMuralBinding(memory, store, "demo");

  strictEqual(restored, "workspace.12345");
  deepStrictEqual(memory.muralState(), {
    muralId: "workspace.12345",
    embedUrl: EMBED_LINK,
    lastProjectedRev: 0,
    widgets: {},
    layout: createLayoutState(),
  });
});

test("restoreMuralBinding() binds nothing when there is no snapshot, or the snapshot has no board", async () => {
  for (const store of [inMemoryStore(), inMemoryStore(savedSession())]) {
    const memory = new SessionMemory(new EventBus(), { snapshots: store });
    strictEqual(await restoreMuralBinding(memory, store, "demo"), undefined);
    strictEqual(memory.muralState(), undefined);
  }
});

test("a backfilled embed link is saved with the next change to the session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = inMemoryStore(
    savedSession({ muralId: "workspace.12345", lastProjectedRev: 1, widgets: {}, layout: createLayoutState() }),
  );
  const bus = new EventBus();
  const memory = new SessionMemory(bus, { snapshots: store });
  await restoreMuralBinding(memory, store, "demo");
  await new MuralProjector(memory, bus, connectedAuth, boardWithEmbedLink).status();

  memory.appendChunk({ speaker: "Ana", text: "after the restart", ts: "2026-08-01T00:01:00Z" });
  t.mock.timers.tick(500);

  const saved = await store.load("demo");
  strictEqual(saved?.mural?.embedUrl, EMBED_LINK);
  deepStrictEqual(saved?.transcript.map((c) => c.text), ["after the restart"]);
});

test("a bind made while the server runs is saved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = inMemoryStore();
  const bus = new EventBus();
  const memory = new SessionMemory(bus, { snapshots: store });

  await new MuralProjector(memory, bus, connectedAuth, boardWithEmbedLink).bind("workspace.12345");
  t.mock.timers.tick(500);

  const saved = await store.load("demo");
  strictEqual(saved?.mural?.muralId, "workspace.12345");
  strictEqual(saved?.mural?.embedUrl, EMBED_LINK);
});

/** A store that records each save. It loads nothing. */
function recordingStore(): SnapshotStore & { saves: SessionState[] } {
  const saves: SessionState[] = [];
  return {
    saves,
    save: async (state) => {
      saves.push(structuredClone(state));
    },
    load: async () => null,
  };
}

/** A bound session with one projected sticky, whose own saves have already run. */
function boundSessionWithOneWidget(t: TestContext) {
  const store = recordingStore();
  const bus = new EventBus();
  const memory = new SessionMemory(bus, { snapshots: store });
  memory.setMuralState({ muralId: "workspace.12345", lastProjectedRev: 1, widgets: {}, layout: createLayoutState() });
  memory.upsertSticky({ id: "order-placed", kind: "domainEvent", text: "Order Placed" });
  memory.muralState()!.widgets["order-placed"] = {
    widgetId: "w-1",
    container: "unplaced",
    x: 999,
    y: 999,
    text: "Order Placed",
  };
  t.mock.timers.tick(500);
  strictEqual(store.saves.length, 1, "precondition: the setup saved once");
  return { store, bus, memory };
}

test("a tidy that moves a widget saves, and its response is unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, bus, memory } = boundSessionWithOneWidget(t);
  const patched: string[] = [];
  const client = {
    updateSticky: async (_muralId: string, widgetId: string) => {
      patched.push(widgetId);
    },
  } as unknown as MuralMcp;

  const result = await new MuralProjector(memory, bus, connectedAuth, client).tidy();

  deepStrictEqual(result, { moved: 1 });
  deepStrictEqual(patched, ["w-1"]);
  t.mock.timers.tick(500);
  strictEqual(store.saves.length, 2);
});

test("a tidy that moves only an area saves, and its response is unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = recordingStore();
  const bus = new EventBus();
  const memory = new SessionMemory(bus, { snapshots: store });
  const layout = createLayoutState();
  layout.containers.unplaced = {
    id: "unplaced",
    areaWidgetId: "a-1",
    x: 999,
    y: 999,
    width: 10,
    height: 10,
    laneCounts: [],
    overflowCount: 0,
  };
  memory.setMuralState({ muralId: "workspace.12345", lastProjectedRev: 1, widgets: {}, layout });
  // A sticky with no widget yet, so the tidy has an area to place and no sticky to move.
  memory.upsertSticky({ id: "order-placed", kind: "domainEvent", text: "Order Placed" });
  t.mock.timers.tick(500);
  strictEqual(store.saves.length, 1, "precondition: the setup saved once");
  const patched: string[] = [];
  const client = {
    updateArea: async (_muralId: string, widgetId: string) => {
      patched.push(widgetId);
    },
  } as unknown as MuralMcp;

  const result = await new MuralProjector(memory, bus, connectedAuth, client).tidy();

  deepStrictEqual(result, { moved: 0 });
  deepStrictEqual(patched, ["a-1"]);
  t.mock.timers.tick(500);
  strictEqual(store.saves.length, 2);
});

test("a tidy that heals a widget gone from the board saves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, bus, memory } = boundSessionWithOneWidget(t);
  const client = {
    updateSticky: async () => {
      throw new MuralApiError(404, "widget not found");
    },
  } as unknown as MuralMcp;
  // Disconnected, so the re-diff pass that a heal starts returns before any board call.
  const disconnectedAuth = { configured: true, connected: async () => false } as unknown as MuralAuth;

  const result = await new MuralProjector(memory, bus, disconnectedAuth, client).tidy();

  deepStrictEqual(result, { moved: 0 });
  strictEqual(memory.muralState()!.widgets["order-placed"], undefined, "the tidy did not forget the widget");
  t.mock.timers.tick(500);
  strictEqual(store.saves.length, 2);
});
