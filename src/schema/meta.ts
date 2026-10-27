import { z } from "zod";

export const MetaSchema = z.object({
  fetchedAt: z.string(),
});
export type Meta = z.infer<typeof MetaSchema>;
