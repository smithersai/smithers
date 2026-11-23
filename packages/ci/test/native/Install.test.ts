import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  commandFailed,
  commandStopped,
  inputsOf,
  install,
  installDirectories,
  installEach,
  installLabel,
  managerFor,
  managers,
  noSmthrs,
  PlannedInputs,
  readInstalls,
  smthrsBin
} from "../../src/native/index.vibe"
import { makePlace } from "../replay/place.ts"
import { brokenInstall, ownFiles } from "./own.ts"
import { temporary } from "./repo.ts"
import { cannotStart, noExists } from "./support.vibe"

const made: Array<string> = []
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

/** A directory holding `files`, as a checkout does before its install. */
const checkout = (files: Readonly<Record<string, string>>): string => {
  const root = temporary("checkout")
  made.push(root)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return root
}

/** The home and temporary directory an install runs with. */
const place = () => {
  const made_ = makePlace()
  made.push(join(made_.home, ".."))
  return made_
}

const onNode = <A, R>(work: Effect.Effect<A, never, R>) =>
  Effect.runPromise(Effect.provide(work, NodeServices.layer) as Effect.Effect<A>)

describe("the install rules", () => {
  it("picks the package manager from the lockfile", () => {
    expect(managerFor(["package.json", "pnpm-lock.yaml"])?.command).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline"
    ])
    expect(managerFor(["bun.lock"])?.command).toEqual(["bun", "install", "--frozen-lockfile"])
    expect(managerFor(["bun.lockb"])?.command).toEqual(["bun", "install", "--frozen-lockfile"])
    expect(managerFor(["package-lock.json"])?.command).toEqual(["npm", "ci", "--no-audit", "--no-fund"])
    expect(managerFor(["package.json", "yarn.lock"])).toBeUndefined()
    expect(managers.map((manager) => manager.command[0])).toEqual(["pnpm", "bun", "npm"])
  })

  it("installs where the workspace file is, then at the root", () => {
    expect(installDirectories("WORKSPACE.ts")).toEqual([""])
    expect(installDirectories(".smithers/WORKSPACE.ts")).toEqual([".smithers", ""])
  })

  it("also installs each directory whose lockfile a target reads, once, and none already installed", () => {
    const inputs = [
      "packages/runtime/bun.lock",
      "packages/runtime/package.json",
      "packages/runtime/bun.lock",
      "site/package-lock.json",
      "docs/tools/pnpm-lock.yaml",
      "old/bun.lockb",
      "bun.lock",
      ".smithers/bun.lock",
      "packages/yarn.lock",
      "notes/bun.lock.md",
      "../bun.lock",
      "/site/bun.lock",
      "C:/bun.lock",
      "site\\\\tool/bun.lock"
    ]
    expect(readInstalls(inputs, [".smithers", ""])).toEqual(["docs/tools", "old", "packages/runtime", "site"])
    expect(readInstalls(inputs, [])).toEqual(["", ".smithers", "docs/tools", "old", "packages/runtime", "site"])
    expect(readInstalls([], [""])).toEqual([])
  })

  it("reads the files each target of a printed plan names one by one, and none a glob matches", () => {
    const printed = JSON.stringify({
      verb: "ci",
      targets: [
        {
          label: "//packages:test",
          declaredInputs: [
            { declaration: { _tag: "File", path: "runtime/bun.lock" }, files: [{ path: "packages/runtime/bun.lock" }] },
            { declaration: { _tag: "File", path: "a.ts" }, files: [{ path: "packages/a.ts", digest: "x" }] },
            {
              declaration: { _tag: "Glob", pattern: "test/**" },
              files: [{ path: "packages/test/fixture/pnpm-lock.yaml" }, { path: "packages/test/b.ts" }]
            }
          ]
        },
        { label: "//packages:old" }
      ]
    })
    expect(inputsOf(Schema.decodeUnknownSync(Schema.fromJsonString(PlannedInputs))(printed))).toEqual([
      "packages/runtime/bun.lock",
      "packages/a.ts"
    ])
  })

  it("words a failed install without its output", () => {
    expect(commandStopped(["bun", "install"], "", "timed out")).toBe("bun install in the repository root: timed out")
    expect(commandFailed(["npm", "ci"], "", 1)).toBe("npm ci exited 1 in the repository root")
    expect(commandFailed(["bun", "install"], ".smithers", 127)).toBe("bun install exited 127 in .smithers")
    expect(noSmthrs([".smithers", ""])).toBe(
      "no node_modules/.bin/smthrs in .smithers or the repository root after the install; the repository must depend on @smthrs/cli"
    )
    expect(installLabel).toBe("(install)")
    expect(smthrsBin).toBe("node_modules/.bin/smthrs")
  })
})

describe("install", { timeout: 300_000 }, () => {
  it("runs the lockfile's package manager and finds the checkout's own smthrs", async () => {
    const root = checkout(ownFiles())
    expect(await onNode(install(root, "WORKSPACE.ts", place()))).toEqual({ ok: true, smthrs: join(root, smthrsBin) })
    expect(existsSync(join(root, "node_modules/@smthrs/targets/package.json"))).toBe(true)
  })

  it("installs under .smithers when the workspace file is there, and finds smthrs there first", async () => {
    const files = Object.fromEntries(
      Object.entries(ownFiles()).map((
        [name, content]
      ) => [name.startsWith(".git") ? name : `.smithers/${name}`, content])
    )
    const root = checkout(files)
    expect(await onNode(install(root, ".smithers/WORKSPACE.ts", place()))).toEqual({
      ok: true,
      smthrs: join(root, ".smithers", smthrsBin)
    })
  })

  it("checks the resolved install directory before reading its manifests", async () => {
    const root = checkout({})
    const other = checkout({})
    symlinkSync(other, join(root, "linked"))
    expect(await onNode(installEach(root, ["linked"], place()))).toBe("install directory outside checkout: linked")
    writeFileSync(join(root, "ordinary-file"), "fixture")
    expect(await onNode(installEach(root, ["ordinary-file"], place()))).toBeUndefined()
    const unresolved = Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* Effect.provideService(installEach(root, ["linked"], place()), FileSystem.FileSystem, {
        ...fs,
        realPath: (path) => fs.realPath(path === root ? join(root, "missing") : path)
      })
    })
    expect(await onNode(unresolved)).toBe("install directory outside checkout: linked")
  })

  it("reports the command that failed, and where", async () => {
    const root = checkout({ ...ownFiles(), "tools/install.mjs": brokenInstall })
    expect(await onNode(install(root, "WORKSPACE.ts", place()))).toEqual({
      ok: false,
      reason: "npm ci --no-audit --no-fund exited 1 in the repository root"
    })
  })

  it("reports a package manager that cannot be started", async () => {
    const root = checkout(ownFiles())
    expect(await onNode(Effect.provide(install(root, "WORKSPACE.ts", place()), cannotStart("npm")))).toEqual({
      ok: false,
      reason: "npm ci --no-audit --no-fund exited 127 in the repository root"
    })
  })

  it("installs nothing without a manifest and a lockfile it knows, and then finds no smthrs", async () => {
    const { "package-lock.json": _lockfile, ...unlocked } = ownFiles()
    for (const files of [unlocked, { "package-lock.json": "{}" }, { "README.md": "empty\n" }]) {
      const root = checkout(files)
      expect(await onNode(install(root, ".smithers/WORKSPACE.ts", place()))).toEqual({
        ok: false,
        reason: noSmthrs([".smithers", ""])
      })
      expect(existsSync(join(root, "node_modules"))).toBe(false)
    }
  })

  it("finds no smthrs when the file system cannot say it is there", async () => {
    const root = checkout(ownFiles())
    expect(await onNode(Effect.provide(install(root, "WORKSPACE.ts", place()), noExists))).toEqual({
      ok: false,
      reason: noSmthrs([""])
    })
  })
})
