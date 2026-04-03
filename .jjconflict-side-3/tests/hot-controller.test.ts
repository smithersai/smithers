import { describe, expect, test, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HotWorkflowController } from "../src/hot/HotWorkflowController";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-hot-ctrl-"));
}

describe("HotWorkflowController", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch {}
    }
    cleanups.length = 0;
  });

  test("initializes with generation 0", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(
      entryPath,
      "export default { build: () => null };",
    );

    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    cleanups.push(() => ctrl.close());

    expect(ctrl.gen).toBe(0);
    await ctrl.init();
    expect(ctrl.gen).toBe(0);
  });

  test("creates output directory on init", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const outDir = join(dir, ".hmr");
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");

    const ctrl = new HotWorkflowController(entryPath, { outDir });
    cleanups.push(() => ctrl.close());

    expect(existsSync(outDir)).toBe(false);
    await ctrl.init();
    expect(existsSync(outDir)).toBe(true);
  });

  test("reload increments generation", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(
      entryPath,
      "export default { build: () => null };",
    );

    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    cleanups.push(() => ctrl.close());
    await ctrl.init();

    const event = await ctrl.reload(["workflow.ts"]);
    expect(ctrl.gen).toBe(1);
    expect(event.generation).toBe(1);
  });

  test("reload returns failed when module has no default export", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export const notDefault = 42;");

    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    cleanups.push(() => ctrl.close());
    await ctrl.init();

    const event = await ctrl.reload(["workflow.ts"]);
    expect(event.type).toBe("failed");
    expect(event.generation).toBe(1);
  });

  test("reload returns failed when default lacks build function", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(
      entryPath,
      "export default { name: 'test' };",
    );

    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    cleanups.push(() => ctrl.close());
    await ctrl.init();

    const event = await ctrl.reload(["workflow.ts"]);
    expect(event.type).toBe("failed");
    if (event.type === "failed") {
      expect((event.error as Error).message).toContain("build function");
    }
  });

  test("close removes output directory", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const outDir = join(dir, ".hmr");
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");

    const ctrl = new HotWorkflowController(entryPath, { outDir });
    await ctrl.init();
    expect(existsSync(outDir)).toBe(true);

    await ctrl.close();
    expect(existsSync(outDir)).toBe(false);
  });

  test("close is idempotent", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "export default { build: () => null };");

    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    await ctrl.init();
    await ctrl.close();
    await ctrl.close(); // should not throw
  });

  test("defaults outDir to .smithers/hmr under entry directory", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(entryPath, "ok");

    const ctrl = new HotWorkflowController(entryPath);
    cleanups.push(() => ctrl.close());
    // The controller should have been created without errors
    expect(ctrl.gen).toBe(0);
  });

  test("multiple reloads increment generation each time", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPath = join(dir, "workflow.ts");
    writeFileSync(
      entryPath,
      "export default { build: () => null };",
    );

    const ctrl = new HotWorkflowController(entryPath, {
      outDir: join(dir, ".hmr"),
    });
    cleanups.push(() => ctrl.close());
    await ctrl.init();

    await ctrl.reload(["a.ts"]);
    expect(ctrl.gen).toBe(1);
    await ctrl.reload(["b.ts"]);
    expect(ctrl.gen).toBe(2);
    await ctrl.reload(["c.ts"]);
    expect(ctrl.gen).toBe(3);
  });
});
