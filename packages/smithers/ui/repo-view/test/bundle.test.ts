// What a page that shows a repository loads first. A consumer's bundler splits at dynamic imports, so the views'
// entry carries React, pierre and Shiki's engine, while the Milkdown editor, Shiki's grammars and themes, and the
// VibeLang grammar load only when a view needs them. The bundle runs in a fresh Bun process: an in-process
// `Bun.build` shares the test runner's file cache and reads crossed content (see @smthrs/ui's barrel-weight test).
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the repository view's entry chunk leaves Milkdown and every grammar to later chunks", () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-repo-view-bundle-"));
  try {
    const packageRoot = resolve(import.meta.dir, "..");
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import { RepoView } from ${JSON.stringify(join(packageRoot, "src/index.ts"))};\n` +
        "(globalThis as Record<string, unknown>).__view = RepoView;\n",
    );
    const built = Bun.spawnSync({
      cmd: [process.execPath, "build", "--target=browser", "--splitting", "--outdir", join(dir, "out"), entry],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(built.exitCode === 0 ? "built" : built.stderr.toString()).toBe("built");
    const chunks = readdirSync(join(dir, "out")).map((name) => readFileSync(join(dir, "out", name), "utf8"));
    const first = readFileSync(join(dir, "out", "entry.js"), "utf8");
    // Guard the detector: the entry names the modules it bundles, so a missing path means a missing module.
    expect(first).toContain("node_modules/react");
    expect({
      pierreDiffs: first.includes("node_modules/@pierre/diffs"),
      milkdown: first.includes("node_modules/@milkdown"),
      grammar: /"scopeName": ?"/.test(first),
      vibe: first.includes("source.vibe"),
      underThreeMegabytes: first.length < 3_000_000,
    }).toEqual({ pierreDiffs: false, milkdown: false, grammar: false, vibe: false, underThreeMegabytes: true });
    // And they are still there, one dynamic import away.
    expect(chunks.some((chunk) => chunk.includes("node_modules/@pierre/diffs"))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("node_modules/@milkdown/crepe"))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("source.vibe"))).toBe(true);
    expect(chunks.filter((chunk) => /"scopeName": ?"/.test(chunk)).length).toBeGreaterThan(100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
