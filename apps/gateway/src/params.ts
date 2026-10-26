import { z } from "zod";

const uuidSchema = z.string().uuid();

export function uuidParam(value: unknown): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
