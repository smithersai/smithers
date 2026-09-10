import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"

import { runTemplateReplay } from "./release-consumers.mjs"

const repoRoot = resolve(import.meta.dirname, "..")

test("the template smoke scaffolds then executes its generated replay, and propagates replay failure", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-template-replay-")))
  try {
    const templateRoot = join(root, "source-template")
    const template = join(templateRoot, "default")
    const consumer = join(root, "consumer")
    mkdirSync(join(template, "flows/chat"), { recursive: true })
    mkdirSync(join(consumer, "node_modules/.bin"), { recursive: true })
    const dependencies = { vitest: "4.1.9", "@smthrs/create-app": "1.0.0" }
    writeFileSync(join(template, "package.json"), JSON.stringify({ name: "__APP_NAME__", private: true,
      type: "module", devDependencies: dependencies }))
    const config = readFileSync(join(repoRoot, "packages/smithers/create-app/template/default/vitest.config.ts"), "utf8")
    writeFileSync(join(template, "vitest.config.ts"), config)
    writeFileSync(join(template, ".gitignore"), "node_modules/\n")
    writeFileSync(join(template, "flows/chat/shared.ts"), 'export const cards = []; export const emit = () => cards.push("pane")')
    const replay = join(template, "flows/chat/flow.e2e.ts")
    writeFileSync(replay, [
      'import { test, expect } from "vitest"',
      'import { writeFileSync } from "node:fs"',
      'import { load } from "@smthrs/create-app/loader"',
      'import { cards } from "./shared.ts"',
      'test("generated recorded replay", async () => {',
      '  expect(process.env.SMTHRS_RECORD).toBe("0")',
      '  const routed = await load(new URL("./shared.ts", import.meta.url).href)',
      '  routed.emit()',
      '  expect(cards, "the routed loader and test need the same module instance").toEqual(["pane"])',
      '  writeFileSync("replay.ok", process.cwd())',
      '})'
    ].join("\n"))
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }))
    const installedLoader = join(consumer, "node_modules/@smthrs/create-app")
    mkdirSync(installedLoader, { recursive: true })
    writeFileSync(join(installedLoader, "package.json"), JSON.stringify({ name: "@smthrs/create-app", version: "1.0.0",
      type: "module", exports: { "./loader": "./loader.mjs", "./package.json": "./package.json" } }))
    writeFileSync(join(installedLoader, "loader.mjs"), 'export const load = (file) => import(file)')
    const scaffold = import.meta.resolve("@smthrs/build-cli/CreateApp")
    const binary = join(consumer, "node_modules/.bin/smithers-build")
    writeFileSync(binary, [
      "#!/usr/bin/env node",
      `import { scaffold } from ${JSON.stringify(scaffold)}`,
      'import { writeFileSync } from "node:fs"',
      'if (process.argv[2] === "lint" && process.argv[3] === "//:routes") writeFileSync("routes.ok", process.cwd())',
      'else if (process.argv[2] === "create-app") {',
      `  await scaffold({ directory: process.argv[3], templateRoot: ${JSON.stringify(templateRoot)} })`,
      '} else throw new Error("unexpected CLI command")'
    ].join("\n"))
    chmodSync(binary, 0o755)
    // Use the real installed Vitest without a network installation. This
    // focused runner regression is separate from the packed consumer matrix.
    const require = createRequire(join(repoRoot, "packages/smithers/build/targets/package.json"))
    const vitest = dirname(require.resolve("vitest/package.json"))
    symlinkSync(vitest, join(consumer, "node_modules/vitest"), "dir")
    symlinkSync(join(vitest, "vitest.mjs"), join(consumer, "node_modules/.bin/vitest"))
    const profile = { name: "template-default", dependencies }
    const app = await runTemplateReplay(consumer, profile)
    assert.equal(readFileSync(join(app, "routes.ok"), "utf8"), app, "the graph command must run from the generated app")
    assert.equal(readFileSync(join(app, "replay.ok"), "utf8"), app, "the replay must run from the generated app")
    rmSync(app, { recursive: true })
    writeFileSync(join(template, "vitest.config.ts"), config.replace('inline: ["@smthrs/create-app"]', 'external: ["@smthrs/create-app"]'))
    await assert.rejects(runTemplateReplay(consumer, profile), /the routed loader and test need the same module instance/)
    rmSync(app, { recursive: true })
    writeFileSync(join(template, "vitest.config.ts"), config)
    writeFileSync(replay, 'import { test } from "vitest"; test("broken generated replay", () => { throw new Error("replay regression") })')
    await assert.rejects(runTemplateReplay(consumer, profile), /replay regression/)
    rmSync(app, { recursive: true })
    await assert.rejects(runTemplateReplay(consumer, { ...profile, dependencies: { vitest: "0.0.0" } }),
      /generated app dependencies differ/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
