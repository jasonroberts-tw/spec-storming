import type { SessionMemory } from "../memory/SessionMemory.ts";
import type { SnapshotStore } from "../memory/store.ts";
import { createLayoutState } from "./layout.ts";

/**
 * Restore the Mural binding from the last snapshot so the projector survives server
 * restarts without the user having to re-bind. Widgets/layout/lastProjectedRev are
 * reset so a fresh replay starts with a clean incremental diff (no stale widget IDs).
 *
 * The restore schedules no save. The session in memory is still the empty startup session, so
 * a save would replace the snapshot, and POST /api/session/hydrate would then restore an empty
 * transcript. The next change to the session saves the binding along with it.
 *
 * Returns the restored mural's id, or undefined when the snapshot binds no mural.
 */
export async function restoreMuralBinding(
  memory: SessionMemory,
  snapshots: SnapshotStore,
  sessionId: string,
): Promise<string | undefined> {
  const saved = await snapshots.load(sessionId);
  if (!saved?.mural?.muralId) return undefined;
  memory.setMuralState(
    {
      muralId: saved.mural.muralId,
      embedUrl: saved.mural.embedUrl,
      lastProjectedRev: 0,
      widgets: {},
      layout: createLayoutState(),
    },
    { save: false },
  );
  return saved.mural.muralId;
}
