import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveSmithersCliEntryPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
}
