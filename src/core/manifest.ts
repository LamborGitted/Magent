import { randomUUID } from "node:crypto";
import { z } from "zod";

export const environmentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const environmentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().regex(environmentNamePattern),
  createdAt: z.iso.datetime(),
});

export type EnvironmentManifest = z.infer<typeof environmentManifestSchema>;

export function createManifest(name: string): EnvironmentManifest {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
  };
}

export function validateEnvironmentName(name: string): void {
  if (!environmentNamePattern.test(name)) {
    throw new Error(
      `Invalid environment name "${name}". Use letters, numbers, dots, underscores, or hyphens.`,
    );
  }
}
