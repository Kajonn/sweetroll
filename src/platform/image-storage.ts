import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Private runtime bytes. Deployment must mount and verify a durable volume. */
export function resolveMediaRoot(): string {
  const override = process.env.SWEETROLL_MEDIA_DIR;
  if (override) return resolve(override);
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "data",
    "media",
  );
}
