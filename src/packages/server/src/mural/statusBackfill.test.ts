/**
 * Reproduces the second path of ss-oei. A board bound while Mural embedding was off leaves the
 * snapshot's binding with no embedUrl. After a restart, the web app polls GET /api/mural/status,
 * and MuralProjector.status() backfills the embed link. The backfill saved the whole session,
 * which was still the empty startup session, over the snapshot.
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

/** Mural is configured and connected, and the board now has an embed link. No service is contacted. */
const connectedAuth = { configured: true, connected: async () => true } as unknown as MuralAuth;
const boardWithEmbedLink = {
  getMural: async (id: string) => ({ id, embedLink: EMBED_LINK }),
} as unknown as MuralMcp;

test("a Mural status poll after a restart keeps the transcript saved before the restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const beforeRestart = emptySession("demo", "Before the restart");
  beforeRestart.transcript.push({ id: "t-0001", ts: "2026-08-01T00:00:00Z", speaker: "Ana", text: "hello", seq: 1 });
  // Bound while embedding was off, so the saved binding has no embedUrl.
  beforeRestart.mural = {
    muralId: "workspace.12345",
    lastProjectedRev: 1,
    widgets: {},
    layout: createLayoutState(),
  };
  const store = inMemoryStore(beforeRestart);
  // The restarted server: a fresh, empty session that persists to the same store.
  const bus = new EventBus();
  const memory = new SessionMemory(bus, { snapshots: store });
  await restoreMuralBinding(memory, store, "demo");
  const projector = new MuralProjector(memory, bus, connectedAuth, boardWithEmbedLink);

  const status = await projector.status();

  strictEqual(status.state, "bound");
  strictEqual(status.embedUrl, EMBED_LINK, "the status poll did not backfill the embed link");
  // Past every debounced save the poll could have scheduled.
  t.mock.timers.tick(5000);
  const afterRestart = await store.load("demo");
  deepStrictEqual(
    afterRestart?.transcript.map((c) => c.text),
    ["hello"],
    "the snapshot no longer holds the transcript saved before the restart",
  );
});
