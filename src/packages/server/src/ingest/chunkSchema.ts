import { z } from "zod";
import { datetimeRegex } from "zod/v3";

// zod 3's pattern, because zod 4's datetime check refuses three kinds of value that this route
// accepted under zod 3: an offset without a colon (+0200), a time without seconds (10:00Z), and an
// offset outside 00:00 to 23:59 (+24:00). chunkSchema.test.ts has an example of each.
const ISO_DATETIME = datetimeRegex({ offset: true });

// The body of POST /api/ingest/chunk.
export const ingestChunkSchema = z.object({
  speaker: z.string().trim().min(1, "speaker required"),
  text: z.string().trim().min(1, "text required"),
  ts: z.string().regex(ISO_DATETIME, "Invalid datetime").optional(),
});
