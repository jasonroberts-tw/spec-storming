import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionState } from "@specstorming/shared";

/** Where SessionMemory persists its state, and where the server reads it back. */
export interface SnapshotStore {
  save(state: SessionState): Promise<void>;
  load(id: string): Promise<SessionState | null>;
}

/**
 * A store that writes nothing and loads nothing. It is SessionMemory's default, so a test that
 * builds a SessionMemory leaves no file behind. Frozen, so no test can patch the shared default.
 */
export const NO_SNAPSHOTS: SnapshotStore = Object.freeze({
  save: async () => {},
  load: async () => null,
});

/** One JSON file per session, at `<dataDir>/sessions/<id>/session.json`. */
export function fileSnapshotStore(dataDir: string): SnapshotStore {
  const sessionFile = (id: string): string => join(dataDir, "sessions", id, "session.json");
  return {
    async save(state) {
      const file = sessionFile(state.id);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(state, null, 2), "utf-8");
    },
    async load(id) {
      try {
        const raw = await readFile(sessionFile(id), "utf-8");
        return JSON.parse(raw) as SessionState;
      } catch {
        return null;
      }
    },
  };
}
