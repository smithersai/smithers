import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { createVitest } from "vitest/node"

for (const fails of [false, true]) {
  for (const shared of [false, true]) {
    test(`test scratch and ${shared ? "shared" : "owned"} loader caches after ${fails ? "failure" : "success"}`, async () => {
      const parent = resolve(".cache")
      mkdirSync(parent, { recursive: true })
      const root = mkdtempSync(join(parent, "process-cache-cleanup-"))
      const before = [process.env.NODE_COMPILE_CACHE, process.env.TMPDIR, process.env.TMP, process.env.TEMP]
      const compileCache = shared ? join(root, "outer-node-compile-cache") : undefined
      const require = createRequire(import.meta.resolve("vitest/package.json"))
      const tsx = createRequire(require.resolve("vite/package.json")).resolve("tsx")
      const receipt = join(root, "scratch-path")
      const previousExitCode = process.exitCode
      let runner
      let owned
      try {
        if (compileCache === undefined) delete process.env.NODE_COMPILE_CACHE
        else process.env.NODE_COMPILE_CACHE = compileCache
        writeFileSync(join(root, "fixture.ts"), "const answer: number = 42; console.log(answer)")
        writeFileSync(
          join(root, "case.test.js"),
          `
        import { test, expect } from 'vitest';
        import { execFileSync } from 'node:child_process';
        import { readdirSync, writeFileSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { basename, join } from 'node:path';
        test('worker environment and actual loaders', () => {
          expect(basename(tmpdir())).toMatch(/^st-/);
          expect(process.env.TMP).toBe(tmpdir());
          expect(process.env.TEMP).toBe(tmpdir());
          writeFileSync(${JSON.stringify(receipt)}, tmpdir());
          expect(process.env.NODE_COMPILE_CACHE).toBe(${
            shared ? JSON.stringify(compileCache) : "join(tmpdir(), 'node-compile-cache')"
          });
          writeFileSync(join(tmpdir(), 'fixture-leftover'), 'owned by the run');
          const env = { ...process.env };
          delete env.NODE_DISABLE_COMPILE_CACHE;
          delete env.TSX_DISABLE_CACHE;
          const status = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', "import { enableCompileCache } from 'node:module'; console.log(JSON.stringify(enableCompileCache()))"], {env, encoding:'utf8'}));
          expect(status.directory.startsWith(process.env.NODE_COMPILE_CACHE)).toBe(true);
          expect(execFileSync(process.execPath, ['--import', ${JSON.stringify(pathToFileURL(tsx).href)}, ${
            JSON.stringify(join(root, "fixture.ts"))
          }], {env, encoding:'utf8'}).trim()).toBe('42');
          expect(readdirSync(tmpdir()).some(name => name.startsWith('tsx-'))).toBe(true);
          expect(1).toBe(${fails ? 2 : 1});
        });
      `
        )
        runner = await createVitest("test", {
          config: false,
          root,
          watch: false,
          include: ["case.test.js"],
          reporters: [],
          maxWorkers: 1,
          globalSetup: [resolve("test-utils/test-process-environment.mjs")],
          coverage: { enabled: false }
        })
        await runner.start()
        owned = readFileSync(receipt, "utf8")
        assert.equal(runner.state.getCountOfFailedTests() > 0, fails)
        assert.equal(existsSync(join(owned, "fixture-leftover")), true)
      } finally {
        try {
          await runner?.close()
          assert.equal(process.env.NODE_COMPILE_CACHE, compileCache)
          if (shared) {
            assert.equal(existsSync(compileCache), true)
            assert.equal(readdirSync(compileCache).length > 0, true)
          }
        } finally {
          process.exitCode = previousExitCode
          for (const [index, key] of ["NODE_COMPILE_CACHE", "TMPDIR", "TMP", "TEMP"].entries()) {
            if (before[index] === undefined) delete process.env[key]
            else process.env[key] = before[index]
          }
          rmSync(root, { recursive: true, force: true })
        }
      }
      assert.equal(existsSync(owned), false)
      assert.deepEqual([process.env.NODE_COMPILE_CACHE, process.env.TMPDIR, process.env.TMP, process.env.TEMP], before)
    })
  }
}
