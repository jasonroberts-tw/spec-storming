import { z } from "zod";
import { datetimeRegex } from "zod/v3";

// zod 3's pattern, because zod 4's datetime check refuses forms that this route accepted under
// zod 3: an offset without a colon (+0200) and a time without seconds (10:00Z).
// chunkSchema.test.ts lists every form the route accepts and refuses.
const ISO_DATETIME = datetimeRegex({ offset: true });

// The body of POST /api/ingest/chunk.
export const ingestChunkSchema = z.object({
  speaker: z.string().trim().min(1, "speaker required"),
  text: z.string().trim().min(1, "text required"),
  ts: z.string().regex(ISO_DATETIME, "Invalid datetime").optional(),
});
