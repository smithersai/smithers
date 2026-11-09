/**
 * Lean backend commands: gen, check.
 */

import { existsSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";

export function leanGen(typesPath: string | null, defPath: string, typesText: string | null, defText: string) {
  if (typesPath && typesText) {
    writeFileSync(typesPath, typesText);
    console.log(`Generated: ${typesPath}`);
  }
  writeFileSync(defPath, defText);
  console.log(`Generated: ${defPath}`);
}

/** Find the nearest ancestor containing either supported Lake configuration. */
export function findLakeProjectRoot(dir: string): string | null {
  let candidate = path.resolve(dir);
  while (true) {
    if (existsSync(path.join(candidate, "lakefile.lean")) ||
        existsSync(path.join(candidate, "lakefile.toml"))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    // Check the filesystem root above before terminating the search.
    if (parent === candidate) return null;
    candidate = parent;
  }
}

export function leanCheck(dir: string, base: string): boolean {
  const proofPath = path.join(dir, `${base}.proof.lean`);
  if (!existsSync(proofPath)) {
    console.error(`No proof file: ${proofPath}`);
    return false;
  }

  const lakeDir = findLakeProjectRoot(dir);
  if (lakeDir === null) {
    console.error(
      `No Lake project found for ${path.resolve(dir)}: expected lakefile.lean or lakefile.toml ` +
      "in this directory or an ancestor. Run this check inside a Lake project; lake was not started.",
    );
    return false;
  }

  console.log("Running lake build...");
  try {
    execFileSync("lake", ["build"], { cwd: lakeDir, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}
