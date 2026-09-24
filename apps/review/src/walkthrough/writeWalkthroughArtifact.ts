import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walkthroughArtifactsDir } from "./walkthroughArtifactsDir.ts";

function atomicWrite(path: string, html: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, html, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Retains a unique artifact for this render and atomically replaces the public
 * output. A durable replay returns the recorded artifact path; another render
 * gets a new one, so publication never reads another run's public output.
 */
export function writeWalkthroughArtifact(outPath: string, html: string): string {
  const artifacts = walkthroughArtifactsDir(outPath);
  mkdirSync(artifacts, { recursive: true });
  const artifactPath = join(artifacts, `${randomUUID()}.html`);
  atomicWrite(artifactPath, html);
  atomicWrite(outPath, html);
  return artifactPath;
}
