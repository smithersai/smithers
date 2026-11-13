import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import catalog from "../shadcn-provenance.json";

/**
 * The provenance manifests are metadata about which upstream registry item each
 * ported family came from, and which of its exports we kept. Exactly one of
 * them was verified against real code (`workflow-canvas.json`, checked inside
 * tests/workflow-canvas-components.test.tsx); the rest were free to name a
 * component that had since been renamed or deleted, because the script that was
 * supposed to check them (`scripts/check-ui-architecture.mjs`) is gone.
 *
 * This suite is the replacement. It holds two lines that do not need a script:
 * the catalog must list every lane file on disk, and every export a lane
 * declares must actually exist in the module it names.
 *
 * The check is "declared names resolve", not "declared equals runtime": the
 * manifests deliberately list type-only exports (erased before runtime) and
 * deliberately omit internal helpers a module also exports. Requiring equality
 * would fail on eleven modules for reasons that are not drift.
 */

const packageRoot = join(import.meta.dir, "..");

type ProvenanceEntry = {
  file: string;
  exports: string[];
  collection: string;
  registryItem: string | null;
  divergences: string[];
};

const entryFiles = catalog.policy.entryFiles;

/** Names a module exports as types, which disappear before `import()` sees it. */
function exportedTypeNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]!);
  }
  // `export { type A, type B } from "./x"` and `export type { A } from "./x"`.
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const clause of match[1]!.split(",")) {
      const name = clause.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function laneEntries(laneFile: string): ProvenanceEntry[] {
  return JSON.parse(readFileSync(join(packageRoot, laneFile), "utf8")) as ProvenanceEntry[];
}

describe("the provenance catalog", () => {
  test("lists exactly the lane manifests that exist on disk", () => {
    const onDisk = readdirSync(join(packageRoot, "provenance"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => `provenance/${name}`)
      .sort();
    expect([...entryFiles].sort()).toEqual(onDisk);
  });

  test("records at least one entry across the catalog for every ported module", () => {
    for (const laneFile of entryFiles) {
      expect(laneEntries(laneFile).length, laneFile).toBeGreaterThan(0);
    }
    const total = entryFiles.reduce((count, laneFile) => count + laneEntries(laneFile).length, 0);
    expect(total).toBeGreaterThanOrEqual(50);
  });

  test("names only collections and registries the policy approves", () => {
    const collections = new Set<string>(catalog.policy.collections);
    const registries = catalog.policy.registries;
    for (const laneFile of entryFiles) {
      for (const entry of laneEntries(laneFile)) {
        expect({ lane: laneFile, file: entry.file, known: collections.has(entry.collection) }).toEqual({
          lane: laneFile,
          file: entry.file,
          known: true,
        });
        // A null registryItem is the recorded shape for a smithers original,
        // which by definition has no upstream item to cite.
        const cited = entry.registryItem === null
          ? entry.divergences.some((note) => note.startsWith("smithers-original"))
          : registries.some((registry) => entry.registryItem!.startsWith(registry));
        expect({ file: entry.file, cited }).toEqual({ file: entry.file, cited: true });
      }
    }
  });
});

describe("every declared provenance export resolves in the module it names", () => {
  for (const laneFile of entryFiles) {
    for (const entry of laneEntries(laneFile)) {
      test(`${laneFile} -> ${entry.file}`, async () => {
        const modulePath = join(packageRoot, entry.file);
        const source = readFileSync(modulePath, "utf8");
        const runtime = new Set(Object.keys((await import(modulePath)) as Record<string, unknown>));
        const types = exportedTypeNames(source);
        const unresolved = entry.exports.filter((name) => !runtime.has(name) && !types.has(name));
        expect(unresolved).toEqual([]);
      });
    }
  }
});
