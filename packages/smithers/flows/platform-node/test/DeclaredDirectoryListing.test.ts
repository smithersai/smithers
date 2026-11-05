import { spawnSync } from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const fixture = <A>(body: (root: string, tmp: string) => A): A => {
  const base = Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-declared-listing-")))
  const root = Path.join(base, "workspace")
  const tmp = Path.join(base, "tmp")
  for (const directory of ["src/nested", "src/private", "unrelated/cwd", "out"]) {
    Fs.mkdirSync(Path.join(root, directory), { recursive: true })
  }
  Fs.mkdirSync(tmp)
  Fs.writeFileSync(Path.join(root, "src/nested/input.txt"), "declared")
  Fs.writeFileSync(Path.join(root, "src/nested/sibling.txt"), "private sibling")
  Fs.writeFileSync(Path.join(root, "src/private/secret.txt"), "private subtree")
  try {
    return body(root, tmp)
  } finally {
    Fs.rmSync(base, { recursive: true, force: true })
  }
}

const declaration = (strict: boolean): ProcessSandbox.Request => ({
  network: "none",
  strict,
  reads: ["src/nested/input.txt"],
  writes: ["out"]
})

// Rendering is a pure contract: use real filesystem facts, even when this
// host cannot execute a Seatbelt profile. Native enforcement is checked below.
const profile = (root: string, tmp: string, reads: ReadonlyArray<string>, strict = true): string =>
  ProcessSandbox.seatbelt({
    mechanism: { _tag: "seatbelt", executable: "/usr/bin/sandbox-exec" },
    network: "none",
    strict,
    workspaceRoot: root,
    cwd: Path.join(root, "unrelated/cwd"),
    reads: reads.map((read) => Path.join(root, read)),
    readDenies: [],
    writes: [],
    readOnly: [],
    externalReads: [],
    tmp,
    uid: undefined,
    gid: undefined
  })

const literal = (path: string): string => `(literal ${JSON.stringify(path)})`

describe("declared directory listing (#4219)", () => {
  it("grants directory data only on the ancestors of declared files", () =>
    fixture((root, tmp) => {
      const policy = profile(root, tmp, ["src/nested/input.txt"])
      const listing = policy.match(/\(allow file-read-data(?: \(literal "(?:[^"\\]|\\.)*"\))+\)/g)
      expect(listing).toHaveLength(1)
      for (const directory of [root, Path.join(root, "src"), Path.join(root, "src/nested")]) {
        expect(listing![0]).toContain(literal(directory))
      }
      for (
        const path of ["src/nested/input.txt", "src/nested/sibling.txt", "src/private", "unrelated", "unrelated/cwd"]
      ) {
        expect(listing![0]).not.toContain(literal(Path.join(root, path)))
      }
      expect(listing![0]).not.toContain("subpath")
      expect(policy).not.toContain(`(subpath ${JSON.stringify(Path.join(root, "src"))})`)
    }))

  it("does not add listing access when there are no declared reads", () =>
    fixture((root, tmp) => {
      expect(profile(root, tmp, [])).not.toContain("(allow file-read-data ")
    }))

  it("keeps the listing grant literal when the workspace itself is declared", () =>
    fixture((root, tmp) => {
      const policy = profile(root, tmp, ["."])
      expect(policy.match(/\(allow file-read-data[^\n]*?\)\)/g)).toEqual([
        `(allow file-read-data ${literal(root)})`
      ])
    }))

  it.each([false, true])(
    "executes declared traversal and denies sibling contents and writes (strict=%s)",
    (strict) =>
      fixture((root, tmp) => {
        const facts = ProcessSandbox.host()
        const plan = ProcessSandbox.plan(declaration(strict), { workspaceRoot: root, cwd: root, tmp }, facts)
        if (process.platform === "win32") {
          // Windows requires an explicitly provisioned backend; the dedicated
          // workflow verifies confinement inside WSL2, never an unconfined fallback.
          expect(plan).toMatchObject({ _tag: "@smthrs/platform-node/SandboxUnenforceable", missing: "docker image" })
          return
        }
        if (ProcessSandbox.isUnenforceable(plan)) throw new Error(plan.message)
        const script = `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        assert.ok(fs.readdirSync('src').includes('nested'));
        assert.ok(fs.readdirSync('src/nested').includes('input.txt'));
        assert.equal(fs.readFileSync('src/nested/input.txt', 'utf8'), 'declared');
        const denied = (op) => assert.throws(op, e => ['EPERM', 'EACCES', 'ENOENT', 'EROFS'].includes(e.code));
        denied(() => fs.readFileSync('src/nested/sibling.txt'));
        denied(() => fs.readFileSync('src/private/secret.txt'));
        denied(() => fs.readdirSync('src/private'));
        denied(() => fs.writeFileSync('src/nested/input.txt', 'changed'));
        denied(() => fs.writeFileSync('src/nested/new.txt', 'escaped'));
        fs.writeFileSync('out/result.txt', 'confined traversal passed');
      `
        const wrapped = ProcessSandbox.wrap(plan, [process.execPath, "-e", script], {}, facts)
        const child = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
          cwd: root,
          env: { ...process.env, ...wrapped.env },
          encoding: "utf8"
        })
        expect(child.error).toBeUndefined()
        expect(child.status, child.stderr).toBe(0)
        expect(Fs.readFileSync(Path.join(root, "out/result.txt"), "utf8")).toBe("confined traversal passed")
        expect(Fs.readFileSync(Path.join(root, "src/nested/input.txt"), "utf8")).toBe("declared")
        expect(Fs.readFileSync(Path.join(root, "src/nested/sibling.txt"), "utf8")).toBe("private sibling")
        expect(Fs.existsSync(Path.join(root, "src/nested/new.txt"))).toBe(false)
      })
  )
})
