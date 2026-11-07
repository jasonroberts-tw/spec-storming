import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionState } from "@specstorming/shared";
import { SERVER_CONFIG } from "../config.ts";

function sessionFile(id: string): string {
  return join(SERVER_CONFIG.repoRoot, "data", "sessions", id, "session.json");
}

export async function saveSnapshot(state: SessionState): Promise<void> {
  const file = sessionFile(state.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf-8");
}

export async function loadSnapshot(id: string): Promise<SessionState | null> {
  try {
    const raw = await readFile(sessionFile(id), "utf-8");
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}
