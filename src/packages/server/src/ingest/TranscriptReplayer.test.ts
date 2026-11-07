import { ok, rejects, strictEqual } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { EventBus } from "../bus/EventBus.ts";
import { SessionMemory } from "../memory/SessionMemory.ts";
import { TranscriptReplayer } from "./TranscriptReplayer.ts";

test("discovers selectable transcripts and loads the insurance demo", async () => {
  const replayer = new TranscriptReplayer(new SessionMemory(new EventBus()));
  const catalog = await replayer.list();

  ok(catalog.some((transcript) => transcript.id === "acme-orders"));
  const insurance = catalog.find(
    (transcript) => transcript.id === "insurance-product-lifecycle",
  );
  ok(insurance, "insurance transcript is discoverable");
  ok(insurance.lineCount >= 120, "insurance transcript is sufficiently detailed");

  await replayer.load("insurance-product-lifecycle");
  strictEqual(replayer.selectedId, "insurance-product-lifecycle");
  await rejects(() => replayer.load("../outside"), /Invalid transcript id/);
});

test("insurance demo completes events, commands, hotspots, policies, and screens per sub-domain", async () => {
  const file = new URL(
    "./transcripts/insurance-product-lifecycle.transcript.json",
    import.meta.url,
  );
  const lines = JSON.parse(await readFile(file, "utf-8")) as { text: string }[];
  const starts = lines
    .map((line, index) => (line.text.startsWith("Sub-domain ") ? index : -1))
    .filter((index) => index >= 0);

  strictEqual(starts.length, 8);
  for (let section = 0; section < starts.length; section += 1) {
    const segment = lines.slice(starts[section], starts[section + 1] ?? lines.length);
    const commands = segment.findIndex((line) => line.text.includes("Events complete. Now commands"));
    const hotspots = segment.findIndex((line) => line.text.includes("hotspots."));
    const policies = segment.findIndex((line) => line.text.includes("policies and invariants."));
    const screens = segment.findIndex((line) => line.text.includes("screens"));
    const coherent = segment.findIndex((line) => line.text.includes("is coherent."));

    ok(commands > 0, `sub-domain ${section + 1} has a commands phase`);
    ok(hotspots > commands, `sub-domain ${section + 1} puts hotspots after commands`);
    ok(policies > hotspots, `sub-domain ${section + 1} puts policies after hotspots`);
    ok(screens > policies, `sub-domain ${section + 1} puts screens after policies`);
    ok(coherent > screens, `sub-domain ${section + 1} closes after screens`);
  }
});
