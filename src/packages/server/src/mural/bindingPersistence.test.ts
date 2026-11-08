import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import type { MuralProjectionState, SessionState } from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import type { SnapshotStore } from "../memory/store.ts";
import type { MuralAuth } from "./auth.ts";
import { createLayoutState } from "./layout.ts";
import type { MuralMcp } from "./muralMcp.ts";
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
