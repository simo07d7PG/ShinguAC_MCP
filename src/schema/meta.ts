import { z } from "zod";

export const MetaSchema = z.object({
  fetchedAt: z.string(),
  stale: z.boolean(),
  source: z.enum(["live", "snapshot"]),
  warning: z.string().optional(),
});
export type Meta = z.infer<typeof MetaSchema>;
