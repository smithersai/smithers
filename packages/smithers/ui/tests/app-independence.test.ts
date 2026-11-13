import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appIndependenceRules } from "../scripts/app-independence-rules";

const checker = resolve(import.meta.dir, "../../../repo-targets/scripts/import-rules.mjs");

async function runChecker(directory: string) {
    const child = Bun.spawn(["node", checker, "packages/smithers/ui", JSON.stringify(appIndependenceRules)], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
}

async function check(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "ui-import-rules-"));
  const packageDirectory = join(directory, "packages/smithers/ui");
  try {
    await mkdir(join(directory, "apps/mvp/src"), { recursive: true });
    await writeFile(join(directory, "apps/mvp/src/state.ts"), "export const state = 1;");
    for (const [name, source] of Object.entries(files)) {
      const path = join(packageDirectory, name);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, source);
    }
    return await runChecker(packageDirectory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each([
  ["relative import", "src/bridge.ts", 'import { state as renamed } from "../../../../apps/mvp/src/state";'],
  ["nested relative import", "src/a/b/bridge.ts", 'import { state } from "../../../../../../apps/mvp/src/state";'],
  ["deep relative import", "src/a/b/c/d/e/bridge.ts", 'import { state } from "../../../../../../../../../apps/mvp/src/state";'],
  ["leading dot import", "src/bridge.ts", 'import { state } from "./../../../../apps/mvp/src/state";'],
  ["interior parent import", "src/bridge.ts", 'import { state } from "../../../../packages/../apps/mvp/src/state";'],
  ["package re-export", "src/bridge.ts", 'export { state as renamed } from "@smthrs/mvp";'],
  ["dynamic relative import", "src/bridge.ts", 'void import("../../../../apps/mvp/src/state");'],
  ["dynamic package import", "src/bridge.ts", 'void import("@smthrs/mvp/state");'],
  ["renamed store import", "src/bridge.ts", 'import { useStore as renamed } from "zustand";'],
])("the package guard rejects a %s through a local bridge", async (_name, bridge, source) => {
  const result = await check({
    [bridge]: source,
    "src/adapters/terminal.ts": `export * from "../${bridge.slice(4, -3)}";`,
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain(`${bridge}:1`);
  expect(result.output).toContain("(forbid)");
}, 30_000);

test("the package guard permits generic dependencies and local props", async () => {
  const result = await check({
    "src/props.ts": "export const label = 'Shell';",
    "src/adapters/terminal.ts": 'import { label } from "../props"; import { Terminal } from "@xterm/xterm";',
  });
  expect(result.code).toBe(0);
  expect(result.output).toContain("ImportRules passed");
}, 30_000);


test("the component sources obey the package app-independence rules", async () => {
  const result = await runChecker(resolve(import.meta.dir, ".."));
  expect(result.code).toBe(0);
  expect(result.output).toContain("ImportRules passed");
}, 30_000);
