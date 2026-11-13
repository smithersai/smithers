import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The package's central architectural rule, stated in README.md and
 * src/README.md: heavy third-party renderers live under `adapters/` behind
 * their own package subpath and never weigh down the base barrel.
 *
 * Nothing enforced it. `scripts/check-ui-architecture.mjs`, the script both
 * READMEs named, was deleted in the 1.0 migration (package inventory row
 * `scripts/check-ui-architecture.mjs`, since deleted), and by the time
 * this ratchet was written `export * from "./vault"` was pulling `d3-force`
 * into `@smthrs/ui` through `KnowledgeGraph`.
 *
 * This is the replacement, and it measures the thing the rule is about: what a
 * bundler actually emits for a consumer. The build is deliberately
 * non-splitting, which is the mode this package is consumed in.
 */
const HEAVY_MODULES = [
  "node_modules/recharts",
  "node_modules/@xterm",
  // Milkdown, pierre and Shiki moved to `@smthrs/repo-view`, which this package
  // no longer depends on; the barrel must not grow them back.
  "node_modules/@milkdown",
  "node_modules/@pierre/diffs",
  "node_modules/d3-force",
  "node_modules/@codemirror",
  "node_modules/@lezer",
  "node_modules/yjs",
  "node_modules/y-codemirror.next",
] as const;

/**
 * Warnings from the most recent bundle, kept so a failure can say WHY.
 *
 * A dynamic `import()` the bundler cannot resolve is externalized with a
 * warning rather than failing the build, so a green build says nothing about
 * whether the module made it in.
 */
let lastBuildLogs: ReadonlyArray<string> = [];

/**
 * Bundle a module the way a consumer reaches it: through an entry that imports
 * the namespace and retains it.
 *
 * Handing the bundler a re-export-only barrel directly is not a measurement.
 * It emits the export list with no bodies at all (7 KB, zero functions),
 * because nothing in the graph is retained, so every "is X absent" assertion
 * would pass against an empty bundle. A consuming entry is the honest shape:
 * this one builds to about 1 MB with ~900 functions.
 *
 * The bundle runs in a FRESH bun process, never through in-process `Bun.build`.
 *
 * Bun's bundler shares its file cache with the test runner's module registry:
 * once any suite has imported these modules at runtime — `barrel-reachability.test.ts`
 * imports the whole barrel, and `bun test` runs all 105 files in one process —
 * a later in-process `Bun.build` reads crossed content and drops modules it
 * cannot parse ("Unexpected reading file" for react, "EISDIR" for clsx, a
 * `./types` import reported at `react/index.js:7`). The knowledge-graph
 * control then measured a bundle that never had d3-force in it: green when
 * this file ran alone, red under `bun test tests` on CI (run 33656132180).
 * Bun 1.3.14 and 1.4.0 both do it, Linux and macOS alike.
 *
 * A subprocess is also the honest shape: a consumer's bundle is a build, not
 * a call inside a test runner that already loaded half the graph.
 */
function bundleAsConsumed(modulePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "smithers-ui-barrel-"));
  try {
    const entry = join(dir, "entry.ts");
    const packageRoot = resolve(import.meta.dir, "..");
    const target = resolve(packageRoot, modulePath);
    writeFileSync(
      entry,
      `import * as surface from ${JSON.stringify(target)};\n(globalThis as Record<string, unknown>).__surface = surface;\n`,
    );
    const built = Bun.spawnSync({
      cmd: [process.execPath, "build", "--target=browser", entry],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    lastBuildLogs = built.stderr.toString().split("\n").filter((line) => line.trim() !== "");
    if (built.exitCode !== 0) {
      throw new Error(`could not bundle ${modulePath}:\n${lastBuildLogs.join("\n")}`);
    }
    return built.stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the base barrel carries no heavy renderer", () => {
  test("a consumer of src/index.ts bundles none of the adapter dependencies", () => {
    const bundle = bundleAsConsumed("src/index.ts");
    // Guard the guard: an empty bundle would satisfy every assertion below.
    expect(bundle.length).toBeGreaterThan(200_000);
    /*
     * And guard the detector: every assertion below reads a `node_modules/…`
     * path out of the bundle, so a build that stopped emitting those paths
     * would answer "no heavy renderer here" about a bundle full of them.
     */
    expect(bundle).toContain("node_modules/react");
    expect(HEAVY_MODULES.filter((module) => bundle.includes(module))).toEqual([]);
  }, 120_000);

  test("every heavy renderer is reachable through its own subpath", async () => {
    const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).toEqual(
      expect.arrayContaining([
        "./adapters/chart",
        "./adapters/knowledge-graph",
        "./adapters/terminal",
        "./adapters/code-editor",
      ]),
    );
  });

  test("the knowledge-graph subpath does bundle d3-force", () => {
    // The control: the negative assertion above only means something while the
    // dependency is genuinely reachable from somewhere in this package.
    const bundle = bundleAsConsumed("src/adapters/knowledge-graph.ts");
    // d3-force reaches this bundle ONLY through a runtime `import("d3-force")`
    // — every static reference in KnowledgeGraph.tsx is a type and is erased.
    // Bun externalizes a dynamic import it cannot resolve instead of failing,
    // so assert on the whole picture: a bare `toContain` on a green build
    // cannot distinguish "not bundled" from "not resolvable".
    expect({
      bundled: bundle.includes("node_modules/d3-force"),
      externalized: /import\(\s*["']d3-force["']\s*\)/.test(bundle),
      bytes: bundle.length,
      logs: lastBuildLogs,
    }).toMatchObject({ bundled: true, externalized: false });
  }, 120_000);
});


test("the code-editor control bundles its CodeMirror and Lezer parsers", () => {
  const bundle = bundleAsConsumed("src/adapters/code-editor/index.tsx");
  expect(bundle).toContain("node_modules/@codemirror");
  expect(bundle).toContain("node_modules/@lezer");
  expect(bundle).not.toContain("node_modules/yjs");
}, 120_000);
