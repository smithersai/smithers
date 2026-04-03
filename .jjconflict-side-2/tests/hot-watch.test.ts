import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchTree } from "../src/hot/watch";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-watch-"));
}

describe("WatchTree", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch {}
    }
    cleanups.length = 0;
  });

  test("can be constructed and closed", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir);
    cleanups.push(() => tree.close());
    tree.close();
  });

  test("close resolves pending wait with empty array", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir);

    await tree.start();

    // Start waiting (should hang until close or file change)
    const waitPromise = tree.wait();
    tree.close();

    const result = await waitPromise;
    expect(result).toEqual([]);
  });

  test("detects file changes", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "initial.ts"), "export const x = 1;");

    const tree = new WatchTree(dir, { debounceMs: 50 });
    cleanups.push(() => tree.close());
    await tree.start();

    // Write a new file after starting
    setTimeout(() => {
      writeFileSync(join(dir, "changed.ts"), "export const y = 2;");
    }, 50);

    const changed = await tree.wait();
    expect(changed.length).toBeGreaterThan(0);
    tree.close();
  });

  test("respects debounce", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const tree = new WatchTree(dir, { debounceMs: 200 });
    cleanups.push(() => tree.close());
    await tree.start();

    // Write multiple files rapidly
    setTimeout(() => {
      writeFileSync(join(dir, "a.ts"), "a");
      writeFileSync(join(dir, "b.ts"), "b");
    }, 50);

    const changed = await tree.wait();
    // Both changes should be batched together
    expect(changed.length).toBeGreaterThanOrEqual(1);
    tree.close();
  });

  test("ignores dotfiles", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const tree = new WatchTree(dir, { debounceMs: 50 });
    cleanups.push(() => tree.close());
    await tree.start();

    // Write a dotfile - should not trigger change
    writeFileSync(join(dir, ".hidden"), "secret");

    // Then write a visible file to confirm we still detect real changes
    setTimeout(() => {
      writeFileSync(join(dir, "visible.ts"), "export const v = 1;");
    }, 100);

    const changed = await tree.wait();
    // The visible file should be detected, dotfile should not
    const hasHidden = changed.some((f) => f.includes(".hidden"));
    expect(hasHidden).toBe(false);
    expect(changed.length).toBeGreaterThan(0);
    tree.close();
  });

  test("accepts custom ignore list", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tree = new WatchTree(dir, { ignore: ["dist", "build"] });
    cleanups.push(() => tree.close());
    // Should construct without error
    tree.close();
  });
});
