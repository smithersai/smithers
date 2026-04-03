import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";

const desktopRoot = join(import.meta.dir, "..");
const localNodeModulesDir = join(desktopRoot, "node_modules");
const localElectrobunPath = join(localNodeModulesDir, "electrobun");
const hoistedElectrobunPath = join(desktopRoot, "..", "..", "node_modules", "electrobun");

if (!existsSync(hoistedElectrobunPath)) {
  throw new Error(
    `[desktop] Missing hoisted electrobun dependency at ${hoistedElectrobunPath}. Run "bun install" from the repo root.`,
  );
}

mkdirSync(localNodeModulesDir, { recursive: true });

if (existsSync(localElectrobunPath)) {
  const existingStats = lstatSync(localElectrobunPath);
  if (existingStats.isSymbolicLink()) {
    process.exit(0);
  }

  rmSync(localElectrobunPath, { recursive: true, force: true });
}

const symlinkTarget = relative(localNodeModulesDir, hoistedElectrobunPath);
const symlinkType = process.platform === "win32" ? "junction" : "dir";
symlinkSync(symlinkTarget, localElectrobunPath, symlinkType);
