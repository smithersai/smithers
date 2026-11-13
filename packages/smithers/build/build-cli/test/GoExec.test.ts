import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GoExec from "../src/GoExec.ts"
import { hungExecutable } from "./helpers/HungExecutable.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const context = async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-go-bounds-"))
  roots.push(root)
  return {
    root,
    packagePath: "",
    environment: { ...process.env, PATH: root + Path.delimiter + process.env["PATH"] },
    workspace: S.Workspace("bounds", {
      repository: "git+https://example.test/bounds.git",
      cache: S.Cache({ directory: ".flows" })
    })
  }
}

describe("Go planning subprocess bounds", () => {
  it.each(["go list", "nix"] as const)("aborts a running %s probe", async (kind) => {
    const host = await context()
    const child = await hungExecutable(host.root, kind === "nix" ? "nix" : "go")
    const controller = new AbortController()
    try {
      const pending = kind === "nix"
        ? GoExec.resolveNix("go", { ...host, signal: controller.signal })
        : GoExec.planRule("Go.Packages", { pkgs: ["./..."] }, { ...host, signal: controller.signal }, child.binary)
      const rejected = kind === "nix" ? undefined : expect(pending).rejects.toThrow(/abort/i)
      const pid = await Promise.race([
        child.started,
        pending.then(() => {
          throw new Error("probe ended before readiness")
        })
      ])
      controller.abort()
      if (kind === "nix") expect(await pending).toMatchObject({ ok: false, refusal: expect.stringMatching(/abort/i) })
      else await rejected
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      await expect.poll(child.alive, { timeout: 5_000 }).toBe(false)
    } finally {
      await child.close()
    }
  })

  it.each(process.platform === "win32" ? [true] : [false, true])(
    "times out go list and leaves no live process (native: %s)",
    async (native) => {
      const host = await context()
      const child = await hungExecutable(host.root, "go", native)
      try {
        const pending = GoExec.planRule("Go.Packages", { pkgs: ["./..."] }, {
          ...host,
          timeoutMs: 500
        }, child.binary)
        const rejected = expect(pending).rejects.toThrow(/timed out after 500ms/)
        const pid = await Promise.race([
          child.started,
          pending.then(() => {
            throw new Error("probe ended before readiness")
          })
        ])
        await rejected
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        await expect.poll(child.alive, { timeout: 5_000 }).toBe(false)
      } finally {
        await child.close()
      }
    }
  )
})
