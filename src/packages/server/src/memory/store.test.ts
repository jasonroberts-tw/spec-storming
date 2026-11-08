import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { emptySession } from "@specstorming/shared";
import { SERVER_CONFIG } from "../config.ts";
import { NO_SNAPSHOTS, fileSnapshotStore } from "./store.ts";

/** A fresh directory under the OS temp dir, removed when the test ends. */
async function tempDataDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("fileSnapshotStore round-trips a save and a load, and writes only under its data dir", async (t) => {
  const dataDir = await tempDataDir(t);
  const id = "file-store-round-trip";
  const store = fileSnapshotStore(dataDir);
  const state = emptySession(id, "Round trip");
  state.transcript.push({ id: "t-0001", ts: "2026-08-01T00:00:00Z", speaker: "Ana", text: "hello", seq: 1 });
  state.revision = 3;

  await store.save(state);

  deepStrictEqual(await store.load(id), state);
  const written = (await readdir(dataDir, { recursive: true })).sort();
  deepStrictEqual(written, [
    "sessions",
    join("sessions", id),
    join("sessions", id, "session.json"),
  ]);
  strictEqual(
    existsSync(join(SERVER_CONFIG.repoRoot, "data", "sessions", id)),
    false,
    "the store wrote under the repository's data dir",
  );
});

test("fileSnapshotStore loads null for a session it never saved", async (t) => {
  const store = fileSnapshotStore(await tempDataDir(t));
  strictEqual(await store.load("never-saved"), null);
});

test("fileSnapshotStore loads null for a snapshot that is not valid JSON", async (t) => {
  const dataDir = await tempDataDir(t);
  const sessionDir = join(dataDir, "sessions", "corrupt");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.json"), '{"id": "corrupt", "transcript": [', "utf-8");

  strictEqual(await fileSnapshotStore(dataDir).load("corrupt"), null);
});

test("NO_SNAPSHOTS loads null", async () => {
  strictEqual(await NO_SNAPSHOTS.load("demo"), null);
});
