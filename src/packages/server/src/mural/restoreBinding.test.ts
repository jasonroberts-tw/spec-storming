/**
 * Reproduces ss-oei: at startup with a Mural board bound, restoring the binding scheduled a
 * save that wrote the fresh, empty session over the saved snapshot, so a later
 * POST /api/session/hydrate (which reads the same store) restored an empty transcript.
 */
import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import type { SessionState } from "@specstorming/shared";
import { emptySession } from "@specstorming/shared";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import type { SnapshotStore } from "../memory/store.ts";
import { createLayoutState } from "./layout.ts";
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

test("restoring the Mural binding at startup keeps the transcript saved before the restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const beforeRestart = emptySession("demo", "Before the restart");
  beforeRestart.transcript.push({ id: "t-0001", ts: "2026-08-01T00:00:00Z", speaker: "Ana", text: "hello", seq: 1 });
  beforeRestart.mural = {
    muralId: "workspace.12345",
    lastProjectedRev: 1,
    widgets: {},
    layout: createLayoutState(),
  };
  const store = inMemoryStore(beforeRestart);
  // The restarted server's session: fresh and empty, persisting to the same store.
  const memory = new SessionMemory(new EventBus(), { snapshots: store });

  const restored = await restoreMuralBinding(memory, store, "demo");

  strictEqual(restored, "workspace.12345");
  strictEqual(memory.muralState()?.muralId, "workspace.12345", "the binding was not restored");
  // Past every debounced save the restore could have scheduled.
  t.mock.timers.tick(5000);
  const afterRestart = await store.load("demo");
  deepStrictEqual(
    afterRestart?.transcript.map((c) => c.text),
    ["hello"],
    "the snapshot no longer holds the transcript saved before the restart",
  );
});
