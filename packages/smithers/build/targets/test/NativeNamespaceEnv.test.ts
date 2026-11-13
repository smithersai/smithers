import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { pathToFileURL } from "node:url"
import * as Vm from "node:vm"
import { expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"

it("refuses an uninitialized native module export while inspecting an exec environment", async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "native-env-namespace-")))
  const key = `native-env-namespace-${root}`
  const slot = Symbol.for(key)
  const callbacks = globalThis as unknown as Record<symbol, unknown>
  let called = false
  callbacks[slot] = async (namespace: object) => {
    called = true
    expect(() => Object.getOwnPropertyDescriptor(namespace, "code")).toThrow(ReferenceError)
    expect(SafeFs.errorCode(namespace)).toBeUndefined()
    const failure = await Effect.runPromise(Effect.flip(Exec.run({ workspaceRoot: root }, {
      cwd: ".",
      argv: [process.execPath, "-e", "process.stdout.write('unexpected')"],
      env: namespace as Record<string, string>,
      secrets: [],
      expectedExitCodes: [0],
      timeoutMs: 5000
    })))
    expect(failure).toMatchObject({
      code: "invalid_payload",
      exitCode: -1,
      stdout: "",
      stderr: "exec environment.code could not be inspected safely"
    })
  }
  try {
    await Fs.writeFile(Path.join(root, "entry.mjs"), "import \"./probe.mjs\";\nexport const code = \"initialized\";\n")
    await Fs.writeFile(
      Path.join(root, "probe.mjs"),
      `import * as namespace from "./entry.mjs";\nawait globalThis[Symbol.for(${JSON.stringify(key)})](namespace);\n`
    )
    // Node's main loader preserves native TDZ semantics; the Vitest transform
    // loader intentionally does not model this module-namespace boundary.
    const nativeImport = Vm.compileFunction("return import(url)", ["url"], {
      importModuleDynamically: Vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    })
    await nativeImport(pathToFileURL(Path.join(root, "entry.mjs")).href)
    expect(called).toBe(true)
  } finally {
    delete callbacks[slot]
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("refuses a revoked audiences array without throwing through the credential guard", () => {
  const audiences = Proxy.revocable(["https://example.test"], {})
  audiences.revoke()
  expect(() => Array.isArray(audiences.proxy)).toThrow(TypeError)
  expect(Secret.isHttpCredential({
    _tag: "HttpCredential",
    secret: Secret.Secret("REVOKED_AUDIENCES"),
    audiences: audiences.proxy
  })).toBe(false)
})
