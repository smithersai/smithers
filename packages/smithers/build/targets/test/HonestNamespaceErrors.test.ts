import * as Effect from "effect/Effect"
import { randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Generated from "../src/GeneratedFile.ts"
import * as Manifest from "../src/ManifestJson.ts"
import * as Package from "../src/Package.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"
import * as Workspace from "../src/WorkspaceDeclaration.ts"

it("contains reflection failures from a real partially initialized module namespace", async () => {
  const root = await Fs.mkdtemp(join(tmpdir(), "honest-module-namespace-"))
  const key = "__honest_namespace_" + randomUUID().replaceAll("-", "_")
  const hooks = process as unknown as Record<string, unknown>
  let probed = false
  hooks[key] = async (namespace: object) => {
    probed = true
    // The callbacks below are Vite-loaded references. Only the tiny namespace
    // fixture is loaded natively, so these are real, correctly attributed hits.
    expect(() => Object.getOwnPropertyDescriptor(namespace, "message")).toThrow(ReferenceError)
    const execError = await Effect.runPromise(Effect.flip(Exec.run({ workspaceRoot: root }, namespace as never)))
    expect(execError.code).toBe("invalid_payload")
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(Package.isPackage(revoked.proxy)).toBe(false)
    expect(Workspace.isWorkspaceDeclaration(revoked.proxy)).toBe(false)
    expect(Package.isPackage(namespace)).toBe(false)
    expect(Workspace.isWorkspaceDeclaration(namespace)).toBe(false)
    expect(Secret.isHttpCredential(namespace)).toBe(false)
    expect(Generated.failureMessage(namespace)).toBe("unknown failure")
    expect(SafeFs.errorCode(namespace)).toBeUndefined()
    expect(Target.isTarget(Object.defineProperty({}, Target.TargetTypeId, { value: namespace }))).toBe(false)
    expect(() => Manifest.cloneObject(namespace, "partial module")).toThrow()
    const path = join(root, "value")
    await Fs.writeFile(path, "complete")
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (candidate) => {
        const file = await SafeFs.defaultIo.open(candidate)
        return {
          ...file,
          close: async () => {
            await file.close()
            throw namespace
          }
        }
      }
    }
    await expect(SafeFs.readText(path, { io })).rejects.toThrow(/could not be closed.*unknown failure/)
  }
  try {
    const file = join(root, "partial.mjs")
    await Fs.writeFile(
      file,
      `import process from "node:process";
import * as self from "./partial.mjs";
await process[${JSON.stringify(key)}](self);
export const message = "initialized";
export const code = "EIO";
export const target = "initialized";
export const argv = [];
export const cwd = ".";
export const _tag = "HttpCredential";
export const secret = null;
export const audiences = [];
export const outputs = [];
export const [noop] = [null];
`
    )
    const require = createRequire(new URL("../../build-cli/package.json", import.meta.url))
    const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href)
    await tsImport(file, import.meta.url)
    expect(probed).toBe(true)
  } finally {
    delete hooks[key]
    await Fs.rm(root, { recursive: true, force: true })
  }
})
