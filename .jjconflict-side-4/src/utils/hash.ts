import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  const hash = createHash("sha256");
  hash.update(input);
  return hash.digest("hex");
}
