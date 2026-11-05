import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SERVER_CONFIG } from "../config.ts";
import type { SessionMemory } from "../memory/SessionMemory.ts";

export interface RawTranscriptLine {
  speaker: string;
  text: string;
}

export interface TranscriptSummary {
  id: string;
  label: string;
  lineCount: number;
  estimatedSeconds: number;
}

const TRANSCRIPT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRANSCRIPT_SUFFIX = ".transcript.json";

function transcriptDirectory() {
  return join(SERVER_CONFIG.repoRoot, "packages/server/src/ingest/transcripts");
}

function transcriptLabel(id: string) {
  return id
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function parseTranscript(raw: string, id: string): RawTranscriptLine[] {
  const value = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (line) =>
        typeof line !== "object" ||
        line === null ||
        typeof (line as RawTranscriptLine).speaker !== "string" ||
        !(line as RawTranscriptLine).speaker.trim() ||
        typeof (line as RawTranscriptLine).text !== "string" ||
        !(line as RawTranscriptLine).text.trim(),
    )
  ) {
    throw new Error(`Transcript "${id}" must be a non-empty array of speaker/text lines`);
  }
  return value as RawTranscriptLine[];
}

/**
 * Replays a canned transcript into SessionMemory one line at a time, simulating a
 * live meeting feed. At 1×, one transcript line is emitted every second.
 */
export class TranscriptReplayer {
  private static readonly BASE_INTERVAL_MS = 1000;
  private lines: RawTranscriptLine[] = [];
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remainingInRun: number | null = null;
  private currentTranscriptId = "";
  private catalog: TranscriptSummary[] | null = null;

  constructor(private readonly memory: SessionMemory) {}

  async load(transcriptId = "acme-orders"): Promise<void> {
    if (!TRANSCRIPT_ID.test(transcriptId)) throw new Error("Invalid transcript id");
    this.pause();
    const file = join(transcriptDirectory(), `${transcriptId}${TRANSCRIPT_SUFFIX}`);
    const raw = await readFile(file, "utf-8");
    this.lines = parseTranscript(raw, transcriptId);
    this.cursor = 0;
    this.currentTranscriptId = transcriptId;
  }

  /**
   * The selectable transcript catalog. Memoized — the picker asks on every page load and the
   * shipped transcripts don't change under a running server. A file that fails to parse is
   * skipped rather than failing the whole catalog, so one bad transcript can't hide the rest.
   */
  async list(): Promise<TranscriptSummary[]> {
    if (this.catalog) return this.catalog;
    const files = (await readdir(transcriptDirectory()))
      .filter((file) => file.endsWith(TRANSCRIPT_SUFFIX))
      .sort();
    const summaries = await Promise.all(
      files.map(async (file) => {
        const id = file.slice(0, -TRANSCRIPT_SUFFIX.length);
        try {
          const lines = parseTranscript(
            await readFile(join(transcriptDirectory(), file), "utf-8"),
            id,
          );
          return {
            id,
            label: transcriptLabel(id),
            lineCount: lines.length,
            estimatedSeconds: (lines.length * TranscriptReplayer.BASE_INTERVAL_MS) / 1000,
          };
        } catch (error) {
          console.warn(
            `[replayer] skipping unreadable transcript "${id}":`,
            error instanceof Error ? error.message : error,
          );
          return null;
        }
      }),
    );
    this.catalog = summaries.filter((entry): entry is TranscriptSummary => entry !== null);
    return this.catalog;
  }

  get selectedId(): string {
    return this.currentTranscriptId;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get done(): boolean {
    return this.cursor >= this.lines.length;
  }

  start(): void {
    if (this.timer || this.done) return;
    this.remainingInRun = null;
    this.emitNextInRun();
  }

  startForSeconds(seconds: 30 | 120): void {
    if (this.done) return;
    this.pause();
    this.remainingInRun = seconds;
    this.emitNextInRun();
  }

  pause(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.remainingInRun = null;
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emitNextInRun();
    }, TranscriptReplayer.BASE_INTERVAL_MS);
  }

  private emitNextInRun(): void {
    if (this.done || this.remainingInRun === 0) {
      this.remainingInRun = null;
      return;
    }
    this.emitNext();
    if (this.remainingInRun !== null) this.remainingInRun -= 1;
    if (!this.done && this.remainingInRun !== 0) this.scheduleNext();
    else this.remainingInRun = null;
  }

  private emitNext(): void {
    if (this.done) return;
    const line = this.lines[this.cursor];
    this.cursor += 1;
    this.memory.appendChunk({ speaker: line.speaker, text: line.text });
  }
}
